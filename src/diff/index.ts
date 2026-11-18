/**
 * `diffBuilds(a, b)`: the report of how built folder `b` differs from built folder `a`.
 *
 * A pure function of the two folders' bytes: no clock, no environment, no network, and no rebuild. It reads both
 * manifests, answers "identical" at once when the build hashes agree, and otherwise opens only the files of the pages
 * whose hashes differ. Every list in the report is sorted, so the same two builds give the same report bytes.
 */
import { readBuild, type Build } from "./builds.ts";
import { changedPage } from "./blocks.ts";
import { compareFiles } from "./files.ts";
import { findMoves } from "./moves.ts";
import { comparePages } from "./pages.ts";
import { compareRecords } from "./records.ts";
import { Reader } from "./reader.ts";
import type { PageRef, SiteDiff } from "./types.ts";

export { DiffUsageError } from "./builds.ts";
export type { SiteDiff } from "./types.ts";

function ref(page: { readonly url: string; readonly source: string; readonly title: string }): PageRef {
  return { url: page.url, source: page.source, title: page.title };
}

/** An empty report for two builds with one hash. */
function identical(hash: string): SiteDiff {
  return {
    schemaVersion: 1,
    version: 1,
    base: { hash },
    head: { hash },
    identical: true,
    summary: {
      pages: { added: 0, removed: 0, changed: 0, moved: 0 },
      files: { added: 0, removed: 0, changed: 0 },
      records: { added: 0, removed: 0, changed: 0 },
      brokenUrls: 0,
      renderOnly: 0,
    },
    pages: { added: [], removed: [], changed: [], moved: [] },
    brokenUrls: [],
    files: { added: [], removed: [], changed: [] },
    records: [],
  };
}

/** Compares two already-read builds. `reader` is shared so a caller can count what was opened. */
export async function diffReadBuilds(base: Build, head: Build, reader: Reader = new Reader()): Promise<SiteDiff> {
  if (base.hash === head.hash) return identical(base.hash);

  const pages = comparePages(base, head);
  const moves = await findMoves(base, head, pages.removed, pages.added, reader);
  const changed = [];
  for (const delta of pages.changed) changed.push(await changedPage(base, head, delta, reader));
  const files = await compareFiles(base, head, reader);
  const records = await compareRecords(base, head, pages.changed, moves.added, moves.removed, reader);

  const sum = (pick: (collection: SiteDiff["records"][number]) => number): number => records.reduce((total, collection) => total + pick(collection), 0);
  return {
    schemaVersion: 1,
    version: 1,
    base: { hash: base.hash },
    head: { hash: head.hash },
    identical: false,
    summary: {
      pages: { added: moves.added.length, removed: moves.removed.length, changed: changed.length, moved: moves.moved.length },
      files: { added: files.added.length, removed: files.removed.length, changed: files.changed.length },
      records: { added: sum((c) => c.added.length), removed: sum((c) => c.removed.length), changed: sum((c) => c.changed.length) },
      brokenUrls: moves.broken.length,
      renderOnly: changed.filter((page) => page.renderOnly).length,
    },
    pages: { added: moves.added.map(ref), removed: moves.removed.map(ref), changed, moved: moves.moved },
    brokenUrls: moves.broken,
    files,
    records,
  };
}

/** Reads both folders' manifests and compares them. Throws a `DiffUsageError` for a folder without a manifest. */
export async function diffBuilds(baseDir: string, headDir: string): Promise<SiteDiff> {
  const [base, head] = await Promise.all([readBuild(baseDir, baseDir), readBuild(headDir, headDir)]);
  return diffReadBuilds(base, head);
}
