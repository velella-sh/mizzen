/**
 * Explicit degradation for clients that declare less. Every missing capability names what the
 * server does instead and why, so a limited client sees an honest fallback rather than a silent
 * change in behavior.
 */
import type { ClientCapabilities, ClientFallback, ClientProfile } from "../contracts/clients.ts";

const LABELS: Readonly<Record<string, string>> = {
  resources: "resources",
  notifications: "notifications",
  progress: "progress",
  longRunningTasks: "long-running tasks",
  "long-running-tasks": "long-running tasks",
  approvals: "approvals",
  editing: "safe editing",
  cursors: "cursors",
};

function missing(capability: string, fallback: string, reason: string): ClientFallback {
  return { capability, fallback, reason };
}

/** Every unavailable capability and its fallback, in report order. */
export function fallbacksOf(capabilities: ClientCapabilities): readonly ClientFallback[] {
  const out: ClientFallback[] = [];
  if (!capabilities.resources) {
    out.push(missing("resources", "Read page Markdown through get_page; resources are not advertised.", "The client did not declare MCP resource support."));
  }
  if (!capabilities.notifications) {
    out.push(missing("notifications", "Every answer is returned inline; no unsolicited notifications are sent.", "The client did not declare that it accepts notifications."));
  }
  if (!capabilities.progress) {
    out.push(missing("progress", "No progress notifications; repeat the read, or read the receipt's hash, to poll.", "The client did not declare progress support."));
  }
  if (!capabilities.longRunningTasks) {
    out.push(missing("long-running-tasks", "Calls run synchronously and return their receipt in the answer; there is no task id to poll.", "The client did not declare task creation for tool calls."));
  }
  if (!capabilities.approvals) {
    out.push(missing("approvals", "A write needs --allow-edits and any approval the access policy names; otherwise use propose_edit.", "The client did not declare that a person can approve an action."));
  }
  if (!capabilities.editing) {
    out.push(missing("editing", "apply_edit is refused; propose_edit returns the span patch and diff to hand to a person.", "The client declared that it cannot apply an edit safely."));
  }
  if (!capabilities.cursors) {
    out.push(missing("cursors", "Lists return nextOffset for the next page instead of nextCursor.", "The client did not declare cursor support."));
  }
  return out;
}

/** One line for a startup log: the client, its contract and protocol, and what was unavailable. */
export function clientReport(profile: ClientProfile): string {
  const unavailable = profile.fallbacks.length === 0 ? "all declared capabilities available" : `unavailable: ${profile.fallbacks.map((fallback) => LABELS[fallback.capability] ?? fallback.capability).join(", ")}`;
  return `client ${profile.client.id} (contract ${profile.contractVersion}, protocol ${profile.protocolVersion}); ${unavailable}`;
}
