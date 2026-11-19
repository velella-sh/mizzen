/** `start_operation`: start pack compilation, proof verification, or task replay without waiting for it. */
import { json, refusal, type Tool } from "../tool.ts";
import type { OperationKind, OperationView } from "../runtime/operations.ts";

interface Input {
  readonly kind: OperationKind;
  readonly input?: Record<string, unknown>;
}

export const tool: Tool<Input> = {
  name: "start_operation",
  description:
    "Start a long-running operation and return its id at once: `pack` compiles a context pack, `verify` checks the edit proofs, `replay` replays a task's events. Poll get_operation for progress and the result; cancel_operation stops it at a safe boundary. Progress measures real work, never time.",
  inputSchema: {
    type: "object",
    properties: {
      kind: { enum: ["pack", "verify", "replay"], description: "The work to start." },
      input: {
        type: "object",
        description:
          "The work's arguments: a pack request (`goal`, `maxTokens`, and the options of get_pack); verify's optional `proof` (site-relative; every proof under `.mizzen/mcp/edits` when absent); or replay's `taskId` and `events` (or a task document as `task`).",
      },
    },
    required: ["kind"],
    additionalProperties: false,
  },
  stage: "operation",
  async handler(input, { runtime, session, progressToken }) {
    if (input.kind !== "pack" && input.kind !== "verify" && input.kind !== "replay") {
      return refusal("bad-request", "kind must be pack, verify, or replay.");
    }
    const view = await runtime.start(session, input.kind, input.input ?? {}, progressToken);
    return json({ ok: true, ...viewAsJson(view) });
  },
};

/** The JSON shape every operation answer uses. */
export function viewAsJson(view: OperationView): Record<string, unknown> {
  return {
    operationId: view.operationId,
    kind: view.kind,
    status: view.status,
    stage: view.stage,
    work: view.work,
    expected: view.expected,
    events: view.events,
    dropped: view.dropped,
    snapshot: view.snapshot,
    resumed: view.resumed,
    ...(view.result === undefined ? {} : { result: view.result }),
    ...(view.error === undefined ? {} : { error: view.error }),
  };
}
