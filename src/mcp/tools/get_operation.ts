/** `get_operation`: recover an operation's status, real progress, and result by its id, even after a reconnect. */
import { json, type Tool } from "../tool.ts";
import { viewAsJson } from "./start_operation.ts";

interface Input {
  readonly operationId: string;
  readonly after?: number;
  readonly waitMs?: number;
}

export const tool: Tool<Input> = {
  name: "get_operation",
  description:
    "Get an operation started by this session: status, stage, completed work, bounded progress events, and the result or recoverable error. Pass the last `seq` you saw as `after`. `waitMs` waits up to 5 seconds for a running operation. Reads only this session's operations.",
  inputSchema: {
    type: "object",
    properties: {
      operationId: { type: "string", minLength: 1, description: "The id start_operation returned." },
      after: { type: "integer", minimum: 0, description: "Return events after this seq; drop earlier ones." },
      waitMs: { type: "integer", minimum: 0, maximum: 5000, description: "Wait up to this many milliseconds for the operation to finish (default 0)." },
    },
    required: ["operationId"],
    additionalProperties: false,
  },
  stage: "operation",
  snapshotFree: true,
  async handler(input, { runtime, session }) {
    const view = await runtime.operation(session, input.operationId, input.after, input.waitMs ?? 0);
    return json({ ok: true, ...viewAsJson(view) });
  },
};
