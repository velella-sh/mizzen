import type { Diagnostic, MarkdownSource, Page, Plugin, SourcePos } from "../contracts/index.ts";
import { runStage, type HookResult } from "./hooks.ts";
import { DEFAULT_HOOK_POLICY, type HookPolicy } from "./policy.ts";

const SEVERITIES = new Set<unknown>(["error", "warning", "info"]);

/** The number of lines a body has, a final newline included; the Markdown stage keeps it fixed. */
function lineCount(markdown: string): number {
  return markdown.split("\n").length;
}

/**
 * Runs the `markdown` hooks of one page in the Markdown stage, before parsing: each hook gets the body the one before
 * it returned, and the final text is what the parser sees. A hook that changes the line count would move every
 * position after its edit, so it is a `plugin.hook-failed` at the page source and the text before it is kept.
 */
export function runMarkdownHooks(
  plugins: readonly Plugin[],
  source: MarkdownSource,
  pos: SourcePos,
  policy: HookPolicy = DEFAULT_HOOK_POLICY,
): Promise<HookResult<MarkdownSource>> {
  const lines = lineCount(source.markdown);
  return runStage(
    plugins,
    "markdown",
    source,
    async (plugin, value) => ({ path: value.path, markdown: await plugin.markdown!(value) }),
    (value) => (lineCount(value.markdown) === lines ? undefined : "a Markdown body with a different line count"),
    () => pos,
    policy,
  );
}

/** One validate stage: the final page every hook reads, and the findings the hooks returned so far. */
interface Validation {
  readonly page: Page;
  readonly findings: readonly Diagnostic[];
}

function isDiagnostic(value: unknown): value is Diagnostic {
  if (value === null || typeof value !== "object") return false;
  const finding = value as Record<string, unknown>;
  return typeof finding.id === "string" && typeof finding.message === "string" && SEVERITIES.has(finding.severity);
}

/**
 * Runs the `validate` hooks of one final page, after its `content` hook: every hook reads a copy of the page and
 * returns findings, which the build adds to its diagnostics. A hook that throws, misses the deadline, or returns
 * something other than a list of diagnostics is a `plugin.hook-failed` at the page source, and the plugins after it
 * still run.
 */
export async function runValidateHooks(
  plugins: readonly Plugin[],
  page: Page,
  policy: HookPolicy = DEFAULT_HOOK_POLICY,
): Promise<HookResult<Page>> {
  const staged = await runStage<Validation>(
    plugins,
    "validate",
    { page, findings: [] },
    async (plugin, value) => {
      const returned: unknown = await plugin.validate!(value.page);
      const list = Array.isArray(returned) ? returned : [returned];
      return { page, findings: [...value.findings, ...(list as readonly Diagnostic[])] };
    },
    (value) => (value.findings.every(isDiagnostic) ? undefined : "a value that is not a list of diagnostics"),
    () => page.source,
    policy,
  );
  return { value: page, diagnostics: [...staged.value.findings, ...staged.diagnostics] };
}
