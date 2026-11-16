/**
 * The MCP server core: newline-delimited JSON-RPC 2.0 over a pair of streams (stdio in production).
 * `initialize`, `ping`, `tools/list`, `tools/call`, `resources/list`, `resources/read`, and
 * `resources/templates/list` are answered. stdout carries protocol messages only; the logger is for stderr.
 */
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { DEFAULT_LIMITS, McpError, capAnswer, scrub, type Limits } from "./limits.ts";
import type { Registry } from "./registry.ts";
import { listResources, readResource } from "./resources.ts";
import type { SiteState } from "./site.ts";

export const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

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
type Response = { jsonrpc: "2.0"; id: Id } & ({ result: unknown } | { error: { code: number; message: string } });

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

export interface Server {
  /** Handles one decoded message; resolves to the response, or `undefined` for a notification. */
  handle(message: unknown): Promise<Response | undefined>;
  /** Reads messages from `input` until it ends, writing responses to `output`; resolves when all are answered. */
  serve(input: Readable, output: Writable): Promise<void>;
}

export function createServer(options: ServerOptions): Server {
  const limits: Limits = { ...DEFAULT_LIMITS, ...options.limits };
  const log = options.log ?? (() => {});
  let inFlight = 0;

  const fail = (id: Id, code: number, message: string): Response => ({ jsonrpc: "2.0", id, error: { code, message: scrub(message, options.site.privateFolders) } });

  async function callTool(params: Record<string, unknown>): Promise<unknown> {
    const name = params.name;
    if (typeof name !== "string") throw new McpError("invalid-params", "tools/call needs a tool name.");
    const tool = options.registry.get(name);
    if (tool === undefined) throw new McpError("unknown-tool", `Unknown tool: ${name}`);
    const input = params.arguments ?? {};
    const problems = options.registry.validate(name, input);
    if (problems.length > 0) return errorResult(`Invalid input for ${name}: ${problems.join("; ")}`);
    if (inFlight >= limits.maxInFlight) return errorResult(`Too many calls are running (limit ${limits.maxInFlight}); try again.`);

    inFlight += 1;
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const callTimeoutMs = Math.max(limits.callTimeoutMs, tool.timeoutMs ?? 0);
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new McpError("timeout", `${name} took longer than ${callTimeoutMs} ms and was stopped.`));
        }, callTimeoutMs);
      });
      const run = (async () => {
        await options.site.refresh();
        return tool.handler(input as Record<string, unknown>, { site: options.site, signal: controller.signal });
      })();
      run.catch(() => undefined); // a handler that outlives its timeout must not become an unhandled rejection
      const result = await Promise.race([run, timeout]);
      const capped = capAnswer(scrub(result.text, options.site.privateFolders), limits.maxAnswerBytes);
      return {
        content: [{ type: "text", text: capped.text }],
        ...(result.data !== undefined && !capped.truncated ? { structuredContent: result.data } : {}),
        ...(result.isError === true ? { isError: true } : {}),
      };
    } catch (err) {
      if (err instanceof McpError) return errorResult(`${err.message}`, err.code);
      log(`tool ${name} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      return errorResult(`${name} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
      inFlight -= 1;
    }
  }

  function errorResult(message: string, code?: string): unknown {
    const text = scrub(message, options.site.privateFolders);
    return { content: [{ type: "text", text }], isError: true, ...(code === undefined ? {} : { structuredContent: { ok: false, code, message: text } }) };
  }

  async function dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "initialize": {
        const asked = params.protocolVersion;
        const version = (SUPPORTED_VERSIONS as readonly unknown[]).includes(asked) ? (asked as string) : SUPPORTED_VERSIONS[0];
        return {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false }, resources: { listChanged: false, subscribe: false } },
          serverInfo: options.info,
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return {
          tools: options.registry.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
        };
      case "tools/call":
        return callTool(params);
      case "resources/list": {
        await options.site.refresh();
        return listResources(options.site, typeof params.cursor === "string" ? params.cursor : undefined);
      }
      case "resources/templates/list":
        return { resourceTemplates: [] };
      case "resources/read": {
        if (typeof params.uri !== "string") throw new McpError("invalid-params", "resources/read needs a uri.");
        await options.site.refresh();
        return { contents: [await readResource(options.site, params.uri)] };
      }
      default:
        throw new McpError("method-not-found", `Method not found: ${method}`);
    }
  }

  async function handle(message: unknown): Promise<Response | undefined> {
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      return fail(null, INVALID_REQUEST, "A message must be a JSON object.");
    }
    const request = message as Request;
    const isNotification = request.id === undefined;
    const id: Id = request.id ?? null;
    if (typeof request.method !== "string") {
      // A response from the client (to a request we never send) is ignored.
      return isNotification || "result" in request || "error" in request ? undefined : fail(id, INVALID_REQUEST, "A request needs a method.");
    }
    if (isNotification) return undefined;
    try {
      return { jsonrpc: "2.0", id, result: await dispatch(request.method, request.params ?? {}) };
    } catch (err) {
      if (err instanceof McpError) {
        const code = err.code === "method-not-found" ? METHOD_NOT_FOUND : INVALID_PARAMS;
        return fail(id, code, err.message);
      }
      log(`${request.method} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      return fail(id, -32603, `Internal error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function serve(input: Readable, output: Writable): Promise<void> {
    const pending = new Set<Promise<void>>();
    const send = (response: Response): void => {
      output.write(`${JSON.stringify(response)}\n`);
    };
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
  }

  return { handle, serve };
}
