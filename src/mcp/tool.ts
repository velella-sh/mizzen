/** The contract of one MCP tool. A tool is one file in `src/mcp/tools/`; its name is the file name. */
import type { Stage } from "./runtime/errors.ts";
import type { Runtime, Session } from "./runtime/operations.ts";
import type { SiteState } from "./site.ts";

/** A JSON Schema object describing a tool's input. */
export type InputSchema = {
  readonly type: "object";
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
};

/** What a tool sees while the server starts, to decide whether it registers. */
export interface ToolSetup {
  /** Whether the server started with `--allow-edits`. */
  readonly allowEdits: boolean;
  /** Names of the data collections the site declares. */
  readonly collections: readonly string[];
}

/** What a tool sees on a call. */
export interface ToolContext {
  readonly site: SiteState;
  readonly signal: AbortSignal;
  /** Operations, sessions, and receipts this call belongs to. */
  readonly runtime: Runtime;
  readonly session: Session;
  /** The client's progress token for this call, when it sent one. */
  readonly progressToken?: string | number;
}

/** A tool's answer: text for the agent, optionally the same data as a structured value. */
export interface ToolResult {
  readonly text: string;
  readonly data?: Record<string, unknown>;
  readonly isError?: boolean;
}

/** One tool. */
export interface Tool<Input = Record<string, unknown>> {
  /** Equals the file name without its extension. */
  readonly name: string;
  readonly description: string;
  readonly inputSchema: InputSchema;
  /** Return false to leave the tool out of this server; absent means always registered. */
  readonly enabled?: (setup: ToolSetup) => boolean;
  /** The stage this tool works in; its deadline is the stage's own, and it labels every failure. */
  readonly stage?: Stage;
  /** True when the tool reads session or operation state, so a changed site does not block it. */
  readonly snapshotFree?: boolean;
  /** Longest this tool may run, in milliseconds, when the stage limit is too short. */
  readonly timeoutMs?: number;
  readonly handler: (input: Input, ctx: ToolContext) => Promise<ToolResult>;
}

/** A successful JSON answer: the data, printed, and also kept as structured content. */
export function json(data: Record<string, unknown>): ToolResult {
  return { text: JSON.stringify(data, null, 2), data };
}

/** A refused request the agent can act on. */
export function refusal(code: string, message: string, extra: Record<string, unknown> = {}): ToolResult {
  const data = { ok: false, code, message, ...extra };
  return { text: JSON.stringify(data, null, 2), data, isError: true };
}
