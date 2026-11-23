/**
 * Compare documentation coverage across versions (#1345): given two reports, names the items added, removed, documented,
 * and undocumented between them. The comparison keys on the item's stable id, never on its source file or line, so a
 * renamed source file or a moved declaration is not a change and a file rename alone never causes a coverage regression.
 *
 * An item that is `complete` in both reports, or `missing` in both, is not a change; only a crossing into or out of
 * `complete` is. `partial` to `complete` is `documented`, and `complete` to `partial` or `missing` is `undocumented`.
 */
import type { SurfaceChange, SurfaceComparison, SurfaceCounts, SurfaceDocState, SurfaceReport } from "../contracts/surface.ts";
import { byCodePoint } from "./contract.ts";

/** An empty accumulator of the counts. */
function emptyCounts(): { -readonly [K in keyof SurfaceCounts]: number } {
  return { documented: 0, partial: 0, undocumented: 0, excluded: 0, total: 0 };
}

/** The documentation state of one item id in a report. */
function statesOf(report: SurfaceReport): Map<string, { state: SurfaceDocState; area: SurfaceReport["items"][number]["area"] }> {
  const matches = new Map(report.matches.map((match) => [match.item, match.state]));
  const states = new Map<string, { state: SurfaceDocState; area: SurfaceReport["items"][number]["area"] }>();
  for (const item of report.items) {
    states.set(item.id, { state: matches.get(item.id) ?? "missing", area: item.area });
  }
  return states;
}

/**
 * Compares two reports: every item in the later report but not the earlier is `added`, the reverse is `removed`, and an
 * item in both whose state crosses the `complete` boundary is `documented` or `undocumented`. The result is sorted by
 * area then id, and its `delta` is the count difference, `current` minus `baseline`.
 */
export function compareSurfaceReports(baseline: SurfaceReport, current: SurfaceReport): SurfaceComparison {
  const before = statesOf(baseline);
  const after = statesOf(current);
  const changes: SurfaceChange[] = [];

  for (const [id, entry] of after) {
    const earlier = before.get(id);
    if (earlier === undefined) {
      changes.push({ id, area: entry.area, change: "added", to: entry.state });
      continue;
    }
    if (earlier.state === entry.state) continue;
    if (earlier.state !== "complete" && entry.state === "complete") {
      changes.push({ id, area: entry.area, change: "documented", from: earlier.state, to: entry.state });
    } else if (earlier.state === "complete" && entry.state !== "complete") {
      changes.push({ id, area: entry.area, change: "undocumented", from: earlier.state, to: entry.state });
    }
  }
  for (const [id, entry] of before) {
    if (after.has(id)) continue;
    changes.push({ id, area: entry.area, change: "removed", from: entry.state });
  }
  changes.sort((a, b) => byCodePoint(a.area, b.area) || byCodePoint(a.id, b.id));

  const delta = emptyCounts();
  for (const key of Object.keys(delta) as (keyof SurfaceCounts)[]) {
    delta[key] = current.coverage.counts[key] - baseline.coverage.counts[key];
  }
  return {
    version: 1,
    ...(baseline.source.version === undefined ? {} : { baseline: baseline.source.version }),
    ...(current.source.version === undefined ? {} : { current: current.source.version }),
    changes,
    delta,
  };
}
