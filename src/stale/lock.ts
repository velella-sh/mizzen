/**
 * `docs-review.lock.json`: for each page that names the files it describes, those files' hashes and the date the
 * page was last marked as reviewed. It is committed, so a pull request shows what was marked and when.
 *
 * The file is canonical: keys sorted at every level, files sorted by path, LF line ends, one trailing line feed, so
 * the same input always writes the same bytes. The date is the commit date of `HEAD` or the caller's `--date`; the
 * system clock is never read. The file is validated against `schema/docs-review.schema.json` on every read; a missing
 * file is an empty lock, and a malformed one is an empty lock with a `stale.lock-invalid` error.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import type { Diagnostic } from "../contracts/index.ts";
import { canonicalJson } from "../data/lock.ts";
import type { FileHash } from "./hash.ts";

/** The lock file name at a site root. */
export const REVIEW_LOCK_FILE = "docs-review.lock.json";

/** One page's record. */
export interface LockedPage {
  /** `YYYY-MM-DD` of the review. */
  readonly reviewed: string;
  /** The covered files, sorted by path. */
  readonly files: readonly FileHash[];
}

/** The whole lock. */
export interface ReviewLock {
  readonly version: 1;
  /** Pages by source path relative to the site root. */
  readonly pages: Readonly<Record<string, LockedPage>>;
}

/** An empty lock. */
export function emptyReviewLock(): ReviewLock {
  return { version: 1, pages: {} };
}

const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;
const schema = JSON.parse(readFileSync(new URL("../../schema/docs-review.schema.json", import.meta.url), "utf8")) as object;
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

/** True when `value` is a lock this version may trust. */
export function isReviewLock(value: unknown): value is ReviewLock {
  return validate(value);
}

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The lock file's text: canonical JSON, files sorted, and one trailing line feed. */
export function reviewLockText(lock: ReviewLock): string {
  const pages: Record<string, LockedPage> = {};
  for (const page of Object.keys(lock.pages).sort(byCodePoint)) {
    const entry = lock.pages[page]!;
    pages[page] = {
      reviewed: entry.reviewed,
      files: [...entry.files].sort((a, b) => byCodePoint(a.path, b.path)).map((f) => ({ path: f.path, sha256: f.sha256 })),
    };
  }
  return `${canonicalJson({ version: lock.version, pages })}\n`;
}

/** Reads the lock at `root`. */
export async function readReviewLock(root: string): Promise<{ readonly lock: ReviewLock; readonly diagnostics: readonly Diagnostic[] }> {
  let text: string;
  try {
    text = await readFile(join(root, REVIEW_LOCK_FILE), "utf8");
  } catch {
    return { lock: emptyReviewLock(), diagnostics: [] };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { lock: emptyReviewLock(), diagnostics: [invalid(`${REVIEW_LOCK_FILE} is not valid JSON: ${detail}`)] };
  }
  if (!isReviewLock(value)) {
    return { lock: emptyReviewLock(), diagnostics: [invalid(`${REVIEW_LOCK_FILE} does not match schema/docs-review.schema.json.`)] };
  }
  return { lock: value, diagnostics: [] };
}

function invalid(message: string): Diagnostic {
  return { id: "stale.lock-invalid", severity: "error", message, help: "Fix the file, or run `mizzen stale mark --all` to write it again." };
}

/** Writes the lock at `root`. */
export async function writeReviewLock(root: string, lock: ReviewLock): Promise<void> {
  await writeFile(join(root, REVIEW_LOCK_FILE), reviewLockText(lock));
}

/** Returns the lock with `page` recorded; the other pages are kept as they are. */
export function withPage(lock: ReviewLock, page: string, entry: LockedPage): ReviewLock {
  return { version: 1, pages: { ...lock.pages, [page]: entry } };
}

/** True for a `YYYY-MM-DD` date that exists on the calendar. */
export function isReviewDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(value);
}

/**
 * The review date: `date` when given, else the commit date of `HEAD` in `root`. It is never the system clock; with
 * no `--date` and no commit it fails with a message that says so.
 */
export async function reviewDate(root: string, date?: string): Promise<{ readonly date: string } | { readonly error: string }> {
  if (date !== undefined) return isReviewDate(date) ? { date } : { error: `--date "${date}" is not a date; use YYYY-MM-DD.` };
  try {
    const { stdout } = await promisify(execFile)("git", ["-C", root, "show", "-s", "--format=%cd", "--date=format:%Y-%m-%d", "HEAD"], {
      timeout: 10_000,
    });
    const found = stdout.trim();
    if (isReviewDate(found)) return { date: found };
  } catch {
    // fall through to the message below
  }
  return { error: "The review date comes from the commit date of HEAD, and there is none here; pass --date YYYY-MM-DD." };
}
