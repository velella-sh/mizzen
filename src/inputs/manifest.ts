/**
 * The versioned manifest of an input package: the declared inputs, the SHA-256 and size of each, the unique contents
 * the package holds, and the lock entries the inputs need. A manifest is validated as a whole before anything is read
 * or written, so a package from another version, a hand-edited hash, or an input without its content is one clear error
 * instead of a partial install.
 *
 * The container is one file: the magic and format on the first line, the manifest as canonical JSON on the second, then
 * the blobs in the manifest's own order, with no separator and no timestamp. See `docs/input-pack.md`.
 */
import type { Diagnostic } from "../contracts/index.ts";
import { canonicalJson, isLock, type DataLock } from "../data/lock.ts";

/** First line of a package: `mizzen-input-pack/<format>`. */
export const PACK_MAGIC = "mizzen-input-pack";

/** The only package format this release writes and reads. */
export const PACK_FORMAT = 1;

/** The Mizzen release that introduced each format, so a rejected format names a compatible version. */
export const PACK_FORMAT_VERSIONS: Readonly<Record<number, string>> = Object.freeze({ 1: "0.2.5" });

/** Largest package the importer reads into memory. A package holds a site's declared data sources, not a site. */
export const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;

/** Largest one input may be. A site that raises `collections.<name>.limits.bytes` above this needs a smaller source. */
export const MAX_INPUT_BYTES = 16 * 1024 * 1024;

/** One declared input: a collection's source and the hash of the content the package carries for it. */
export interface PackedInput {
  /** The collection name in `mizzen.yml`. */
  readonly id: string;
  /** The source as the config writes it: a site path or an `https:` address. */
  readonly source: string;
  /** Byte size of the content. */
  readonly bytes: number;
  /** SHA-256 of the content, as 64 lowercase hex characters. */
  readonly sha256: string;
}

/** One unique content the package holds; several inputs may name the same blob. */
export interface PackBlob {
  /** SHA-256 of the content. */
  readonly sha256: string;
  /** Byte size of the content. */
  readonly bytes: number;
}

/** The whole manifest. */
export interface PackManifest {
  /** The container format, always {@link PACK_FORMAT} for a package this version writes. */
  readonly format: number;
  /** The declared inputs, sorted by id. */
  readonly inputs: readonly PackedInput[];
  /** The unique contents, sorted by SHA-256. */
  readonly blobs: readonly PackBlob[];
  /** The lock entries the inputs need, and nothing else. */
  readonly lock: DataLock;
}

const SHA = /^[0-9a-f]{64}$/;

/** True for an address (`https:`, `npm:`, …) rather than a path in the site. */
export function isAddressSource(source: string): boolean {
  return /^[a-z][a-z\d+.-]*:/i.test(source);
}

/**
 * True for a path a package may write inside the site: relative, `/`-separated, with no empty, `.`, or `..` segment.
 * A backslash and a drive letter are refused too, so one manifest means the same path on every system.
 */
export function isSafeSourcePath(source: string): boolean {
  if (source === "" || source.includes("\0") || source.includes("\\")) return false;
  if (source.startsWith("/") || /^[a-z]:/i.test(source)) return false;
  return source.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/**
 * True for a path a package never carries: environment files, the `.mizzen` cache and store, git metadata, and an
 * installed package tree. These are machine state, not declared input.
 */
export function isRestrictedSource(source: string): boolean {
  const parts = source.split("/");
  const base = parts[parts.length - 1] ?? "";
  return (
    base === ".env" ||
    base.startsWith(".env.") ||
    base === "mizzen.yml" ||
    base === "mizzen.yaml" ||
    base.endsWith(".lock.json") ||
    parts.some((part) => part === ".mizzen" || part === ".git" || part === "node_modules")
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort().join(",");
  return actual === [...keys].sort().join(",");
}

/**
 * Why `value` is not a manifest this version may trust, or `undefined` when it is one. The check covers the format,
 * every input's id, path, size, and hash, the unique blobs, and that the lock holds exactly the entries the locked
 * inputs need.
 */
export function validateManifest(value: unknown): string | undefined {
  if (!isRecord(value)) return "the manifest must be a JSON object";
  if (!hasKeys(value, ["format", "inputs", "blobs", "lock"])) {
    return "the manifest must hold exactly format, inputs, blobs, and lock";
  }
  if (typeof value["format"] !== "number" || !Number.isInteger(value["format"]) || value["format"] < 1) {
    return "format must be a whole number of at least 1";
  }
  if (value["format"] !== PACK_FORMAT) {
    return `format ${value["format"]} is not the format this version writes (${PACK_FORMAT})`;
  }
  if (!Array.isArray(value["inputs"])) return "inputs must be a list";
  if (!Array.isArray(value["blobs"])) return "blobs must be a list";

  const ids = new Set<string>();
  const inputs: PackedInput[] = [];
  const hashOfSource = new Map<string, string>();
  for (let index = 0; index < value["inputs"].length; index++) {
    const item: unknown = value["inputs"][index];
    const at = `inputs[${index}]`;
    if (!isRecord(item) || !hasKeys(item, ["id", "source", "bytes", "sha256"])) {
      return `${at} must hold exactly id, source, bytes, and sha256`;
    }
    const id = item["id"];
    const source = item["source"];
    const bytes = item["bytes"];
    const digest = item["sha256"];
    if (typeof id !== "string" || id === "") return `${at}.id must be a non-empty string`;
    if (ids.has(id)) return `input id "${id}" appears twice`;
    if (typeof source !== "string" || source === "") return `${at}.source must be a non-empty string`;
    if (!Number.isSafeInteger(bytes) || (bytes as number) < 0) return `${at}.bytes must be a whole number of at least 0`;
    if (typeof digest !== "string" || !SHA.test(digest)) return `${at}.sha256 must be 64 lowercase hexadecimal characters`;
    const previous = hashOfSource.get(source);
    if (previous !== undefined && previous !== digest) {
      return `input "${id}" reuses source "${source}" with different content`;
    }
    hashOfSource.set(source, digest);
    ids.add(id);
    inputs.push({ id, source, bytes: bytes as number, sha256: digest });
  }

  const blobs = new Map<string, number>();
  for (let index = 0; index < value["blobs"].length; index++) {
    const item: unknown = value["blobs"][index];
    const at = `blobs[${index}]`;
    if (!isRecord(item) || !hasKeys(item, ["sha256", "bytes"])) return `${at} must hold exactly sha256 and bytes`;
    const digest = item["sha256"];
    const bytes = item["bytes"];
    if (typeof digest !== "string" || !SHA.test(digest)) return `${at}.sha256 must be 64 lowercase hexadecimal characters`;
    if (!Number.isSafeInteger(bytes) || (bytes as number) < 0) return `${at}.bytes must be a whole number of at least 0`;
    if (blobs.has(digest)) return `content "${digest}" appears twice`;
    blobs.set(digest, bytes as number);
  }

  for (const input of inputs) {
    const size = blobs.get(input.sha256);
    if (size === undefined) return `input "${input.id}" names content the package does not hold`;
    if (size !== input.bytes) return `input "${input.id}" is ${input.bytes} bytes but its content is ${size}`;
  }

  if (!isLock(value["lock"])) return "lock is not a mizzen.lock.json this version reads";
  const lock = value["lock"];
  if (lock.version !== 1) return "lock.version must be 1";
  if (Object.keys(lock.snapshots ?? {}).length > 0) return "a package lock holds sources, not snapshots";
  const bySource = new Map(inputs.map((input) => [input.source, input]));
  for (const [address, entry] of Object.entries(lock.sources)) {
    const input = bySource.get(address);
    if (input === undefined) return `lock entry "${address}" is not a declared input`;
    if (entry.address !== address) return `lock entry "${address}" names itself ${entry.address}`;
    if (entry.sha256 !== input.sha256 || entry.bytes !== input.bytes) {
      return `lock entry "${address}" does not match its input`;
    }
  }
  for (const input of inputs) {
    if (isAddressSource(input.source) && lock.sources[input.source] === undefined) {
      return `locked input "${input.id}" has no lock entry`;
    }
  }
  return undefined;
}

/** True when `value` is a manifest this version may trust. */
export function isInputManifest(value: unknown): value is PackManifest {
  return validateManifest(value) === undefined;
}

/** A manifest that does not match the format, with the reason and a fix. */
export function manifestInvalid(reason: string): Diagnostic {
  return {
    id: "inputs.manifest-invalid",
    severity: "error",
    message: `The input package manifest is not valid: ${reason}.`,
    help: "Create the package with `mizzen inputs export`, and do not edit it by hand.",
  };
}

/** A package whose first line names a format this release does not read, with the version that does. */
export function formatUnsupported(format: number): Diagnostic {
  const since = PACK_FORMAT_VERSIONS[PACK_FORMAT]!;
  const supported = Object.keys(PACK_FORMAT_VERSIONS).join(", ");
  return {
    id: "inputs.format-unsupported",
    severity: "error",
    message: `Input package format ${format} is not supported; this Mizzen reads format ${supported} (Mizzen ${since}).`,
    help: `Export the inputs with Mizzen ${since} or newer, or install a Mizzen version that reads format ${format}.`,
  };
}

/** The manifest as canonical JSON: sorted keys and no whitespace, so equal packages write equal bytes. */
export function manifestText(manifest: PackManifest): string {
  return canonicalJson(manifest);
}
