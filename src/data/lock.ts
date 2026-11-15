/**
 * `mizzen.lock.json`: the pin of every remote and package collection source, so a build reads exactly the bytes a
 * person fetched and verified. Each entry records its address, the installed package version when there is one, the
 * byte size, and the SHA-256.
 *
 * The file is canonical: object keys are sorted at every level, it uses LF line endings, and it holds no timestamp,
 * so fetching an unchanged source writes the same bytes. It is validated against `schema/data-lock.schema.json` on
 * every read; a missing file is an empty lock, and a malformed one is an error that fails a build using it.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import type { Diagnostic } from "../contracts/index.ts";

/** The lock file name at a site root. */
export const LOCK_FILE = "mizzen.lock.json";

/** Folder under a site root that holds the fetched bytes, named by their SHA-256. */
export const DATA_STORE = ".mizzen/data";

/** One pinned source. */
export interface LockedSource {
  /** The source address as the config writes it: an `https:` URL or `npm:<package>/<path>`. */
  readonly address: string;
  /** The installed package version, for an `npm:` source; absent for a URL. */
  readonly version?: string;
  /** Byte size of the source. */
  readonly bytes: number;
  /** SHA-256 of the source's bytes. */
  readonly sha256: string;
}

/** The whole lock file. */
export interface DataLock {
  /** The format version; only 1 exists. */
  readonly version: 1;
  /** Pinned sources by address. */
  readonly sources: Readonly<Record<string, LockedSource>>;
}

/** An empty lock. */
export function emptyLock(): DataLock {
  return { version: 1, sources: {} };
}

// ajv is CommonJS: its default export is the class at run time, but its types name it.
const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;
const schema = JSON.parse(
  readFileSync(new URL("../../schema/data-lock.schema.json", import.meta.url), "utf8"),
) as object;
const validateLock = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

/** SHA-256 of the bytes, as 64 lowercase hex characters. */
export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** JSON with object keys sorted at every level, so equal locks always serialize alike. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The lock file's text: canonical JSON and one trailing line feed. */
export function lockText(lock: DataLock): string {
  const sources: Record<string, LockedSource> = {};
  for (const address of Object.keys(lock.sources).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const entry = lock.sources[address]!;
    sources[address] = {
      address: entry.address,
      ...(entry.version === undefined ? {} : { version: entry.version }),
      bytes: entry.bytes,
      sha256: entry.sha256,
    };
  }
  return `${canonicalJson({ version: lock.version, sources })}\n`;
}

/** True when `value` is a lock this version may trust. */
export function isLock(value: unknown): value is DataLock {
  return validateLock(value);
}

/** Reads the lock file at `root`; a missing file is an empty lock and a malformed one is an empty lock with an error. */
export async function readLock(root: string): Promise<{ readonly lock: DataLock; readonly diagnostics: readonly Diagnostic[] }> {
  let text: string;
  try {
    text = await readFile(join(root, LOCK_FILE), "utf8");
  } catch {
    return { lock: emptyLock(), diagnostics: [] };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      lock: emptyLock(),
      diagnostics: [{
        id: "data.lock-invalid",
        severity: "error",
        message: `${LOCK_FILE} is not valid JSON: ${detail}`,
        help: "Fix the file, or run `mizzen data fetch` to write it again.",
      }],
    };
  }
  if (!isLock(value)) {
    return {
      lock: emptyLock(),
      diagnostics: [{
        id: "data.lock-invalid",
        severity: "error",
        message: `${LOCK_FILE} does not match schema/data-lock.schema.json.`,
        help: "Fix the file, or run `mizzen data fetch` to write it again.",
      }],
    };
  }
  return { lock: value as DataLock, diagnostics: [] };
}

/** Writes the lock file at `root`, canonical and ending in one LF. */
export async function writeLock(root: string, lock: DataLock): Promise<void> {
  await writeFile(join(root, LOCK_FILE), lockText(lock));
}

/** Where the bytes of a pinned source live: `<root>/.mizzen/data/<sha256>`. */
export function storedPath(root: string, sha256Value: string): string {
  return join(root, DATA_STORE, sha256Value);
}
