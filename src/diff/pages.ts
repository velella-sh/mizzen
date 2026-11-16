/**
 * Compares the pages of two builds by their manifests: which URLs were added, removed, or changed.
 *
 * A page is changed when its manifest entry differs or any file it writes has another hash. Nothing is read from disk
 * here: the manifests carry every hash, so equal builds are answered at once and only the pages that differ are
 * looked at again by the steps that follow.
 */
import type { Build, BuildPage } from "./builds.ts";
import type { PageChange } from "./types.ts";

/** A page present in both builds with at least one difference. */
export interface PageDelta {
  readonly base: BuildPage;
  readonly head: BuildPage;
  /** What differs, in report order. */
  readonly changes: readonly PageChange[];
}

/** The page lists of one comparison; every list is sorted by URL. */
export interface PageComparison {
  readonly added: readonly BuildPage[];
  readonly removed: readonly BuildPage[];
  readonly changed: readonly PageDelta[];
}

/** The page's Markdown twin among its outputs, if it writes one. */
export function twinOf(page: BuildPage): string | undefined {
  return page.outputs.find((path) => path.endsWith(".md"));
}

/** The page's HTML file among its outputs, if it writes one. */
export function htmlOf(page: BuildPage): string | undefined {
  return page.outputs.find((path) => /\.html?$/i.test(path));
}

/** The page's JSON file: the HTML file's name with `.json`, when the build wrote it. */
export function jsonOf(page: BuildPage, build: Build): string | undefined {
  const html = htmlOf(page);
  if (html === undefined) return undefined;
  const path = html.replace(/\.html?$/i, ".json");
  return build.files[path] === undefined ? undefined : path;
}

/** Whether any file the page writes has another hash in the second build. */
function fileChanged(base: Build, head: Build, path: string | undefined): boolean {
  return path !== undefined && base.files[path] !== head.files[path];
}

/** What differs between one page's two entries, in report order. */
function changesOf(base: Build, head: Build, before: BuildPage, after: BuildPage): PageChange[] {
  const changes: PageChange[] = [];
  if (before.source !== after.source) changes.push("source");
  if (before.title !== after.title) changes.push("title");
  if (before.layout !== after.layout) changes.push("layout");
  const twinBefore = twinOf(before);
  const twinAfter = twinOf(after);
  if (before.hashes.source !== after.hashes.source || (twinBefore === twinAfter && fileChanged(base, head, twinAfter))) {
    changes.push("text");
  }
  const htmlBefore = htmlOf(before);
  const htmlAfter = htmlOf(after);
  if (
    before.hashes.html !== after.hashes.html ||
    (htmlBefore === htmlAfter && fileChanged(base, head, htmlAfter)) ||
    // A page may change its set of files without changing its text.
    before.outputs.join("\n") !== after.outputs.join("\n")
  ) {
    changes.push("html");
  }
  return changes;
}

/** Lists the pages added, removed, and changed between two builds. */
export function comparePages(base: Build, head: Build): PageComparison {
  const before = new Map(base.pages.map((page) => [page.url, page]));
  const after = new Map(head.pages.map((page) => [page.url, page]));
  const added = head.pages.filter((page) => !before.has(page.url));
  const removed = base.pages.filter((page) => !after.has(page.url));
  const changed: PageDelta[] = [];
  for (const page of head.pages) {
    const old = before.get(page.url);
    if (old === undefined) continue;
    const changes = changesOf(base, head, old, page);
    if (changes.length > 0) changed.push({ base: old, head: page, changes });
  }
  return { added, removed, changed };
}
