/** `cancel_operation`: stop an operation at its next safe boundary and discard any partial result. */
import { json, type Tool } from "../tool.ts";
import { viewAsJson } from "./start_operation.ts";

interface Input {
  readonly operationId: string;
}

export const tool: Tool<Input> = {
  name: "cancel_operation",
  description:
    "Cancel a running operation at a safe boundary. It keeps no partial result and never leaves a successful proof; cancelling a finished operation changes nothing.",
  inputSchema: {
    type: "object",
    properties: {
      operationId: { type: "string", minLength: 1, description: "The id start_operation returned." },
    },
    required: ["operationId"],
    additionalProperties: false,
  },
  stage: "operation",
  snapshotFree: true,
  async handler(input, { runtime, session }) {
    const view = await runtime.cancel(session, input.operationId);
    return json({ ok: true, ...viewAsJson(view) });
  },
};
