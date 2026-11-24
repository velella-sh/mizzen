/**
 * `why_decision`: answer why a behavior or a page exists, from the current decision, its rationale, the alternatives
 * that were rejected, and the decisions that came before, each with a citation. The same answer the
 * `mizzen decisions why` command prints.
 *
 * Only a record the caller may read is considered, and a private value is replaced with its placeholder, so the answer
 * cannot be a way around the access policy.
 */
import { loadDecisions } from "../../decisions/load.ts";
import { why } from "../../decisions/why.ts";
import { json, type Tool } from "../tool.ts";

interface Input {
  readonly subject: string;
  readonly version?: string;
  readonly snapshot?: string;
  readonly allow?: readonly string[];
}

export const tool: Tool<Input> = {
  name: "why_decision",
  description:
    "Explain why a behavior or a page exists: the decision in effect for the subject, its rationale, the rejected alternatives, and the decisions it superseded, each with a citation. The subject is a behavior id (`behavior:cache-hit`), a page URL or source path, a collection (`collection:users`), or any stable id a decision names. Pass `version` or `snapshot` for the decision in effect then; without it, the current decision is answered.",
  inputSchema: {
    type: "object",
    properties: {
      subject: { type: "string", minLength: 1, description: "The behavior id, page URL or source path, collection id, or decision id to explain." },
      version: { type: "string", minLength: 1, description: "The documentation version to resolve at, such as v1.2." },
      snapshot: { type: "string", minLength: 1, description: "The build snapshot to resolve at." },
      allow: { type: "array", items: { type: "string", minLength: 1 }, description: "Audiences the caller may read; without it, a decision with an audience is left out." },
    },
    required: ["subject"],
    additionalProperties: false,
  },
  async handler(input, { site }) {
    const config = site.site.config.decisions;
    const loaded = await loadDecisions({
      root: site.root,
      site: site.site,
      dir: config?.dir ?? "docs/decisions",
      ...(config === undefined ? {} : { behaviors: (id: string) => config.behaviors.includes(id) }),
    });
    const answer = why(input.subject, loaded.records, {
      lifecycle: loaded.lifecycle,
      query: {
        ...(input.version === undefined ? {} : { version: input.version }),
        ...(input.snapshot === undefined ? {} : { snapshot: input.snapshot }),
      },
      ...(input.allow === undefined || input.allow.length === 0 ? {} : { allow: input.allow }),
    });
    return json(answer as unknown as Record<string, unknown>);
  },
};
