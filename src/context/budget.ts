/**
 * Fixed-budget packing for sourced fragments.
 *
 * Fragments are ordered once, by what the task cannot lose: the ones that answer a scope or
 * acceptance reference first, then the entry points themselves, then transitive dependencies, then
 * lineage. That order does not depend on the budget, so raising or lowering a budget only changes
 * which suffix is admitted, never why one fragment outranks another. A fragment is admitted whole
 * or not at all: it never exceeds the room left, and a fragment that would overflow is reported as
 * a `budget` omission with the exact shortfall. The accounting splits fragment estimates, template
 * overhead, and safety margin, and `fragments + template + safety` is the number a client reports.
 */
import type { ContextFragment, ContextOmission } from "./types.ts";
import { estimatePack, type PackEstimate } from "../packs/tokens.ts";

/** The pack's title line. */
function titleOf(goal: string): string {
  return `# Task context: ${goal.replace(/\s+/g, " ").trim() || "task"}`;
}

/** One fragment's section header: what it is and where the text came from. */
function headerOf(fragment: ContextFragment): string {
  const lines = [
    `## ${fragment.title.replace(/\s+/g, " ").trim() || fragment.id}`,
    "",
    `- Kind: ${fragment.kind}`,
    `- Source: \`${fragment.source.span}\``,
    ...(fragment.source.block === undefined ? [] : [`- Block: \`${fragment.source.block}\``]),
    ...(fragment.source.record === undefined ? [] : [`- Record: \`${fragment.source.record}\``]),
    `- Snapshot: \`${fragment.source.snapshot}\``,
    `- Why: ${fragment.reason}${fragment.via.length === 0 ? "" : ` (${fragment.via.join(", ")})`}`,
  ];
  return lines.join("\n");
}

/** One fragment's section, body included when `includeBody` is true. */
function sectionOf(fragment: ContextFragment, includeBody: boolean): string {
  const header = headerOf(fragment);
  return !includeBody || fragment.content === "" ? header : `${header}\n\n${fragment.content}`;
}

/** The whole Markdown pack, with or without fragment bodies, deterministically. */
export function renderContext(goal: string, fragments: readonly ContextFragment[], includeBody = true): string {
  const parts = [titleOf(goal)];
  for (const fragment of fragments) parts.push(sectionOf(fragment, includeBody));
  return `${parts.join("\n\n")}\n`;
}

/** One priority band: lower is kept first, and the band never depends on the budget. */
function priorityOf(fragment: ContextFragment): number {
  if (fragment.refs.length > 0) return 0;
  if (fragment.reason.startsWith("lineage.")) return 3;
  if (fragment.reason.startsWith("dependency.")) return 2;
  return 1;
}

/** The packed result: the admitted fragments, the budget refusals, the Markdown, and its split cost. */
export interface PackedContext {
  readonly fragments: readonly ContextFragment[];
  readonly omitted: readonly ContextOmission[];
  readonly markdown: string;
  readonly estimate: PackEstimate;
}

/**
 * Packs fragments in their fixed priority order while the exact Markdown's bound stays inside
 * `maxTokens`. Every fragment is measured whole; a refusal names the fragment and the shortfall.
 */
export function packContext(goal: string, fragments: readonly ContextFragment[], maxTokens: number): PackedContext {
  const ordered = fragments
    .map((fragment, index) => ({ fragment, index, priority: priorityOf(fragment) }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .map((entry) => entry.fragment);

  const accepted: ContextFragment[] = [];
  const omitted: ContextOmission[] = [];
  for (const fragment of ordered) {
    const next = [...accepted, fragment];
    const markdown = renderContext(goal, next);
    const template = renderContext(goal, next, false);
    const estimate = estimatePack(markdown, next.map((entry) => entry.content), template);
    if (estimate.used > maxTokens) {
      omitted.push({
        ref: fragment.id,
        kind: "fragment",
        reason: "budget",
        detail:
          `\`${fragment.title}\` needs ${fragment.tokens} tokens; admitting it would bring the pack to ` +
          `${estimate.used} with its margin, ${estimate.used - maxTokens} over the ${maxTokens}-token budget.`,
      });
      continue;
    }
    accepted.push(fragment);
  }

  const markdown = renderContext(goal, accepted);
  const template = renderContext(goal, accepted, false);
  const estimate = estimatePack(markdown, accepted.map((entry) => entry.content), template);
  return { fragments: accepted, omitted, markdown, estimate };
}
