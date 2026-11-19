/**
 * Structured progress for one agent run.
 *
 * Every event has the same seven keys, so a consumer parses one shape and never branches on a missing
 * field. The order is the execution order: `start`, then one or more `progress`, optionally
 * `approval-required`, and exactly one terminal `finish` or `failure`. Each carries the schema
 * version, a zero-based sequence without gaps, and the task id, so two concurrent runs never mix.
 */
import type { TaskStatus } from "../contracts/task.ts";

/** The event schema version. */
export const EVENTS_VERSION = 1;

/** The five event kinds, in the only order they may appear. */
export type AgentEventType = "start" | "progress" | "approval-required" | "finish" | "failure";

/** One versioned progress event. Every field is present on every event. */
export interface AgentEvent {
  readonly version: 1;
  readonly sequence: number;
  readonly taskId: string;
  readonly type: AgentEventType;
  readonly stage: string | null;
  readonly state: TaskStatus | null;
  readonly message: string;
}

/** Appends one event with the next sequence number. */
export function addEvent(
  events: readonly AgentEvent[],
  taskId: string,
  type: AgentEventType,
  stage: string | null,
  state: TaskStatus | null,
  message: string,
): AgentEvent[] {
  return [...events, { version: EVENTS_VERSION, sequence: events.length, taskId, type, stage, state, message }];
}

/** The versioned progress object embedded in a result. */
export function progressOf(events: readonly AgentEvent[]): Record<string, unknown> {
  return { version: EVENTS_VERSION, events };
}

/** The events as JSON Lines: one compact event per line, in order, with a final newline. */
export function ndjsonOf(events: readonly AgentEvent[], final: Record<string, unknown>): string {
  return [...events.map((event) => JSON.stringify(event)), JSON.stringify({ version: EVENTS_VERSION, type: "result", ...final })].join("\n") + "\n";
}
