/**
 * Stale pages as diagnostics, so `mizzen check` and `mizzen doctor` report them like any other finding and `--format json`
 * and `--format sarif` carry them. The same comparison feeds `Page.stale`, so a theme and the page JSON see what `check`
 * reports.
 *
 * - `stale.page`: a page's covered files changed, were removed, or were added since the page was marked as reviewed.
 *   The message names the files and their change; the position is the page's `covers` key. The severity is
 *   `stale.severity` (`info`, `warning`, or `error`) and is `warning` when the site sets none: a stale page never fails a
 *   build unless the site asks.
 * - `stale.covers-*` and `stale.lock-invalid`: problems with `covers` or the lock, with their own severity.
 *
 * A site with no `covers` and no lock gets nothing.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Diagnostic, PageStale } from "../contracts/index.ts";
import { readReviewLock, REVIEW_LOCK_FILE } from "./lock.ts";
import { loadCoveredPages, type LoadedCoveredPages } from "./pages.ts";
import { applyMoves, compareToLock, type StalePage } from "./report.ts";

/** What one read of the covered pages and the lock gives both the diagnostics and the build. */
interface StaleReport {
  readonly loaded: LoadedCoveredPages;
  /** The lock's own findings; a page is not compared with an unreadable lock. */
  readonly lockDiagnostics: readonly Diagnostic[];
  readonly pages: readonly StalePage[];
}

/** Reads the pages with `covers` and compares them with the review lock. */
async function readStale(root: string): Promise<StaleReport> {
  const loaded = await loadCoveredPages(root);
  if (loaded.errors.length > 0 || loaded.pages.length === 0) return { loaded, lockDiagnostics: [], pages: [] };
  const { lock, diagnostics } = await readReviewLock(root);
  if (diagnostics.length > 0) return { loaded, lockDiagnostics: diagnostics, pages: [] };
  const { pages } = await applyMoves(compareToLock(loaded.pages, lock), lock, loaded.coversRoot);
  return { loaded, lockDiagnostics: [], pages };
}

/** The stale-page diagnostics of the site at `root`, in page order. */
export async function staleDiagnostics(root: string): Promise<Diagnostic[]> {
  const { loaded, lockDiagnostics, pages } = await readStale(root);
  if (loaded.errors.length > 0 || loaded.pages.length === 0) return [];
  const out: Diagnostic[] = [...lockDiagnostics];
  for (const page of loaded.pages) out.push(...page.diagnostics);
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
  return out;
}

/**
 * The stale state of each page with `covers`, keyed by source path relative to the site root. The build attaches it to
 * `Page.stale`, which reaches the layout and the page JSON. Empty when the site has no covered page or its lock cannot
 * be read: nothing is fabricated in its place.
 */
export async function stalePageStates(root: string): Promise<Map<string, PageStale>> {
  // A site with no lock has nothing reviewed to hand over, and a build should not read every source page to find that
  // out. `mizzen stale` still reports such a page as never reviewed, and the first `mark` creates the lock.
  if (!existsSync(join(root, REVIEW_LOCK_FILE))) return new Map();
  const { pages } = await readStale(root);
  return new Map(
    pages.map((page) => [page.page, { ...(page.reviewed === undefined ? {} : { reviewed: page.reviewed }), files: page.files }]),
  );
}
