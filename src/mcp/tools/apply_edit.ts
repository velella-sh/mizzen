/**
 * `apply_edit`: applies an edit through the `edit apply` transaction, so the source, its proof, and the audit entry
 * land together. Registered only when the server starts with `--allow-edits`.
 */
import { editSchema, runApply, type EditInput } from "../edit.ts";
import type { Tool } from "../tool.ts";

export const tool: Tool<EditInput> = {
  name: "apply_edit",
  description:
    "Apply an edit to the source and record its proof. Needs `expected` and `beforeHash` (from get_block_source); a patch that does not match the file is refused and nothing changes. Rebuilds and returns the diagnostics of the changed file and the proof's site-relative path.",
  stage: "edit",
  inputSchema: editSchema,
  enabled: (setup) => setup.allowEdits,
  // The edit rebuilds the site, which on a large site or a slow machine outlasts the default call limit.
  timeoutMs: 120_000,
  handler: (input, { site, runtime, session, signal }) => runApply(site, input, runtime, session, signal),
};
