/** `propose_edit`: the span patch and unified diff for an edit, checked as `edit apply --dry-run` checks it; writes nothing. */
import { editSchema, runEdit, type EditInput } from "../edit.ts";
import type { Tool } from "../tool.ts";

export const tool: Tool<EditInput> = {
  name: "propose_edit",
  description:
    "Check an edit and return its span patch and a unified diff, without writing anything. Take `file`, `span`, `expected`, and `beforeHash` from get_block_source. A stale hash, text that differs from `expected`, or a file outside the site is refused with a reason.",
  stage: "edit",
  inputSchema: editSchema,
  handler: (input, { site }) => runEdit(site, input, false),
};
