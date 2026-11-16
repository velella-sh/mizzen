/**
 * `covers`: the files a page describes. A list of paths and globs relative to `stale.root`; this module expands them
 * to the files they name, in sorted order, and reports what cannot be used.
 *
 * Globs support `*` (within one folder), `**` (any number of folders), and `?`. The walk never follows a symbolic
 * link, so a link inside the root cannot lead out of it, and it skips `.git` and `node_modules`. A pattern that
 * matches nothing is `stale.covers-empty`; a path that resolves outside the root is `stale.covers-outside-root`; a
 * value that is not a list of non-empty strings is `stale.covers-invalid`. Each is reported at the `covers` key's line.
 */
import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Diagnostic } from "../contracts/index.ts";

/** Folders the walk skips. */
const SKIPPED = new Set([".git", "node_modules"]);

/** What {@link expandCovers} takes. */
export interface ExpandCoversOptions {
  /** The page's `covers` value as the front matter holds it. */
  readonly covers: unknown;
  /** The folder the patterns are relative to: `stale.root`, as an absolute path. */
  readonly root: string;
  /** The page's source file, for diagnostics. */
  readonly file: string;
  /** 1-based line of the `covers` key in `file`. Default `1`. */
  readonly line?: number;
}

/** What {@link expandCovers} returns. */
export interface ExpandedCovers {
  /** Covered files as `/`-separated paths relative to the root, sorted, without duplicates. */
  readonly files: readonly string[];
  /** Problems found, in the order of the patterns. */
  readonly diagnostics: readonly Diagnostic[];
}

/** True when the pattern holds a glob character. */
function isGlob(pattern: string): boolean {
  return /[*?]/.test(pattern);
}

/** The regular expression for a glob, matched against a whole `/`-separated path. */
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          out += "(?:.*/)?";
        } else out += ".*";
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/** Every regular file under `dir`, as `/`-separated paths relative to `root`, without following links. */
async function walk(root: string, dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED.has(entry.name)) await walk(root, full, out);
    } else if (entry.isFile()) out.push(relative(root, full).split(sep).join("/"));
  }
}

/** Every regular file under `root`, sorted, as `/`-separated relative paths; links are not followed and `.git` and `node_modules` are skipped. */
export async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  await walk(root, root, out);
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Expands a page's `covers` to the files it names. */
export async function expandCovers(options: ExpandCoversOptions): Promise<ExpandedCovers> {
  const line = options.line ?? 1;
  const pos = { file: options.file, line, column: 1, endLine: line, endColumn: 1 };
  const diagnostics: Diagnostic[] = [];
  const { covers } = options;
  if (!Array.isArray(covers) || covers.some((p) => typeof p !== "string" || p.trim() === "")) {
    return {
      files: [],
      diagnostics: [
        {
          id: "stale.covers-invalid",
          severity: "error",
          message: "`covers` must be a list of paths and globs.",
          pos,
          help: "Write `covers: [src/config/load.ts, schema/*.json]`.",
        },
      ],
    };
  }

  const root = resolve(options.root);
  const found = new Set<string>();
  let all: string[] | undefined;
  for (const raw of covers as string[]) {
    const pattern = raw.trim();
    const normalized = pattern.replace(/\\/g, "/");
    const target = resolve(root, normalized);
    const rel = relative(root, target);
    if (isAbsolute(pattern) || rel === ".." || rel.startsWith(`..${sep}`)) {
      diagnostics.push({
        id: "stale.covers-outside-root",
        severity: "error",
        message: `"${pattern}" points outside the covers root.`,
        pos,
        help: "Use a path inside `stale.root`.",
      });
      continue;
    }
    if (isGlob(normalized)) {
      if (all === undefined) {
        all = [];
        await walk(root, root, all);
      }
      const re = globToRegExp(rel.split(sep).join("/"));
      const matches = all.filter((f) => re.test(f));
      if (matches.length === 0) diagnostics.push(emptyMatch(pattern, pos));
      for (const m of matches) found.add(m);
      continue;
    }
    let isFile = false;
    try {
      isFile = (await lstat(target)).isFile();
    } catch {
      isFile = false;
    }
    if (isFile) found.add(rel.split(sep).join("/"));
    else diagnostics.push(emptyMatch(pattern, pos));
  }
  const files = [...found].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { files, diagnostics };
}

function emptyMatch(pattern: string, pos: NonNullable<Diagnostic["pos"]>): Diagnostic {
  return {
    id: "stale.covers-empty",
    severity: "warning",
    message: `"${pattern}" matches no file.`,
    pos,
    help: "Fix the path or glob, or remove it from `covers`.",
  };
}

/** The 1-based line of the `covers` key in a page's source text, or `1` when it is not at the top level of the front matter. */
export function coversLine(sourceText: string): number {
  const lines = sourceText.split(/\r?\n/);
  if (lines[0] !== "---") return 1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") break;
    if (/^covers\s*:/.test(lines[i]!)) return i + 1;
  }
  return 1;
}
