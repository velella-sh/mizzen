/**
 * `blocks.lock.json`: every page's stable block identifiers, in the order the last accepted build found them.
 *
 * The file turns on block identifiers: a site without it keeps `Page.blocks` unset, so an older site builds exactly
 * as it did. Only `mizzen build --update-blocks` writes it, and only after a clean build. Identifiers are unique across
 * the site; a block that declares one keeps it when it moves, and one without a declaration gets a content-derived
 * `b-<10 hex>` id.
 *
 * It is canonical: object keys are sorted at every level, it uses LF line endings, and it holds no timestamp, so an
 * unchanged site writes the same bytes. It is validated against `schema/blocks.lock.schema.json` on every read; a
 * missing file starts the check, and a malformed one is an error.
 */
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import type { Diagnostic, Page } from "../contracts/index.ts";
import { canonicalJson } from "../data/lock.ts";

/** The block lock's file name at a site root. */
export const BLOCKS_LOCK_FILE = "blocks.lock.json";

/** One recorded block: the page it was on and a hash of its normalized source, plus a heading's anchors. */
export interface RecordedBlock {
  readonly file: string;
  readonly fingerprint: string;
  /** The heading's rendered anchor at the last build. */
  readonly anchor?: string;
  /** Anchors the heading had before an edit, sorted. */
  readonly aliases?: readonly string[];
}

/** The whole lock file. */
export interface BlocksLock {
  /** The format version; only 1 exists. */
  readonly version: 1;
  /** Block ids by page path, then by id, with the source line the block was on. */
  readonly pages: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** Block ids mapped to the page and fingerprint they were recorded with; absent in locks written before matching. */
  readonly blocks?: Readonly<Record<string, RecordedBlock>>;
  /**
   * Each block's last move, by id: the page it was recorded on and the page it is on now. Absent when nothing moved,
   * and kept across later builds until the block moves again.
   */
  readonly moves?: Readonly<Record<string, { readonly from: string; readonly to: string }>>;
}

/** An empty lock. */
export function emptyBlocksLock(): BlocksLock {
  return { version: 1, pages: {} };
}

// ajv is CommonJS: its default export is the class at run time, but its types name it.
const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;
const schema = JSON.parse(
  readFileSync(new URL("../../schema/blocks.lock.schema.json", import.meta.url), "utf8"),
) as object;
const validateLock = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

/** True when `value` is a lock this version may trust. */
export function isBlocksLock(value: unknown): value is BlocksLock {
  return validateLock(value);
}

/** The lock file's text: canonical JSON and one trailing line feed. */
export function blocksLockText(lock: BlocksLock): string {
  return `${canonicalJson(lock)}\n`;
}

/** Reads the lock file at `root`; a missing file is an empty lock that the check has not started from. */
export async function readBlocksLock(
  root: string,
): Promise<{ readonly lock: BlocksLock; readonly found: boolean; readonly diagnostics: readonly Diagnostic[] }> {
  let text: string;
  try {
    text = await readFile(join(root, BLOCKS_LOCK_FILE), "utf8");
  } catch {
    return { lock: emptyBlocksLock(), found: false, diagnostics: [] };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      lock: emptyBlocksLock(),
      found: true,
      diagnostics: [{
        id: "data.blocks-lock-invalid",
        severity: "error",
        message: `${BLOCKS_LOCK_FILE} is not valid JSON: ${detail}`,
        help: "Fix the file, or run `mizzen build --update-blocks` to write it again.",
      }],
    };
  }
  if (!isBlocksLock(value)) {
    return {
      lock: emptyBlocksLock(),
      found: true,
      diagnostics: [{
        id: "data.blocks-lock-invalid",
        severity: "error",
        message: `${BLOCKS_LOCK_FILE} does not match schema/blocks.lock.schema.json.`,
        help: "Fix the file, or run `mizzen build --update-blocks` to write it again.",
      }],
    };
  }
  return { lock: value, found: true, diagnostics: [] };
}

/** Writes the lock file at `root`, canonical and ending in one LF. */
export async function writeBlocksLock(root: string, lock: BlocksLock): Promise<void> {
  await writeFile(join(root, BLOCKS_LOCK_FILE), blocksLockText(lock));
}

/**
 * A block's recorded anchor after a build: the anchor it has now, and every earlier one it kept, sorted. A heading
 * whose anchor changed since the last build keeps the old one as an alias, so an old link still lands on it.
 */
export function recordedAnchors(
  previous: RecordedBlock | undefined,
  anchor: string | undefined,
): { readonly anchor?: string; readonly aliases?: readonly string[] } {
  const aliases = new Set(previous?.aliases);
  if (previous?.anchor !== undefined && anchor !== undefined && previous.anchor !== anchor) aliases.add(previous.anchor);
  const sorted = [...aliases].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    ...(anchor === undefined ? {} : { anchor }),
    ...(sorted.length === 0 ? {} : { aliases: sorted }),
  };
}

/** The lock a clean build would write: every page's ids and lines, each block's fingerprint and anchors, and every move. */
export function blocksLockOf(pages: readonly Page[], previous?: BlocksLock): BlocksLock {
  const locked: Record<string, Record<string, number>> = {};
  const blocks: Record<string, RecordedBlock> = {};
  const moves: Record<string, { readonly from: string; readonly to: string }> = { ...previous?.moves };
  for (const page of pages) {
    if (page.blocks === undefined || page.blocks.length === 0) continue;
    const ids: Record<string, number> = {};
    for (const block of page.blocks) {
      ids[block.id] = block.pos.line;
      if (block.fingerprint !== undefined) {
        blocks[block.id] = {
          file: page.source.file,
          fingerprint: block.fingerprint,
          ...recordedAnchors(previous?.blocks?.[block.id], block.anchor),
        };
      }
      const from = previous?.blocks?.[block.id]?.file;
      if (from !== undefined && from !== page.source.file) moves[block.id] = { from, to: page.source.file };
    }
    locked[page.source.file] = ids;
  }
  return { version: 1, pages: locked, blocks, ...(Object.keys(moves).length === 0 ? {} : { moves }) };
}
