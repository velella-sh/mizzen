/**
 * The one failure shape every MCP answer carries: a stable machine code, the stage it failed in, whether the caller
 * may retry, the operation that failed, and an authorized site-relative source. Stack traces and this machine's
 * folders never reach a caller.
 */
import { scrub } from "../limits.ts";

/** The stage a call or operation belongs to. Each has its own timeout. */
export type Stage = "read" | "context" | "edit" | "verify" | "operation" | "protocol";

/** What a refused tool or operation returns. */
export interface McpFailure {
  readonly ok: false;
  readonly code: string;
  readonly stage: Stage;
  readonly retryable: boolean;
  readonly message: string;
  readonly task?: string;
  readonly source?: string;
  readonly [key: string]: unknown;
}

/** Codes a later attempt can honestly fix: the server or site changed, not the request. */
const RETRYABLE = new Set([
  "busy",
  "cancelled",
  "event-gap",
  "not-ready",
  "operation-timeout",
  "snapshot-changed",
  "stale-cursor",
  "timeout",
  "unavailable",
]);

/** Whether a failure with this code may succeed when retried; unknown codes are not retryable. */
export function retryableCode(code: string): boolean {
  return RETRYABLE.has(code);
}

/** Keys whose values are private whatever the tool answers. */
const PRIVATE_KEY = /^(?:api[-_]?key|authorization|bearer|cookie|credential|passwd|password|private[-_]?key|secret|token)$/i;

/** A value with private keys gone and this machine's folders replaced by site-relative stand-ins. */
export function publicValue(value: unknown, folders: readonly string[]): unknown {
  if (typeof value === "string") return scrub(value, folders);
  if (Array.isArray(value)) return value.map((item) => publicValue(item, folders));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (PRIVATE_KEY.test(key)) continue;
      out[key] = publicValue(item, folders);
    }
    return out;
  }
  return value;
}

/** A message with no stack: only the first line, scrubbed of private folders. */
export function publicMessage(text: string, folders: readonly string[]): string {
  return scrub(text.split(/\r?\n\s+at\s/)[0]!, folders);
}

/** The failure an answer carries, from whatever a tool said. */
export function failureOf(
  code: string,
  message: string,
  options: {
    readonly stage: Stage;
    readonly retryable?: boolean;
    readonly task?: string;
    readonly source?: string;
    readonly folders?: readonly string[];
    readonly extra?: Readonly<Record<string, unknown>>;
  },
): McpFailure {
  return {
    ok: false,
    code,
    stage: options.stage,
    retryable: options.retryable ?? retryableCode(code),
    message: publicMessage(message, options.folders ?? []),
    ...(options.task === undefined ? {} : { task: options.task }),
    ...(options.source === undefined ? {} : { source: options.source }),
    ...(options.extra ?? {}),
  };
}

/**
 * Turns a tool's error result into the failure shape, keeping its own code and details. A tool that answered with
 * `{ ok: false, code, message }` keeps all three; anything else becomes `tool-error`.
 */
export function normalizeFailure(
  data: unknown,
  text: string,
  options: { readonly stage: Stage; readonly folders?: readonly string[]; readonly task?: string },
): McpFailure {
  const record = typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : undefined;
  const code = typeof record?.code === "string" ? record.code : "tool-error";
  const message = typeof record?.message === "string" ? record.message : text;
  const { ok: _ok, code: _code, message: _message, stage: _stage, ...extra } = record ?? {};
  return failureOf(code, message, {
    stage: typeof _stage === "string" ? (_stage as Stage) : options.stage,
    ...(typeof record?.retryable === "boolean" ? { retryable: record.retryable } : {}),
    ...(options.task === undefined ? {} : { task: options.task }),
    ...(options.folders === undefined ? {} : { folders: options.folders }),
    extra: publicValue(extra, options.folders ?? []) as Record<string, unknown>,
  });
}
