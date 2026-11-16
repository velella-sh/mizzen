/**
 * Summarizes the files that are not pages: added, removed, and changed, grouped by output name.
 *
 * A page's own files (its HTML, Markdown twin, JSON, and agent file) belong to the page lists. An asset whose name
 * carries a content hash (`base-0123456789abcdef.css`) is the same file when only the hash differs, so a rebuilt
 * stylesheet is one change, not a removal and an addition. The sizes of CSS, JavaScript, and search files are read
 * from disk for the files that changed only.
 */
import type { Build } from "./builds.ts";
import { byCodePoint } from "./builds.ts";
import type { Reader } from "./reader.ts";
import type { ChangedFile, FileRef } from "./types.ts";

export interface FileComparison {
  readonly added: readonly FileRef[];
  readonly removed: readonly FileRef[];
  readonly changed: readonly ChangedFile[];
}

/** A hash a build puts in a file name: 8 to 64 lowercase hex characters before the extension. */
const HASHED = /^(.*[-.])[0-9a-f]{8,64}(\.[A-Za-z0-9]+)$/u;

/** The file's path without a content hash in its name. */
export function unhashed(path: string): string {
  const slash = path.lastIndexOf("/") + 1;
  const match = HASHED.exec(path.slice(slash));
  if (match === null) return path;
  const stem = (match[1] ?? "").replace(/[-.]$/u, "");
  return stem === "" ? path : `${path.slice(0, slash)}${stem}${match[2] ?? ""}`;
}

/** The output a file belongs to: its first folder, or its own name at the top level. */
export function groupOf(path: string): string {
  const slash = path.indexOf("/");
  return slash === -1 ? path : path.slice(0, slash);
}

/** Whether a file's size is worth reporting: CSS, JavaScript, and the search index. */
function sized(path: string): boolean {
  return /\.(css|m?js)$/iu.test(path) || path.startsWith("pagefind/");
}

/** Paths that belong to pages: what each writes, and the JSON and agent files beside its HTML. */
function pageFiles(...builds: readonly Build[]): Set<string> {
  const owned = new Set<string>();
  for (const build of builds) {
    for (const page of build.pages) {
      for (const output of page.outputs) {
        owned.add(output);
        if (/\.html?$/iu.test(output)) {
          owned.add(output.replace(/\.html?$/iu, ".json"));
          owned.add(output.replace(/[^/]*$/u, "agent.json"));
        }
      }
    }
  }
  return owned;
}

/** A build's non-page files by logical name. A name two files share keeps its full path, so no file hides another. */
function namedFiles(build: Build, owned: ReadonlySet<string>): Map<string, string> {
  const counts = new Map<string, number>();
  const paths = Object.keys(build.files).filter((path) => !owned.has(path)).sort(byCodePoint);
  for (const path of paths) counts.set(unhashed(path), (counts.get(unhashed(path)) ?? 0) + 1);
  const named = new Map<string, string>();
  for (const path of paths) named.set(counts.get(unhashed(path)) === 1 ? unhashed(path) : path, path);
  return named;
}

/** Compares the non-page files of two builds. */
export async function compareFiles(base: Build, head: Build, reader: Reader): Promise<FileComparison> {
  const owned = pageFiles(base, head);
  const before = namedFiles(base, owned);
  const after = namedFiles(head, owned);
  const names = [...new Set([...before.keys(), ...after.keys()])].sort(byCodePoint);

  const added: FileRef[] = [];
  const removed: FileRef[] = [];
  const changed: ChangedFile[] = [];
  for (const name of names) {
    const was = before.get(name);
    const now = after.get(name);
    if (was === undefined && now !== undefined) {
      const size = sized(now) ? await reader.size(head, now) : undefined;
      added.push({ name, group: groupOf(name), ...(size === undefined ? {} : { size }) });
    } else if (was !== undefined && now === undefined) {
      const size = sized(was) ? await reader.size(base, was) : undefined;
      removed.push({ name, group: groupOf(name), ...(size === undefined ? {} : { size }) });
    } else if (was !== undefined && now !== undefined && base.files[was] !== head.files[now]) {
      const [beforeSize, afterSize] = sized(now) ? await Promise.all([reader.size(base, was), reader.size(head, now)]) : [];
      changed.push({
        name,
        group: groupOf(name),
        path: now,
        ...(beforeSize === undefined || afterSize === undefined ? {} : { size: { before: beforeSize, after: afterSize } }),
      });
    }
  }
  return { added, removed, changed };
}
