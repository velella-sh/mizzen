/**
 * The check a data-impact prediction is for: the outputs an invalidation plan named against the outputs a build
 * really changed (#828), and the Markdown summary a pull request shows for one changed record (#830).
 *
 * A real change the plan did not name is a publication outside the recorded scope, and it keeps the change that
 * produced it, so a report can say which record or file reached past its plan. A planned output the build did not
 * change is reported apart from that: an over-broad plan and an out-of-scope publication are different findings.
 */
import type { AffectedOutputs, ExplainedOutput } from "../pipeline/dependency-graph.ts";

/** What published an output: the record or source file whose change reached it, and what that change was. */
export interface OutputOrigin {
  /** Node id of the change: a record (`record:<collection>/<id>`) or a source file (`file:<path>`). */
  readonly node: string;
  /** What happened to it. */
  readonly change: "added" | "removed" | "changed";
}

/** One output the real build changed. */
export interface PublishedOutput {
  /** The output's URL or path, without the dependency graph's `output:` prefix. */
  readonly path: string;
  /** The change that published it. */
  readonly origin: OutputOrigin;
}

/** The prediction and the real build, set against each other. Both lists are sorted by path. */
export interface ScopeComparison {
  /** Real changes the plan did not name: publications outside the recorded scope. */
  readonly outside: readonly PublishedOutput[];
  /** Planned outputs the build did not change: predictions the build did not confirm. */
  readonly unconfirmed: readonly string[];
}

const OUTPUT = "output:";

/** The path of a plan entry, which `affectedOutputs` names with its node prefix. */
function outputPath(id: string): string {
  return id.startsWith(OUTPUT) ? id.slice(OUTPUT.length) : id;
}

/** Text order by code point, so the comparison is the same whatever the host's locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Compares {@link AffectedOutputs} with the outputs a build really changed.
 *
 * Every output is matched by path. A path listed twice in `changed` keeps the first origin in code-point order, so
 * the order the build reported its changes in cannot change the answer.
 */
export function compareScope(predicted: AffectedOutputs, changed: readonly PublishedOutput[]): ScopeComparison {
  const planned = new Set<string>();
  for (const id of [...predicted.page, ...predicted.list, ...predicted.feed, ...predicted.api]) planned.add(outputPath(id));

  const ordered = [...changed].sort(
    (a, b) =>
      byCodePoint(a.path, b.path) || byCodePoint(a.origin.node, b.origin.node) || byCodePoint(a.origin.change, b.origin.change),
  );
  const real = new Map<string, PublishedOutput>();
  for (const output of ordered) if (!real.has(output.path)) real.set(output.path, output);

  const outside = [...real.values()].filter((output) => !planned.has(output.path));
  const unconfirmed = [...planned].filter((path) => !real.has(path)).sort(byCodePoint);
  return { outside, unconfirmed };
}

/** The output kinds in the order a summary lists them, so two summaries of one change read alike. */
const ROLES = ["page", "list", "feed", "api"] as const;

/**
 * The Markdown a pull request shows for one changed record: the record, how many outputs of each kind it reaches, and a
 * link to the full report. Kinds with no output are left out, so the table is only the work the change causes.
 */
export function impactSummary(record: string, outputs: readonly ExplainedOutput[], report: string): string {
  const lines = ["<!-- mizzen-data-impact -->", `### Data change: \`${record}\``, ""];
  const rows = ROLES.map((role) => ({ role, count: outputs.filter((output) => output.role === role).length })).filter(
    (row) => row.count > 0,
  );
  if (rows.length === 0) {
    lines.push("No published output is affected.", "");
  } else {
    lines.push("| Output | Count |", "| --- | ---: |");
    for (const row of rows) lines.push(`| ${row.role} | ${row.count} |`);
    lines.push("");
  }
  lines.push(`[Full report](${report})`);
  return `${lines.join("\n")}\n`;
}
