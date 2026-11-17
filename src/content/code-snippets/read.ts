import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Diagnostic, SourcePos } from "../../contracts/index.ts";

/**
 * Reads one source file under the site's source folder, and one 1-based inclusive range of its lines.
 *
 * The path is relative to `sourceDir` and may never leave it — not lexically and not through a symbolic link: the
 * root and the target are resolved to real paths before anything is read, and the read itself uses the real path.
 * A failure is a diagnostic rather than an exception, so a snippet that cannot be read never fails the build with a
 * stack trace. The caller passes the insertion point's `pos`, which every diagnostic copies.
 */

/** A 1-based inclusive range of lines. */
export interface LineRange {
  readonly start: number;
  readonly end: number;
}

/** What {@link readSourceRange} reads. */
export interface ReadSourceOptions {
  /** Absolute path of the site's source folder; the file may not resolve outside it. */
  readonly sourceDir: string;
  /** Path of the file, relative to `sourceDir`, `/`-separated. */
  readonly path: string;
  /** `2-10` or `4`; the whole file when omitted. */
  readonly lines?: string;
  /** Where the snippet is inserted, so a diagnostic points at the reference rather than the source. */
  readonly pos?: SourcePos;
}

/** The lines read from one source file. */
export interface SourceSnippet {
  /** Path of the file, relative to `sourceDir`, `/`-separated. */
  readonly file: string;
  /** 1-based line of the first line in {@link SourceSnippet.text}. */
  readonly start: number;
  /** 1-based line of the last line in {@link SourceSnippet.text}, inclusive. */
  readonly end: number;
  /** The selected lines, each with its own line ending. */
  readonly text: string;
}

/** What {@link readSourceRange} returns. */
export interface ReadSourceResult {
  /** The lines, absent when a diagnostic explains why they could not be read. */
  readonly snippet?: SourceSnippet;
  /** One finding when the range could not be read; empty on success. */
  readonly diagnostics: readonly Diagnostic[];
}

/** `2-10` or `4` as a line range; `undefined` when it is not one. */
export function parseLineRange(text: string): LineRange | undefined {
  const match = /^(\d+)(?:-(\d+))?$/.exec(text.trim());
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = match[2] === undefined ? start : Number(match[2]);
  if (start < 1 || end < start) return undefined;
  // A range that large would never fit a file; refuse early rather than overflow a number.
  if (end > Number.MAX_SAFE_INTEGER) return undefined;
  return { start, end };
}

/** True when `against`, a `relative()` result against a root, leaves that root. */
export function escapes(against: string): boolean {
  return against === "" || against === ".." || against.startsWith(`..${sep}`) || isAbsolute(against);
}

/** The real path {@link canonicalize} answers with, plus whether the path itself exists. */
export interface Canonical {
  /** Real path, with symbolic links resolved. */
  readonly real: string;
  /** False when the path does not exist, or when the filesystem could not be asked at all. */
  readonly exists: boolean;
}

/**
 * The real path of an absolute `path`, resolving every symbolic link on it, which is what makes the source
 * boundary hold for the file that would actually be read rather than for the spelling of the reference.
 *
 * Components that do not exist yet are re-joined onto the real path of the nearest ancestor that does, so a
 * missing file behind a symlink is still located where its link points. A lookup that fails for another reason
 * (a loop, a permission the operating system refuses) answers with the lexical path and `exists: false`; the read
 * that follows then reports the operating system's own error, exactly as it did before, and cannot succeed
 * either, because reading needs the same permission on every component.
 */
export async function canonicalize(path: string): Promise<Canonical> {
  const missing: string[] = [];
  let current = path;
  for (;;) {
    try {
      const real = await realpath(current);
      if (missing.length === 0) return { real, exists: true };
      const rest = missing.slice().reverse();
      return { real: resolve(real, ...rest), exists: false };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const parent = dirname(current);
      if ((code !== "ENOENT" && code !== "ENOTDIR" && code !== "ELOOP") || parent === current) {
        return { real: path, exists: false };
      }
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

/** A finding that fails the build, with the insertion point when the caller gave one. */
function problem(id: string, message: string, pos: SourcePos | undefined, help?: string): Diagnostic {
  return { id, severity: "error", message, ...(pos === undefined ? {} : { pos }), ...(help === undefined ? {} : { help }) };
}

/** The path shown in messages and returned to the caller: source-relative, `/`-separated. */
function sourcePath(inside: string): string {
  return inside.split(sep).join("/");
}

/**
 * Reads `lines` of the file at `path` under `sourceDir`. A missing file, a malformed or out-of-file range, an
 * unreadable file, and a path that leaves the source folder each answer with one `error` diagnostic and no lines.
 */
export async function readSourceRange(options: ReadSourceOptions): Promise<ReadSourceResult> {
  const diagnostics: Diagnostic[] = [];
  const fail = (id: string, message: string, help: string): ReadSourceResult => {
    diagnostics.push(problem(id, message, options.pos, help));
    return { diagnostics };
  };

  const path = options.path.trim();
  if (path === "") {
    return fail("snippet.no-path", "A code snippet names no file.", "Name a file relative to the source folder.");
  }

  const rangeText = options.lines;
  let range: LineRange | undefined;
  if (rangeText !== undefined) {
    range = parseLineRange(rangeText);
    if (range === undefined) {
      return fail(
        "snippet.invalid-lines",
        `\`lines=${rangeText}\` is not a line range.`,
        "Write `lines=2-10` for the 1-based inclusive range, or `lines=4` for one line.",
      );
    }
  }

  const sourceDir = resolve(options.sourceDir);
  const inside = relative(sourceDir, resolve(sourceDir, path));
  if (escapes(inside)) {
    return fail(
      "snippet.outside-source",
      `The source snippet ${path} is outside the source folder.`,
      "A snippet may only read files under the source folder; move the file there or change the path.",
    );
  }
  const file = sourcePath(inside);

  // The lexical path is only the first gate: a symbolic link inside the source folder can name a file outside it,
  // so the boundary is checked again against the real path the read would follow, and the read uses that path.
  const target = await canonicalize(resolve(sourceDir, path));
  const realSourceDir = (await canonicalize(sourceDir)).real;
  if (escapes(relative(realSourceDir, target.real))) {
    return fail(
      "snippet.outside-source",
      `The source snippet ${path} leads outside the source folder through a symbolic link.`,
      "A snippet may only read files under the source folder; point the link at a file inside it, or move the file there.",
    );
  }

  let text: string;
  try {
    text = await readFile(target.real, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return fail(
        "snippet.missing",
        `The source snippet ${path} does not exist (looked for ${file}).`,
        "Create the file, or fix the path relative to the source folder.",
      );
    }
    return fail(
      "snippet.unreadable",
      `The source snippet ${path} cannot be read: ${(error as Error).message}`,
      "Check the file's permissions and that it is a file, not a folder.",
    );
  }

  const all = text === "" ? [] : text.split(/(?<=\n)/);
  if (range !== undefined && (range.start > all.length || range.end > all.length)) {
    return fail(
      "snippet.lines-out-of-range",
      `\`lines=${rangeText}\` is outside ${file}, which has ${all.length} line${all.length === 1 ? "" : "s"}.`,
      "Name a range that fits the file, counting its first line as 1.",
    );
  }
  const start = range?.start ?? 1;
  const end = range?.end ?? all.length;
  return {
    snippet: { file, start, end, text: all.slice(start - 1, end).join("") },
    diagnostics,
  };
}
