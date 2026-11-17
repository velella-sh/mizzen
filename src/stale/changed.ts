/**
 * Maps changed files to the pages that cover them, for a pull request comment or an agent: which pages might need an
 * update because of this change. Patterns are matched against the changed paths directly, so a deleted file still finds
 * its pages. Nothing is hashed and the lock is not read.
 *
 * `gitChangedFiles` asks the local repository only: `git diff --name-only` against a base that is already in it. It
 * never fetches and never touches a remote.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { globToRegExp } from "./covers.ts";
import type { CoveredPage } from "./pages.ts";

/** One page and the changed files it covers. */
export interface TouchedPage {
  readonly page: string;
  /** Changed files the page covers, sorted. */
  readonly files: readonly string[];
}

/** Normalizes a changed path: `/` separators, no leading `./`. */
export function normalizeChanged(path: string): string {
  return path.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
}

/** The pages whose `covers` match a changed file, sorted by page. */
export function pagesTouchedBy(pages: readonly CoveredPage[], changed: readonly string[]): TouchedPage[] {
  const files = [...new Set(changed.map(normalizeChanged))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const out: TouchedPage[] = [];
  for (const page of pages) {
    const matchers = page.covers.map((c) => globToRegExp(normalizeChanged(c)));
    const hit = files.filter((f) => matchers.some((re) => re.test(f)));
    if (hit.length > 0) out.push({ page: page.page, files: hit });
  }
  return out;
}

/** Files that differ from `base` in the repository around `dir`, relative to `dir`. Throws a readable error when git cannot say. */
export async function gitChangedFiles(dir: string, base: string): Promise<string[]> {
  if (base === "" || base.startsWith("-")) throw new Error(`"${base}" is not a git ref.`);
  try {
    const { stdout } = await promisify(execFile)("git", ["-C", dir, "diff", "--name-only", "--relative", "-z", base, "--"], {
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.split("\0").filter((f) => f !== "");
  } catch (err) {
    const detail = err instanceof Error ? err.message.split("\n")[0] : String(err);
    throw new Error(`git cannot compare with "${base}": ${detail}`);
  }
}
