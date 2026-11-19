/** `get_pack`: a context pack for a task, compiled as `mizzen pack --request` compiles it, within a token budget. */
import { parseContextRequest } from "../../packs/task.ts";
import { compilePack } from "../../packs/compile.ts";
import type { Diagnostic } from "../../contracts/index.ts";
import { MAX_PACK_TOKENS } from "../limits.ts";
import { json, refusal, type Tool } from "../tool.ts";

interface Input {
  readonly goal: string;
  readonly kind?: string;
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly locale?: string;
  readonly maxTokens: number;
  readonly reservedTokens?: number;
  /** Start the pack as an operation and return its id instead of waiting for the pack. */
  readonly background?: boolean;
}

export const tool: Tool<Input> = {
  name: "get_pack",
  description: `Compile a context pack for a task: the best pages, trimmed to \`maxTokens\` (at most ${MAX_PACK_TOKENS}). Returns the Markdown pack with its selection, omissions, and token accounting. With \`background: true\` it returns an operation id at once.`,
  stage: "context",
  inputSchema: {
    type: "object",
    properties: {
      goal: { type: "string", minLength: 1, maxLength: 2000, description: "The task in one sentence." },
      kind: { enum: ["explain", "implement", "review", "debug", "migrate", "other"] },
      include: { type: "array", items: { type: "string" }, maxItems: 50, description: "Pages or topics to favour." },
      exclude: { type: "array", items: { type: "string" }, maxItems: 50, description: "Pages or topics to drop." },
      locale: { type: "string", description: "A BCP 47 language tag." },
      maxTokens: { type: "integer", minimum: 1, description: `Token budget of the whole pack, at most ${MAX_PACK_TOKENS}.` },
      reservedTokens: { type: "integer", minimum: 0, description: "Tokens held back for required evidence." },
      background: { type: "boolean", description: "Start an operation and return its id; poll get_operation for the pack." },
    },
    required: ["goal", "maxTokens"],
    additionalProperties: false,
  },
  async handler(input, { site, runtime, session, progressToken }) {
    if (input.maxTokens > MAX_PACK_TOKENS) {
      return refusal("budget-too-large", `maxTokens ${input.maxTokens} is over the limit of ${MAX_PACK_TOKENS}; ask for a smaller pack.`, { limit: MAX_PACK_TOKENS });
    }
    if (input.background === true) {
      const started = await runtime.start(session, "pack", { ...input, background: undefined }, progressToken);
      return json({
        ok: true,
        operationId: started.operationId,
        status: started.status,
        stage: started.stage,
        work: started.work,
        expected: started.expected,
        snapshot: started.snapshot,
      });
    }
    const parsed = parseContextRequest({
      version: 1,
      task: { goal: input.goal, ...(input.kind === undefined ? {} : { kind: input.kind }) },
      ...(input.include === undefined ? {} : { include: input.include }),
      ...(input.exclude === undefined ? {} : { exclude: input.exclude }),
      ...(input.locale === undefined ? {} : { constraints: { locale: input.locale } }),
      budget: { maxTokens: input.maxTokens, ...(input.reservedTokens === undefined ? {} : { reservedTokens: input.reservedTokens }) },
    });
    if (parsed.request === undefined) {
      return refusal("bad-request", parsed.problems.map((p) => p.message).join(" "));
    }
    const diagnostics: Diagnostic[] = [];
    const compiled = await compilePack(
      site.site,
      parsed.request,
      { renderPage: () => Promise.reject(new Error("pack builds no pages")), report: (d) => void diagnostics.push(d) },
      { warnings: site.diagnostics, ...(site.access === undefined ? {} : { access: site.access }) },
    );
    if (compiled === undefined) {
      return refusal("empty-pack", "The request selected no context.", { diagnostics });
    }
    return json({ ok: true, markdown: compiled.markdown, diagnostics });
  },
};
