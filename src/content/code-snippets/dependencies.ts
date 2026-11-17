/**
 * The files a code snippet may read.
 *
 * A snippet reads through `readSourceRange`, whose only rule is the source-folder boundary: any file under the
 * source folder can be its source, including one inside a folder discovery skips. Discovery's list is what the cache
 * key hashes today, so a change to a skipped source would otherwise leave the whole-build cache looking current.
 * This names the files discovery did not, and the cache key hashes them, so an edited, moved, or deleted source
 * misses the cache and the pages that render it are built again.
 */
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

/** What {@link snippetSources} needs. */
export interface SnippetSourcesOptions {
  /** Absolute source folder. */
  readonly sourceDir: string;
  /** Absolute files or folders to leave out, such as a build output inside the source folder. */
  readonly skip?: readonly string[];
}

/**
 * Folders that hold dependencies, the site's cache, or build output rather than content. Nothing here is a snippet
 * source: a file a snippet reads from one of them is either a package (outside the contract) or generated.
 */
const SKIP_DIRS = new Set(["node_modules", ".git", ".mizzen", "dist"]);

/** Lock files are build bookkeeping, not content, so writing one never misses the cache. */
function isLockFile(name: string): boolean {
  return name === "mizzen.lock.json" || name.endsWith(".lock.json");
}

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Every file under `sourceDir` that discovery cannot list, sorted and `/`-separated.
 *
 * Directories are walked but symbolic links are not followed: a snippet's read resolves a link and refuses one that
 * leaves the folder, and a link inside the folder points at a file this walk already finds. A missing source folder
 * has no files.
 */
export async function snippetSources(options: SnippetSourcesOptions): Promise<string[]> {
  const root = resolve(options.sourceDir);
  const skip = new Set((options.skip ?? []).map((path) => resolve(path)));
  const found: string[] = [];

  async function walk(dir: string, rel: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
      const abs = join(dir, entry.name);
      if (skip.has(abs)) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(abs, path);
      } else if (entry.isFile()) {
        if (isLockFile(entry.name)) continue;
        found.push(path);
      }
    }
  }

  await walk(root, "");
  return found.sort(byCodePoint);
}
