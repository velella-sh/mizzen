/**
 * Stale pages as diagnostics, so `mizzen check` and `mizzen doctor` report them like any other finding and `--format json`
 * and `--format sarif` carry them.
 *
 * - `stale.page`: a page's covered files changed, were removed, or were added since the page was marked as reviewed.
 *   The message names the files and their change; the position is the page's `covers` key. The severity is
 *   `stale.severity` (`info`, `warning`, or `error`) and is `warning` when the site sets none: a stale page never fails a
 *   build unless the site asks.
 * - `stale.covers-*` and `stale.lock-invalid`: problems with `covers` or the lock, with their own severity.
 *
 * A site with no `covers` and no lock gets nothing.
 */
import type { Diagnostic } from "../contracts/index.ts";
import { readReviewLock } from "./lock.ts";
import { loadCoveredPages } from "./pages.ts";
import { applyMoves, compareToLock } from "./report.ts";

/** The stale-page diagnostics of the site at `root`, in page order. */
export async function staleDiagnostics(root: string): Promise<Diagnostic[]> {
  const loaded = await loadCoveredPages(root);
  if (loaded.errors.length > 0 || loaded.pages.length === 0) return [];
  const out: Diagnostic[] = [];
  const lock = await readReviewLock(root);
  out.push(...lock.diagnostics);
  for (const page of loaded.pages) out.push(...page.diagnostics);
  if (lock.diagnostics.length === 0) {
    const { pages } = await applyMoves(compareToLock(loaded.pages, lock.lock), lock.lock, loaded.coversRoot);
    const covers = new Map(loaded.pages.map((p) => [p.page, p.line]));
    for (const page of pages) {
      const files = page.files.map((f) => `${f.change} ${f.path}`).join(", ");
      const since = page.reviewed === undefined ? "never reviewed" : `last reviewed ${page.reviewed}`;
      out.push({
        id: "stale.page",
        severity: loaded.severity,
        message: `${page.page} may be out of date (${since}): ${files}.`,
        pos: { file: page.page, line: covers.get(page.page) ?? 1, column: 1, endLine: covers.get(page.page) ?? 1, endColumn: 1 },
        help: page.fix,
      });
    }
  }
  return out;
}
