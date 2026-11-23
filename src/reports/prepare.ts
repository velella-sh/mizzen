import { createRequire } from "node:module";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import schema from "../../schema/report-set.schema.json" with { type: "json" };
import type { PreparedReport, ReportChange, ReportComparison, ReportRun, ReportSeries, ReportSet, ReportSeverity } from "../contracts/report.ts";

const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;
const severities: readonly ReportSeverity[] = ["error", "warning", "info", "unknown"];
const compile = () => new Ajv2020({ strict: true, allErrors: true }).compile<ReportSet>(schema);
let validateReport: ReturnType<typeof compile> | undefined;

export const REPORT_SOURCE = "_data/report-set.json";
export const ROWS_PER_REPORT_PAGE = 50;

/** A JSON Pointer and a diagnostic message for the public input. */
interface ReportProblem {
  readonly pointer: string;
  readonly message: string;
}

function duplicateIds(values: readonly { readonly id: string }[], pointer: string, problems: ReportProblem[]): void {
  const seen = new Set<string>();
  for (const [index, { id }] of values.entries()) {
    if (seen.has(id)) problems.push({ pointer: `${pointer}/${index}/id`, message: `Duplicate id "${id}"` });
    seen.add(id);
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => [key, canonical(item)]));
}

function instantOf(date: string): number | undefined {
  const instant = Date.parse(date);
  if (!Number.isFinite(instant)) return undefined;
  const expected = date.length === 10 ? `${date}T00:00:00.000Z` : date.replace(/(\d\d)Z$/, "$1.000Z");
  return new Date(instant).toISOString() === expected ? instant : undefined;
}

function publicLinks(links: readonly string[], pointer: string, problems: ReportProblem[]): void {
  for (const [index, href] of links.entries()) {
    const url = URL.parse(href);
    if (url === null || url.protocol !== "https:" || url.username !== "" || url.password !== "" || href.includes("\\")) {
      problems.push({ pointer: `${pointer}/${index}`, message: "Use a public HTTPS URL without credentials" });
    }
  }
}

function contentProblems(input: ReportSet): ReportProblem[] {
  const problems: ReportProblem[] = [];
  duplicateIds(input.runs, "/runs", problems);
  const runs = new Set(input.runs.map(({ id }) => id));
  const pairs = new Set<string>();
  const lastDate = new Map<string, number>();
  for (const [index, run] of input.runs.entries()) {
    const pointer = `/runs/${index}`;
    duplicateIds(run.findings, `${pointer}/findings`, problems);
    duplicateIds(run.checks, `${pointer}/checks`, problems);
    duplicateIds(run.metrics, `${pointer}/metrics`, problems);
    publicLinks(run.evidence ?? [], `${pointer}/evidence`, problems);
    for (const [findingIndex, finding] of run.findings.entries()) {
      publicLinks(finding.evidence ?? [], `${pointer}/findings/${findingIndex}/evidence`, problems);
    }
    if (run.date === undefined) continue;
    const date = instantOf(run.date);
    const group = JSON.stringify([run.tool, run.scope]);
    if (date === undefined || date < (lastDate.get(group) ?? -Infinity)) {
      problems.push({ pointer: `${pointer}/date`, message: "Use a valid UTC date and list runs in chronological order within their tool and scope" });
    } else {
      lastDate.set(group, date);
    }
  }
  for (const [index, pair] of input.comparisons.entries()) {
    const pointer = `/comparisons/${index}`;
    const key = JSON.stringify([pair.base, pair.head]);
    if (pair.base === pair.head || !runs.has(pair.base) || !runs.has(pair.head)) {
      problems.push({ pointer, message: "A comparison must name two different existing runs" });
    }
    if (pairs.has(key)) problems.push({ pointer, message: "Duplicate comparison" });
    pairs.add(key);
  }
  return problems;
}

function compare(base: ReportRun, head: ReportRun): ReportComparison {
  const pair = { base: base.id, head: head.id };
  if (base.scope !== head.scope || base.tool !== head.tool) return { ...pair, state: "different-scope", changes: [] };
  if (base.coverage !== "complete" || head.coverage !== "complete") return { ...pair, state: "incomplete", changes: [] };
  const next = new Map(head.findings.map((finding) => [finding.id, finding]));
  const changes: ReportChange[] = [];
  for (const before of base.findings) {
    const after = next.get(before.id);
    if (after === undefined) {
      changes.push({ kind: "resolved", before });
    } else {
      changes.push({ kind: JSON.stringify(before) === JSON.stringify(after) ? "unchanged" : "changed", before, after });
      next.delete(before.id);
    }
  }
  for (const after of next.values()) changes.push({ kind: "new", after });
  const rank = { new: 0, resolved: 1, changed: 2, unchanged: 3 };
  changes.sort((a, b) => rank[a.kind] - rank[b.kind]);
  return { ...pair, state: "comparable", changes };
}

function seriesOf(runs: readonly ReportRun[]): ReportSeries[] {
  const groups = Map.groupBy(runs, ({ tool, scope }) => JSON.stringify([tool, scope]));
  return [...groups.values()].flatMap((group) => {
    const { tool, scope } = group[0]!;
    const measurements = group.map((run) => {
      const counts = { error: 0, warning: 0, info: 0, unknown: 0 };
      for (const { severity } of run.findings) counts[severity]++;
      return { run, counts, metrics: new Map(run.metrics.map((metric) => [metric.id, metric])) };
    });
    const points = (value: (entry: typeof measurements[number]) => number | null) => measurements.map((entry) => ({
      run: entry.run.id,
      date: entry.run.date ?? null,
      value: entry.run.date === undefined || entry.run.coverage !== "complete" ? null : value(entry),
    }));
    const metrics = new Map(group.flatMap((run) => run.metrics.map(({ id, unit }) => [JSON.stringify([id, unit]), { id, unit }] as const)));
    return [
      ...severities.map((id) => ({ tool, scope, kind: "findings" as const, id, unit: "findings", points: points(({ counts }) => counts[id]) })),
      ...[...metrics.values()].map(({ id, unit }) => ({
        tool, scope, kind: "metric" as const, id, unit,
        points: points((entry) => {
          const metric = entry.metrics.get(id);
          return metric?.unit === unit ? metric.value : null;
        }),
      })),
    ];
  });
}

/** Validates the opt-in input, then produces one model for the built HTML and the public JSON. */
export function prepareReport(raw: unknown, base: string): { readonly report?: PreparedReport; readonly problems: readonly ReportProblem[] } {
  const validate = validateReport ??= compile();
  if (!validate(raw)) {
    return { problems: (validate.errors ?? []).map((error) => ({
      pointer: error.instancePath,
      message: error.keyword === "additionalProperties" ? `Unexpected property "${error.params.additionalProperty}"` : error.message ?? "Invalid value",
    })) };
  }
  const problems = contentProblems(raw);
  if (problems.length > 0) return { problems };
  const input = canonical(raw) as ReportSet;
  const url = `${base}${input.route}`;
  const runs = input.runs.map((run) => ({ ...run, url: `${url}runs/${run.id}/` }));
  const byId = new Map(runs.map((run) => [run.id, run]));
  return {
    problems: [],
    report: {
      schemaVersion: 1,
      title: input.title,
      url,
      jsonUrl: `${url}data.json`,
      runs,
      comparisons: input.comparisons.map(({ base, head }) => ({
        ...compare(byId.get(base)!, byId.get(head)!),
        url: `${url}compare/${base}/${head}/`,
      })),
      series: seriesOf(runs),
    },
  };
}
