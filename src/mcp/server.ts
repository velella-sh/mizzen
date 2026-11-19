/**
 * The MCP server core: newline-delimited JSON-RPC 2.0 over a pair of streams (stdio in production).
 * `initialize`, `ping`, `tools/list`, `tools/call`, `resources/list`, `resources/read`, and
 * `resources/templates/list` are answered. stdout carries protocol messages only; the logger is for stderr.
 *
 * Every call belongs to a session pinned to one site snapshot, has its own stage deadline, can be cancelled at a safe
 * boundary, and answers with the same bounded, redacted failure shape. Long-running work is started through the
 * runtime, which keeps its state across a stdio reconnect.
 */
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { DEFAULT_LIMITS, MAX_PACK_TOKENS, McpError, capAnswer, scrub, timeoutFor, type Limits } from "./limits.ts";
import type { Registry } from "./registry.ts";
import { listResources, readResource } from "./resources.ts";
import { failureOf, normalizeFailure, publicMessage, publicValue, type McpFailure, type Stage } from "./runtime/errors.ts";
import { Runtime, type Session } from "./runtime/operations.ts";
import type { SiteState } from "./site.ts";
import type { Tool } from "./tool.ts";

export const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

/** The version of the extra contract this server announces beside the MCP protocol version. */
export const CONTRACT_VERSION = 1;

export interface ServerInfo {
  readonly name: string;
  readonly version: string;
}

export interface ServerOptions {
  readonly site: SiteState;
  readonly registry: Registry;
  readonly info: ServerInfo;
  readonly limits?: Partial<Limits>;
  readonly log?: (message: string) => void;
}

type Id = string | number | null;
interface Request {
  readonly jsonrpc?: string;
  readonly id?: Id;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}
type Response = { jsonrpc: "2.0"; id: Id } & ({ result: unknown } | { error: { code: number; message: string; data?: McpFailure } });

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

export interface Server {
  /** Handles one decoded message; resolves to the response, or `undefined` for a notification. */
  handle(message: unknown): Promise<Response | undefined>;
  /** Reads messages from `input` until it ends, writing responses to `output`; resolves when all are answered. */
  serve(input: Readable, output: Writable): Promise<void>;
  /** Stops background work and releases this server's session files; safe to call twice. */
  close(): Promise<void>;
}

export function createServer(options: ServerOptions): Server {
  const limits: Limits = {
    ...DEFAULT_LIMITS,
    ...options.limits,
    // A caller that only lowers `callTimeoutMs` lowers the read deadline, never the verify deadline.
    readTimeoutMs: options.limits?.readTimeoutMs ?? options.limits?.callTimeoutMs ?? DEFAULT_LIMITS.readTimeoutMs,
  };
  const log = options.log ?? (() => {});
  const runtime = new Runtime(options.site, limits, () => options.site.privateFolders);
  let notifier: ((message: Record<string, unknown>) => void) | undefined;
  let client: { name: string; version: string } | undefined;
  let protocolVersion: string = SUPPORTED_VERSIONS[0];
  let inFlight = 0;
  const controllers = new Map<string, AbortController>();

  const fail = (id: Id, code: number, message: string, stage: Stage = "protocol"): Response => {
    const failure = failureOf(codeName(code), message, { stage, folders: options.site.privateFolders });
    return { jsonrpc: "2.0", id, error: { code, message: failure.message, data: failure } };
  };

  function codeName(code: number): string {
    if (code === PARSE_ERROR) return "parse-error";
    if (code === METHOD_NOT_FOUND) return "method-not-found";
    if (code === INVALID_PARAMS) return "invalid-params";
    if (code === INVALID_REQUEST) return "invalid-request";
    return "internal";
  }

  async function sessionOf(params: Record<string, unknown>, pin: boolean, version: string): Promise<{ session: Session; previous: string }> {
    const meta = typeof params._meta === "object" && params._meta !== null ? (params._meta as Record<string, unknown>) : undefined;
    const token =
      (typeof meta?.session === "string" && meta.session !== "" ? meta.session : undefined) ??
      (typeof params.session === "string" && params.session !== "" ? params.session : undefined) ??
      `stdio:${client?.name ?? ""}@${client?.version ?? ""}:${options.site.root}`;
    const session = await runtime.openSession(token, options.site.snapshot, version, false);
    const previous = session.snapshot;
    if (pin && session.snapshot !== options.site.snapshot) await session.pin(options.site.snapshot);
    return { session, previous };
  }

  function capabilities(session: Session) {
    return {
      tools: { listChanged: false },
      resources: { listChanged: false, subscribe: false },
      experimental: {
        mizzen: {
          contractVersion: CONTRACT_VERSION,
          session: session.id,
          snapshot: session.snapshot,
          tasks: {
            operations: ["pack", "verify", "replay"],
            async: true,
            progress: true,
            cancellation: true,
            recovery: true,
            idempotency: true,
            pagination: true,
            sessions: true,
          },
          limits: {
            maxAnswerBytes: limits.maxAnswerBytes,
            maxPackTokens: MAX_PACK_TOKENS,
            maxInFlight: limits.maxInFlight,
            maxOperations: limits.maxOperations,
            maxEventsPerOperation: limits.maxEventsPerOperation,
            callTimeoutMs: limits.callTimeoutMs,
            readTimeoutMs: limits.readTimeoutMs,
            contextTimeoutMs: limits.contextTimeoutMs,
            editTimeoutMs: limits.editTimeoutMs,
            verifyTimeoutMs: limits.verifyTimeoutMs,
          },
        },
      },
    };
  }

  function errorResult(
    message: string,
    code: string,
    options: {
      readonly stage?: Stage;
      readonly retryable?: boolean;
      readonly task?: string;
      readonly source?: string;
      readonly snapshot?: string;
      readonly extra?: Record<string, unknown>;
    } = {},
  ): unknown {
    const text = scrub(message, siteFolders());
    const failure = failureOf(code, text, {
      stage: options.stage ?? "read",
      ...(options.retryable === undefined ? {} : { retryable: options.retryable }),
      ...(options.task === undefined ? {} : { task: options.task }),
      ...(options.source === undefined ? {} : { source: options.source }),
      folders: siteFolders(),
      ...(options.extra === undefined ? {} : { extra: options.extra }),
    });
    return {
      content: [{ type: "text", text }],
      isError: true,
      structuredContent: failure,
      ...(options.snapshot === undefined ? {} : { _meta: { snapshot: options.snapshot } }),
    };
  }

  function siteFolders(): readonly string[] {
    return options.site.privateFolders;
  }

  async function callTool(params: Record<string, unknown>, signal: AbortSignal, controller: AbortController): Promise<unknown> {
    const name = params.name;
    if (typeof name !== "string") throw new McpError("invalid-params", "tools/call needs a tool name.", { stage: "protocol" });
    const tool = options.registry.get(name);
    if (tool === undefined) return errorResult(`Unknown tool: ${name}`, "unknown-tool", { stage: toolStage(tool) });
    const input = params.arguments ?? {};
    const problems = options.registry.validate(name, input);
    if (problems.length > 0) return errorResult(`Invalid input for ${name}: ${problems.join("; ")}`, "invalid-input", { stage: toolStage(tool) });
    if (inFlight >= limits.maxInFlight) {
      return errorResult(`Too many calls are running (limit ${limits.maxInFlight}); try again.`, "busy", { retryable: true, stage: toolStage(tool) });
    }
    inFlight += 1;

    try {
      return await runTool(tool, name, input, params, signal, controller);
    } finally {
      inFlight -= 1;
    }
  }

  async function runTool(
    tool: Tool,
    name: string,
    input: unknown,
    params: Record<string, unknown>,
    signal: AbortSignal,
    controller: AbortController,
  ): Promise<unknown> {
    const { session } = await sessionOf(params, false, protocolVersion);
    const stage = toolStage(tool);
    if (tool.snapshotFree !== true) {
      await options.site.refresh();
      if (session.snapshot !== options.site.snapshot) {
        return errorResult(
          `The site changed since this session pinned snapshot ${session.snapshot}; resume on snapshot ${options.site.snapshot} and repeat the call.`,
          "snapshot-changed",
          {
            stage,
            retryable: true,
            snapshot: options.site.snapshot,
            extra: { snapshot: options.site.snapshot, previousSnapshot: session.snapshot },
          },
        );
      }
    }

    const timeoutMs = timeoutFor(limits, tool.stage, tool.timeoutMs);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    timer.unref();
    const meta = typeof params._meta === "object" && params._meta !== null ? (params._meta as Record<string, unknown>) : undefined;
    const progressToken = typeof meta?.progressToken === "string" || typeof meta?.progressToken === "number" ? meta.progressToken : undefined;
    const run = tool.handler(input as Record<string, unknown>, {
      site: options.site,
      signal,
      runtime,
      session,
      ...(progressToken === undefined ? {} : { progressToken }),
    });
    run.catch(() => undefined); // a handler that outlives a cancel or timeout must not become an unhandled rejection
    let cancelled: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      cancelled = () => reject(new McpError("cancelled", "The call was cancelled at a safe boundary.", { stage, retryable: true }));
      if (signal.aborted) cancelled();
      else signal.addEventListener("abort", cancelled, { once: true });
    });
    try {
      const result = await Promise.race([run, aborted]);
      if (!result.isError && tool.stage === "edit" && session.snapshot !== options.site.snapshot) session.adopt(options.site.snapshot);
      return answer(result, session, stage);
    } catch (error) {
      if (timedOut) {
        return errorResult(`${name} took longer than ${timeoutMs} ms and was stopped.`, "timeout", {
          stage,
          retryable: true,
          snapshot: session.snapshot,
        });
      }
      if (signal.aborted || (error instanceof McpError && error.code === "cancelled")) {
        return errorResult("The call was cancelled at a safe boundary; no result was kept.", "cancelled", {
          stage,
          retryable: true,
          snapshot: session.snapshot,
        });
      }
      if (error instanceof McpError) {
        return failureResult(error, stage, session.snapshot);
      }
      log(`tool ${name} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      return errorResult(`${name} failed: ${error instanceof Error ? error.message : String(error)}`, "internal", {
        stage,
        snapshot: session.snapshot,
      });
    } finally {
      clearTimeout(timer);
      if (cancelled !== undefined) signal.removeEventListener("abort", cancelled);
    }
  }

  function answer(
    result: { readonly text: string; readonly data?: Record<string, unknown>; readonly isError?: boolean },
    session: Session,
    stage: Stage,
  ): unknown {
    const folders = siteFolders();
    const capped = capAnswer(scrub(result.text, folders), limits.maxAnswerBytes);
    const data = result.data === undefined ? undefined : (publicValue(result.data, folders) as Record<string, unknown>);
    const failure = result.isError === true ? normalizeFailure(data, capped.text, { stage, folders }) : undefined;
    const structured = failure ?? data;
    return {
      content: [{ type: "text", text: capped.text }],
      ...(structured === undefined || capped.truncated || !session.modern ? {} : { structuredContent: structured }),
      ...(result.isError === true ? { isError: true } : {}),
      _meta: {
        snapshot: session.snapshot,
        ...(capped.truncated ? { truncated: true, limit: limits.maxAnswerBytes } : {}),
      },
    };
  }

  function failureResult(error: McpError, stage: Stage, snapshot: string): unknown {
    const failure = failureOf(error.code, error.message, {
      stage: error.details.stage ?? stage,
      ...(error.details.retryable === undefined ? {} : { retryable: error.details.retryable }),
      ...(error.details.task === undefined ? {} : { task: error.details.task }),
      ...(error.details.source === undefined ? {} : { source: error.details.source }),
      folders: siteFolders(),
      ...(error.details.data === undefined ? {} : { extra: error.details.data }),
    });
    return {
      content: [{ type: "text", text: failure.message }],
      isError: true,
      structuredContent: failure,
      _meta: { snapshot },
    };
  }

  function toolStage(tool: Tool | undefined): Stage {
    return tool?.stage ?? "read";
  }

  async function dispatch(method: string, params: Record<string, unknown>, signal: AbortSignal, controller: AbortController): Promise<unknown> {
    switch (method) {
      case "initialize": {
        const asked = params.protocolVersion;
        const version = (SUPPORTED_VERSIONS as readonly unknown[]).includes(asked) ? (asked as string) : SUPPORTED_VERSIONS[0];
        protocolVersion = version;
        if (typeof params.clientInfo === "object" && params.clientInfo !== null) {
          const info = params.clientInfo as Record<string, unknown>;
          client = {
            name: typeof info.name === "string" ? info.name : "",
            version: typeof info.version === "string" ? info.version : "",
          };
        }
        await options.site.refresh();
        const { session, previous } = await sessionOf(params, true, version);
        session.modern = version >= "2025-06-18";
        return {
          protocolVersion: version,
          capabilities: capabilities(session),
          serverInfo: options.info,
          ...(previous === session.snapshot ? {} : { snapshotChanged: true, previousSnapshot: previous }),
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return {
          tools: options.registry.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
        };
      case "tools/call":
        return callTool(params, signal, controller);
      case "resources/list": {
        await options.site.refresh();
        return listResources(options.site, typeof params.cursor === "string" ? params.cursor : undefined);
      }
      case "resources/templates/list":
        return { resourceTemplates: [] };
      case "resources/read": {
        if (typeof params.uri !== "string") throw new McpError("invalid-params", "resources/read needs a uri.", { stage: "read" });
        await options.site.refresh();
        return { contents: [await readResource(options.site, params.uri)] };
      }
      default:
        throw new McpError("method-not-found", `Method not found: ${method}`, { stage: "protocol" });
    }
  }

  async function handle(message: unknown): Promise<Response | undefined> {
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      return fail(null, INVALID_REQUEST, "A message must be a JSON object.");
    }
    const request = message as Request;
    const isNotification = request.id === undefined;
    const id: Id = request.id ?? null;
    if (request.method === "notifications/cancelled") {
      const cancelledId = request.params?.requestId;
      if (typeof cancelledId === "string" || typeof cancelledId === "number") controllers.get(String(cancelledId))?.abort();
      return undefined;
    }
    if (typeof request.method !== "string") {
      // A response from the client (to a request we never send) is ignored.
      return isNotification || "result" in request || "error" in request ? undefined : fail(id, INVALID_REQUEST, "A request needs a method.");
    }
    if (isNotification) return undefined;
    const controller = new AbortController();
    const key = String(id);
    controllers.set(key, controller);
    try {
      return { jsonrpc: "2.0", id, result: await dispatch(request.method, request.params ?? {}, controller.signal, controller) };
    } catch (err) {
      if (err instanceof McpError) {
        const code = err.code === "method-not-found" ? METHOD_NOT_FOUND : err.code === "invalid-params" ? INVALID_PARAMS : INVALID_PARAMS;
        const failure = failureOf(err.code, err.message, {
          stage: err.details.stage ?? "protocol",
          ...(err.details.retryable === undefined ? {} : { retryable: err.details.retryable }),
          ...(err.details.task === undefined ? {} : { task: err.details.task }),
          ...(err.details.source === undefined ? {} : { source: err.details.source }),
          folders: siteFolders(),
          ...(err.details.data === undefined ? {} : { extra: err.details.data }),
        });
        return { jsonrpc: "2.0", id, error: { code, message: failure.message, data: failure } };
      }
      log(`${request.method} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      return fail(id, -32603, `Internal error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      controllers.delete(key);
      controller.abort();
    }
  }

  async function serve(input: Readable, output: Writable): Promise<void> {
    const pending = new Set<Promise<void>>();
    const send = (message: unknown): void => {
      output.write(`${JSON.stringify(message)}\n`);
    };
    notifier = (message) => send(message);
    runtime.notify = notifier;
    const lines = createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      if (line.trim() === "") continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        send(fail(null, PARSE_ERROR, "The message is not valid JSON."));
        continue;
      }
      const task = handle(message).then((response) => {
        if (response !== undefined) send(response);
      });
      pending.add(task);
      void task.finally(() => pending.delete(task));
    }
    await Promise.all(pending);
    await runtime.close();
    notifier = undefined;
    runtime.notify = undefined;
  }

  return {
    handle,
    serve,
    close: () => runtime.close(),
  };
}
