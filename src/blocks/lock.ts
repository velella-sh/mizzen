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

/** One recorded block: the page it was on and a hash of its normalized source. */
export interface RecordedBlock {
  readonly file: string;
  readonly fingerprint: string;
}

/** The whole lock file. */
export interface BlocksLock {
  /** The format version; only 1 exists. */
  readonly version: 1;
  /** Block ids by page path, then by id, with the source line the block was on. */
  readonly pages: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** Block ids mapped to the page and fingerprint they were recorded with; absent in locks written before matching. */
  readonly blocks?: Readonly<Record<string, RecordedBlock>>;
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

/** The lock a clean build would write: every page's ids and lines, and each block's fingerprint. */
export function blocksLockOf(pages: readonly Page[]): BlocksLock {
  const locked: Record<string, Record<string, number>> = {};
  const blocks: Record<string, RecordedBlock> = {};
  for (const page of pages) {
    if (page.blocks === undefined || page.blocks.length === 0) continue;
    const ids: Record<string, number> = {};
    for (const block of page.blocks) {
      ids[block.id] = block.pos.line;
      if (block.fingerprint !== undefined) blocks[block.id] = { file: page.source.file, fingerprint: block.fingerprint };
    }
    locked[page.source.file] = ids;
  }
  return { version: 1, pages: locked, blocks };
}
