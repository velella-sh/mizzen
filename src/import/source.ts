/**
 * Reads a source project into the shape an importer receives: every regular file below the root, in code-point order.
 * Hidden folders are read because a framework's config often lives in one (`.vitepress`), while `.git` and
 * `node_modules` are not input.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { ImportSource } from "./contract.ts";

const SKIP = new Set([".git", "node_modules"]);

/** Compares by code point, never by locale, so two runs list the same files. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function walk(dir: string, prefix: string, out: string[]): void {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => byCodePoint(a.name, b.name));
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) walk(join(dir, entry.name), path, out);
    else if (entry.isFile()) out.push(path);
  }
}

/** The absolute path of one source file, refused when it leaves the source root. */
function inside(root: string, path: string): string {
  const absolute = resolve(root, path);
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
    throw new Error(`the importer asked for ${path}, which is outside the source folder`);
  }
  return absolute;
}

/** Reads every file under `root` once and hands the importer the same list every time. */
export function readImportSource(root: string): ImportSource {
  const absoluteRoot = resolve(root);
  const files: string[] = [];
  walk(absoluteRoot, "", files);
  return {
    root: absoluteRoot,
    files,
    read: (path) => readFileSync(inside(absoluteRoot, path), "utf8"),
    bytes: (path) => readFileSync(inside(absoluteRoot, path)),
  };
}

/** `path` relative to `root`, using `/`, for a report that names where a file came from. */
export function sourcePath(root: string, path: string): string {
  return relative(root, resolve(root, path)).replace(/\\/g, "/");
}
