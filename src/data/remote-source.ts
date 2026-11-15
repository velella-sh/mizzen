/**
 * `https:` collection sources: a build reads the bytes a person fetched into `.mizzen/data/` and pinned in
 * `mizzen.lock.json`. It never opens a network connection, accepts no scheme but `https:`, and trusts no stored file
 * whose hash or size differs from the lock.
 */
import { readFile, stat } from "node:fs/promises";
import { relative, sep } from "node:path";
import type { Diagnostic } from "../contracts/index.ts";
import type { DataLimits } from "./limits.ts";
import { sha256, storedPath, type DataLock } from "./lock.ts";

/** A remote source read from the store. */
export interface RemoteSource {
  /** The address as the config writes it. */
  readonly address: string;
  /** The file's path relative to the site root, for diagnostics and positions. */
  readonly display: string;
  /** The stored bytes as UTF-8 text. */
  readonly text: string;
  /** The pinned SHA-256. */
  readonly sha256: string;
  /** The pinned byte size. */
  readonly bytes: number;
}

/** What reading one remote source found. */
export interface RemoteSourceResult {
  /** The source, absent when a diagnostic explains why. */
  readonly source?: RemoteSource;
  /** The one problem that stopped the read. */
  readonly diagnostic?: Diagnostic;
}

/** True for an address in the `https:` form. */
export function isRemoteSource(address: string): boolean {
  return address.startsWith("https://");
}

/** The one error for an address a build may not read. */
function schemeError(address: string): Diagnostic {
  return {
    id: "data.source-scheme",
    severity: "error",
    message: `Collection source "${address}" is not allowed; a remote source must start with https://.`,
    help: "Use https://, or keep the file inside the site.",
  };
}

/**
 * Reads a pinned `https:` source from the store. `lock` is the site's validated lock, and `limits` bounds what a
 * build is willing to read.
 */
export async function readRemoteSource(
  root: string,
  address: string,
  lock: DataLock,
  limits: DataLimits,
): Promise<RemoteSourceResult> {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return { diagnostic: schemeError(address) };
  }
  if (url.protocol !== "https:") return { diagnostic: schemeError(address) };

  const entry = lock.sources[address];
  if (entry === undefined) {
    return {
      diagnostic: {
        id: "data.lock-missing",
        severity: "error",
        message: `Collection source "${address}" has no entry in mizzen.lock.json.`,
        help: "Run `mizzen data fetch` to fetch it and pin its bytes.",
      },
    };
  }

  if (entry.bytes > limits.bytes) {
    return {
      diagnostic: {
        id: "data.source-too-large",
        severity: "error",
        message: `Collection source "${address}" is ${entry.bytes} bytes; the limit is ${limits.bytes}.`,
        help: "Raise collections.<name>.limits.bytes in mizzen.yml, or split the source.",
      },
    };
  }

  const stored = storedPath(root, entry.sha256);
  const display = relative(root, stored).split(sep).join("/");
  let size: number;
  try {
    size = (await stat(stored)).size;
  } catch {
    return {
      diagnostic: {
        id: "data.store-missing",
        severity: "error",
        message: `The stored bytes for "${address}" are missing from ${display}.`,
        pos: { file: display, line: 1, column: 1, endLine: 1, endColumn: 1 },
        help: "Run `mizzen data fetch` to store them again.",
      },
    };
  }
  if (size > limits.bytes) {
    return {
      diagnostic: {
        id: "data.source-too-large",
        severity: "error",
        message: `Collection source "${address}" is ${size} bytes; the limit is ${limits.bytes}.`,
        pos: { file: display, line: 1, column: 1, endLine: 1, endColumn: 1 },
        help: "Raise collections.<name>.limits.bytes in mizzen.yml, or split the source.",
      },
    };
  }

  const bytes = await readFile(stored);
  if (bytes.byteLength !== entry.bytes || sha256(bytes) !== entry.sha256) {
    return {
      diagnostic: {
        id: "data.store-mismatch",
        severity: "error",
        message: `The stored bytes for "${address}" do not match its lock entry.`,
        pos: { file: display, line: 1, column: 1, endLine: 1, endColumn: 1 },
        help: "Run `mizzen data fetch` to restore the pinned bytes.",
      },
    };
  }

  return {
    source: {
      address,
      display,
      text: bytes.toString("utf8"),
      sha256: entry.sha256,
      bytes: entry.bytes,
    },
  };
}
