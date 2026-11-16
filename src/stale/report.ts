/**
 * Compares each page's covered files, as they are now, with the review lock. A pure function of its arguments: no
 * file, clock, or network read.
 *
 * A page is stale when a covered file changed (its hash differs), was removed (the lock has it and the page no longer
 * reaches it), or was added (a glob now matches a file the lock does not have). A page with `covers` and no lock entry
 * has never been reviewed: every file counts as added and `reviewed` is absent.
 */
import type { CoveredPage } from "./pages.ts";
import { matchMoves, moveCandidates, type FileMove } from "./moves.ts";
import type { ReviewLock } from "./lock.ts";

/** How a covered file differs from the lock. */
export type FileChangeKind = "changed" | "removed" | "added";

/** One covered file that differs from the lock. */
export interface FileChange {
  readonly path: string;
  readonly change: FileChangeKind;
}

/** One stale page. */
export interface StalePage {
  /** Source path relative to the site root. */
  readonly page: string;
  /** The date of the last review; absent when the page was never marked. */
  readonly reviewed?: string;
  /** The files that differ, sorted by path. */
  readonly files: readonly FileChange[];
  /** What to do about it. */
  readonly fix: string;
}

/** A covered file that moved: the page's `covers` should name the new path. */
export interface PageMove extends FileMove {
  /** Source path of the page. */
  readonly page: string;
}

/** What `mizzen stale --json` prints. */
export interface StaleReport {
  readonly version: 1;
  /** Stale pages sorted by page. Empty when every page is current. */
  readonly pages: readonly StalePage[];
  /** Covered files that moved without a change; they do not make a page stale. */
  readonly moves: readonly PageMove[];
}

/** The hint for a page. */
export function fixHint(page: string): string {
  return `Read ${page} against these files and update it, then run \`mizzen stale mark ${page}\`.`;
}

/** The stale pages among `pages`, compared with `lock`. */
export function compareToLock(pages: readonly CoveredPage[], lock: ReviewLock): StalePage[] {
  const out: StalePage[] = [];
  for (const page of pages) {
    const locked = lock.pages[page.page];
    const before = new Map((locked?.files ?? []).map((f) => [f.path, f.sha256]));
    const now = new Map(page.files.map((f) => [f.path, f.sha256]));
    const files: FileChange[] = [];
    for (const [path, hash] of now) {
      const old = before.get(path);
      if (old === undefined) files.push({ path, change: "added" });
      else if (old !== hash) files.push({ path, change: "changed" });
    }
    for (const path of before.keys()) if (!now.has(path)) files.push({ path, change: "removed" });
    if (files.length === 0) continue;
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    out.push({ page: page.page, ...(locked === undefined ? {} : { reviewed: locked.reviewed }), files, fix: fixHint(page.page) });
  }
  return out;
}

/**
 * Moves removed files out of the stale list when the same content now sits at one other path under the covers root.
 * A page left with no other change is no longer stale; a page that keeps other changes stays, with the new path in its
 * hint.
 */
export async function applyMoves(
  stale: readonly StalePage[],
  lock: ReviewLock,
  coversRoot: string,
): Promise<{ readonly pages: StalePage[]; readonly moves: PageMove[] }> {
  if (!stale.some((p) => p.files.some((f) => f.change === "removed"))) return { pages: [...stale], moves: [] };
  const everyLocked = new Set<string>();
  for (const entry of Object.values(lock.pages)) for (const f of entry.files) everyLocked.add(f.path);
  const candidates = await moveCandidates(coversRoot, everyLocked);
  const pages: StalePage[] = [];
  const moves: PageMove[] = [];
  for (const page of stale) {
    const locked = new Map((lock.pages[page.page]?.files ?? []).map((f) => [f.path, f]));
    const removed = page.files.filter((f) => f.change === "removed").map((f) => locked.get(f.path)!);
    const found = matchMoves(removed, candidates);
    for (const m of found) moves.push({ page: page.page, ...m });
    const gone = new Set(found.map((m) => m.from));
    const files = page.files.filter((f) => !gone.has(f.path));
    if (files.length === 0) continue;
    const hint = found.length === 0 ? page.fix : `${page.fix} Moved: ${found.map((m) => `${m.from} -> ${m.to}`).join(", ")}; update \`covers\` to the new path.`;
    pages.push({ ...page, files, fix: hint });
  }
  return { pages, moves };
}

/** The machine-readable report, as text. */
export function formatStaleJson(pages: readonly StalePage[], moves: readonly PageMove[] = []): string {
  const report: StaleReport = { version: 1, pages, moves };
  return JSON.stringify(report, null, 2);
}

/** The human report, one block per stale page; a clean site prints one line. */
export function formatStaleText(pages: readonly StalePage[], moves: readonly PageMove[] = []): string {
  const moved = moves.map((m) => `${m.page}: ${m.from} moved to ${m.to}; update \`covers\` to the new path.`);
  if (pages.length === 0) return ["No stale pages.", ...moved].join("\n");
  const blocks = pages.map((p) => {
    const head = p.reviewed === undefined ? `${p.page} (never reviewed)` : `${p.page} (reviewed ${p.reviewed})`;
    const lines = p.files.map((f) => `  ${f.change.padEnd(7)} ${f.path}`);
    return [head, ...lines, `  fix: ${p.fix}`].join("\n");
  });
  return `${blocks.join("\n\n")}\n\n${[...moved, `${pages.length} stale page${pages.length === 1 ? "" : "s"}.`].join("\n")}`;
}
