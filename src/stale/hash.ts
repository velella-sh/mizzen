/**
 * Hashes covered files for the review lock. A file's hash is the SHA-256 of its bytes after `\r\n` becomes `\n`, so a
 * checkout on any platform gives one hash. A file with a NUL byte is binary and is hashed as it is. The modification
 * time is never read, and the result is in a fixed order: sorted by path.
 *
 * The number of files per page and the size of each are bounded; going over either is `stale.covers-limit`, and the
 * file left out is not hashed, so it never looks reviewed.
 */
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Diagnostic } from "../contracts/index.ts";

/** Most files one page may cover. */
export const MAX_COVERED_FILES = 200;

/** Largest covered file, in bytes. */
export const MAX_COVERED_BYTES = 2 * 1024 * 1024;

/** One covered file and its hash. */
export interface FileHash {
  /** `/`-separated path relative to the covers root. */
  readonly path: string;
  /** SHA-256 of the normalized content, as 64 lowercase hex characters. */
  readonly sha256: string;
}

/** Options of {@link hashFiles}. */
export interface HashOptions {
  /** Absolute covers root. */
  readonly root: string;
  /** The page's source file, for diagnostics. */
  readonly file: string;
  /** Override of {@link MAX_COVERED_FILES}. */
  readonly maxFiles?: number;
  /** Override of {@link MAX_COVERED_BYTES}. */
  readonly maxBytes?: number;
}

/** SHA-256 of a file's bytes with `\r\n` normalized to `\n`, unless the content is binary. */
export function hashContent(bytes: Uint8Array): string {
  const buf = Buffer.from(bytes);
  const content = buf.includes(0) ? buf : Buffer.from(buf.toString("latin1").replace(/\r\n/g, "\n"), "latin1");
  return createHash("sha256").update(content).digest("hex");
}

/** Hashes `paths` (relative to the root) in sorted order; a file that is missing, not regular, or over a bound is reported and left out. */
export async function hashFiles(
  paths: readonly string[],
  options: HashOptions,
): Promise<{ readonly hashes: readonly FileHash[]; readonly diagnostics: readonly Diagnostic[] }> {
  const maxFiles = options.maxFiles ?? MAX_COVERED_FILES;
  const maxBytes = options.maxBytes ?? MAX_COVERED_BYTES;
  const pos = { file: options.file, line: 1, column: 1, endLine: 1, endColumn: 1 };
  const diagnostics: Diagnostic[] = [];
  const hashes: FileHash[] = [];
  const sorted = [...new Set(paths)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (sorted.length > maxFiles) {
    diagnostics.push({
      id: "stale.covers-limit",
      severity: "error",
      message: `The page covers ${sorted.length} files; the limit is ${maxFiles}.`,
      pos,
      help: "Cover fewer files, or split the page.",
    });
  }
  for (const path of sorted.slice(0, maxFiles)) {
    const full = resolve(options.root, path);
    try {
      const info = await lstat(full);
      if (!info.isFile()) throw new Error("not a regular file");
      if (info.size > maxBytes) {
        diagnostics.push({
          id: "stale.covers-limit",
          severity: "error",
          message: `"${path}" is ${info.size} bytes; the limit is ${maxBytes}.`,
          pos,
          help: "Cover a smaller file.",
        });
        continue;
      }
      hashes.push({ path, sha256: hashContent(await readFile(full)) });
    } catch {
      diagnostics.push({
        id: "stale.covers-unreadable",
        severity: "warning",
        message: `"${path}" cannot be read.`,
        pos,
      });
    }
  }
  return { hashes, diagnostics };
}
