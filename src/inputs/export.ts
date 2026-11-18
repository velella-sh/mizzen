/**
 * `mizzen inputs export`: reads the selected collections' sources, stores each unique content once, and writes one
 * deterministic package. Only declared collection sources enter: an environment file, the `.mizzen` cache, and a file
 * outside the site are never read. Every missing input is reported by id before anything is written, and a package is
 * written through a temporary file and a rename, so a failure leaves the previous file alone.
 */
import { mkdir, readFile, realpath, rename, stat, writeFile, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Diagnostic, SiteConfig } from "../contracts/index.ts";
import { dataLimitsOf } from "../data/limits.ts";
import { readLock, sha256, storedPath, type DataLock, type LockedSource } from "../data/lock.ts";
import {
  isAddressSource,
  isRestrictedSource,
  isSafeSourcePath,
  MAX_INPUT_BYTES,
  PACK_FORMAT,
  type PackBlob,
  type PackedInput,
  type PackManifest,
} from "./manifest.ts";
import { packBytes } from "./pack.ts";
import { selectCollections } from "./select.ts";

/** Options of {@link exportInputs}. */
export interface ExportInputsOptions {
  /** Absolute site root: the folder that holds `mizzen.yml`. */
  readonly root: string;
  /** The loaded config. */
  readonly config: SiteConfig;
  /** Collections to carry, comma-free; default every collection. Required dependencies are added. */
  readonly collections?: readonly string[];
  /** Package file to write; nothing is written when absent. */
  readonly out?: string;
  /** Largest one input may be; defaults to {@link MAX_INPUT_BYTES}. */
  readonly maxInputBytes?: number;
}

/** A package just written or computed. */
export interface ExportedPackage {
  /** Where it was written, when `out` named a file. */
  readonly file?: string;
  /** SHA-256 of the package file. */
  readonly sha256: string;
  /** Byte size of the package file. */
  readonly bytes: number;
  /** The manifest it holds. */
  readonly manifest: PackManifest;
}

/** What {@link exportInputs} found. */
export interface ExportInputsResult {
  /** 0 when the package was written or computed, 1 when an input is missing or unreadable. */
  readonly code: number;
  /** Every problem, each naming the input id it concerns. */
  readonly diagnostics: readonly Diagnostic[];
  /** One line per input and for the package, for the CLI to print. */
  readonly messages: readonly string[];
  /** The package, absent when an error stopped the export. */
  readonly package?: ExportedPackage;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function missing(id: string, detail: string, help: string): Diagnostic {
  return {
    id: "inputs.input-missing",
    severity: "error",
    message: `Input "${id}" is missing: ${detail}.`,
    help,
  };
}

function sourceError(id: string, detail: string, help: string): Diagnostic {
  return {
    id: "inputs.source-unsupported",
    severity: "error",
    message: `Input "${id}" cannot be packaged: ${detail}.`,
    help,
  };
}

function tooLarge(id: string, bytes: number, limit: number): Diagnostic {
  return {
    id: "inputs.input-too-large",
    severity: "error",
    message: `Input "${id}" is ${bytes} bytes; the package limit is ${limit}.`,
    help: `Raise collections.${id}.limits.bytes, split the source, or import a package under the limit.`,
  };
}

/** One read input: its manifest entry, bytes, and the lock entry a locked source needs. */
interface ReadInput {
  readonly input: PackedInput;
  readonly bytes: Uint8Array;
  readonly locked?: LockedSource;
}

/**
 * Reads one selected collection's source. A missing file, a missing lock entry, an unreadable store, or bytes that no
 * longer match the lock comes back as one diagnostic naming the collection.
 */
async function readInput(
  root: string,
  realRoot: string,
  config: SiteConfig,
  id: string,
  lock: DataLock,
  maxInputBytes: number,
): Promise<{ readonly read?: ReadInput; readonly diagnostic?: Diagnostic }> {
  const entry = config.collections[id];
  if (entry === undefined) return { diagnostic: missing(id, `no collection "${id}" is declared in mizzen.yml`, "Check the collection name.") };
  const source = entry.source;

  if (isAddressSource(source)) {
    if (source.startsWith("npm:")) {
      return {
        diagnostic: sourceError(
          id,
          `its source "${source}" is an installed package, not bytes this site owns`,
          "Install the package in the destination site; a package carries deployed inputs, not node_modules.",
        ),
      };
    }
    if (!source.startsWith("https://")) {
      return {
        diagnostic: sourceError(id, `its source "${source}" is not an https address`, "A locked source must be an https:// address or a file in the site."),
      };
    }
    const locked = lock.sources[source];
    if (locked === undefined) {
      return {
        diagnostic: missing(
          id,
          `"${source}" has no entry in mizzen.lock.json`,
          "Run `mizzen data fetch` to pin the source, then export again.",
        ),
      };
    }
    const file = storedPath(root, locked.sha256);
    let bytes: Uint8Array;
    try {
      bytes = await readFile(file);
    } catch {
      return {
        diagnostic: missing(
          id,
          `its stored bytes at ${relative(root, file).split(sep).join("/")} are missing`,
          "Run `mizzen data fetch` to store the pinned bytes, then export again.",
        ),
      };
    }
    if (bytes.byteLength !== locked.bytes || sha256(bytes) !== locked.sha256) {
      return {
        diagnostic: missing(
          id,
          `its stored bytes do not match mizzen.lock.json`,
          "Run `mizzen data fetch` to restore the pinned bytes, then export again.",
        ),
      };
    }
    const limit = Math.min(dataLimitsOf(id, entry).bytes, maxInputBytes);
    if (bytes.byteLength > limit) return { diagnostic: tooLarge(id, bytes.byteLength, limit) };
    return { read: { input: { id, source, bytes: bytes.byteLength, sha256: locked.sha256 }, bytes, locked } };
  }

  if (isRestrictedSource(source)) {
    return {
      diagnostic: sourceError(
        id,
        `its source "${source}" is machine state (an environment file or a cache folder)`,
        "Declare a data file under the site, not an environment file or a cache entry.",
      ),
    };
  }
  if (!isSafeSourcePath(source)) {
    return {
      diagnostic: sourceError(
        id,
        `its source "${source}" is not a relative path inside the site`,
        "Keep a collection source inside the site, such as `_data/items.yml`.",
      ),
    };
  }
  const file = resolve(root, source);
  if (!inside(root, file)) {
    return {
      diagnostic: sourceError(id, `its source "${source}" leaves the site`, "Keep a collection source inside the site."),
    };
  }
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    return { diagnostic: missing(id, `"${source}" does not exist`, "Restore the source, or run `mizzen data fetch` when it is remote.") };
  }
  const limit = Math.min(dataLimitsOf(id, entry).bytes, maxInputBytes);
  if (size > limit) return { diagnostic: tooLarge(id, size, limit) };
  let real: string;
  try {
    real = await realpath(file);
  } catch {
    return { diagnostic: missing(id, `"${source}" cannot be read`, "Point the collection at a readable file.") };
  }
  if (!inside(realRoot, real)) {
    return {
      diagnostic: sourceError(
        id,
        `"${source}" resolves outside the site through a symbolic link`,
        "Keep the file the link names inside the site.",
      ),
    };
  }
  let bytes: Uint8Array;
  try {
    bytes = await readFile(real);
  } catch {
    return { diagnostic: missing(id, `"${source}" cannot be read`, "Point the collection at a readable file.") };
  }
  return { read: { input: { id, source, bytes: bytes.byteLength, sha256: sha256(bytes) }, bytes } };
}

/**
 * Builds the package for the selected collections. Nothing is written when any input is missing or does not match its
 * lock, so an export either carries every declared input or no package at all.
 */
export async function exportInputs(options: ExportInputsOptions): Promise<ExportInputsResult> {
  const { root, config } = options;
  const maxInputBytes = options.maxInputBytes ?? MAX_INPUT_BYTES;
  const diagnostics: Diagnostic[] = [];
  const messages: string[] = [];

  const selection = selectCollections(config, options.collections);
  for (const name of selection.unknown) {
    diagnostics.push({
      id: "inputs.unknown-collection",
      severity: "error",
      message: `No collection named "${name}" is declared in mizzen.yml.`,
      help: `Use one of: ${Object.keys(config.collections).sort(compare).join(", ") || "(none)"}.`,
    });
  }

  const pinned = await readLock(root);
  const lockError = pinned.diagnostics.some((diagnostic) => diagnostic.severity === "error");
  diagnostics.push(...pinned.diagnostics);
  if (lockError) return { code: 1, diagnostics, messages };

  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    return {
      code: 1,
      diagnostics: [...diagnostics, { id: "inputs.site-missing", severity: "error", message: `The site root ${root} cannot be read.`, help: "Pass the folder that holds mizzen.yml." }],
      messages,
    };
  }

  const reads: ReadInput[] = [];
  for (const id of selection.ids) {
    const result = await readInput(root, realRoot, config, id, pinned.lock, maxInputBytes);
    if (result.read === undefined) {
      if (result.diagnostic !== undefined) diagnostics.push(result.diagnostic);
      continue;
    }
    reads.push(result.read);
  }
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return { code: 1, diagnostics, messages };
  }

  reads.sort((a, b) => compare(a.input.id, b.input.id));
  const contents = new Map<string, Uint8Array>();
  const inputs: PackedInput[] = [];
  const lockSources: Record<string, LockedSource> = {};
  for (const read of reads) {
    inputs.push(read.input);
    if (!contents.has(read.input.sha256)) contents.set(read.input.sha256, read.bytes);
    if (read.locked !== undefined) lockSources[read.locked.address] = read.locked;
  }
  const sortedLock: Record<string, LockedSource> = {};
  for (const address of Object.keys(lockSources).sort(compare)) sortedLock[address] = lockSources[address]!;
  const blobs: PackBlob[] = [...contents.keys()]
    .sort(compare)
    .map((digest) => ({ sha256: digest, bytes: contents.get(digest)!.byteLength }));
  const manifest: PackManifest = {
    format: PACK_FORMAT,
    inputs,
    blobs,
    lock: { version: 1, sources: sortedLock },
  };

  let bytes: Uint8Array;
  try {
    bytes = packBytes(manifest, contents);
  } catch (err) {
    return {
      code: 1,
      diagnostics: [...diagnostics, { id: "inputs.package-invalid", severity: "error", message: err instanceof Error ? err.message : String(err), help: "Report this as an engine bug." }],
      messages,
    };
  }
  const digest = sha256(bytes);

  for (const input of inputs) {
    messages.push(`input ${input.id}  ${input.source}  ${input.bytes} bytes  ${input.sha256}`);
  }

  if (options.out !== undefined) {
    const file = resolve(options.out);
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(temporary, bytes);
      await rename(temporary, file);
    } catch (err) {
      await rm(temporary, { force: true }).catch(() => undefined);
      return {
        code: 1,
        diagnostics: [
          ...diagnostics,
          {
            id: "inputs.package-write",
            severity: "error",
            message: `The input package ${file} cannot be written: ${err instanceof Error ? err.message : String(err)}.`,
            help: "Check the folder exists and is writable, then export again.",
          },
        ],
        messages,
      };
    }
    messages.push(`wrote ${file} (${inputs.length} inputs, ${blobs.length} contents, ${bytes.byteLength} bytes, sha256 ${digest})`);
    return { code: 0, diagnostics, messages, package: { file, sha256: digest, bytes: bytes.byteLength, manifest } };
  }

  messages.push(`package (${inputs.length} inputs, ${blobs.length} contents, ${bytes.byteLength} bytes, sha256 ${digest})`);
  return { code: 0, diagnostics, messages, package: { sha256: digest, bytes: bytes.byteLength, manifest } };
}
