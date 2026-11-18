/**
 * The single-file package container. Line 1 is `mizzen-input-pack/<format>`, line 2 is the canonical manifest, then the
 * blobs the manifest names, in its order, with no separator and no timestamp. Reading checks the magic, the format, the
 * manifest, every blob's size and SHA-256, and that the file ends exactly after the last declared blob, so appended or
 * undeclared bytes are refused before an install can start.
 *
 * A single file with a fixed header was chosen over ZIP or tar because both record file modification times and
 * permissions, and two exports of the same input would then have different hashes. The reader is bounded by
 * {@link MAX_PACKAGE_BYTES}, and a package is read whole only when it is under that limit.
 */
import { readFile, stat } from "node:fs/promises";
import type { Diagnostic } from "../contracts/index.ts";
import { sha256 } from "../data/lock.ts";
import {
  formatUnsupported,
  manifestInvalid,
  manifestText,
  MAX_PACKAGE_BYTES,
  PACK_FORMAT_VERSIONS,
  PACK_MAGIC,
  validateManifest,
  type PackManifest,
} from "./manifest.ts";

/** A package read and checked. */
export interface InputPackage {
  /** The validated manifest. */
  readonly manifest: PackManifest;
  /** The unique contents by SHA-256, in manifest order. */
  readonly blobs: ReadonlyMap<string, Uint8Array>;
  /** SHA-256 of the package file, the identity to record or compare. */
  readonly sha256: string;
  /** Byte size of the package file. */
  readonly bytes: number;
}

/** What reading one package found. */
export interface ReadPackageResult {
  /** The package, absent when a diagnostic explains why. */
  readonly pkg?: InputPackage;
  /** Every problem found; no caller should install anything when one is an error. */
  readonly diagnostics: readonly Diagnostic[];
}

/** The package's bytes: the header, the canonical manifest, then the unique contents in manifest order. */
export function packBytes(manifest: PackManifest, blobs: ReadonlyMap<string, Uint8Array>): Uint8Array {
  const parts: Uint8Array[] = [
    Buffer.from(`${PACK_MAGIC}/${manifest.format}\n${manifestText(manifest)}\n`, "utf8"),
  ];
  for (const blob of manifest.blobs) {
    const content = blobs.get(blob.sha256);
    if (content === undefined) throw new Error(`packBytes: no content for ${blob.sha256}`);
    parts.push(content);
  }
  return Buffer.concat(parts);
}

function packageMissing(file: string, detail: string): Diagnostic {
  return {
    id: "inputs.package-missing",
    severity: "error",
    message: `The input package ${file} cannot be read: ${detail}.`,
    help: "Check the path, or export the package again with `mizzen inputs export`.",
  };
}

/**
 * Reads and fully checks a package at `file`. A missing, oversized, truncated, tampered, or hand-edited package is one
 * diagnostic and no package, never a partial read.
 */
export async function readPackage(file: string, maxBytes: number = MAX_PACKAGE_BYTES): Promise<ReadPackageResult> {
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch (err) {
    return { diagnostics: [packageMissing(file, err instanceof Error ? err.message : String(err))] };
  }
  if (size > maxBytes) {
    return {
      diagnostics: [{
        id: "inputs.package-too-large",
        severity: "error",
        message: `The input package ${file} is ${size} bytes; the limit is ${maxBytes}.`,
        help: "Split the site's inputs into smaller sites, or import a package under the limit.",
      }],
    };
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (err) {
    return { diagnostics: [packageMissing(file, err instanceof Error ? err.message : String(err))] };
  }

  const firstEnd = bytes.indexOf(0x0a);
  if (firstEnd < 0) {
    return {
      diagnostics: [{
        id: "inputs.package-magic",
        severity: "error",
        message: `${file} is not an input package: its first line is not ${PACK_MAGIC}/<format>.`,
        help: "Create the package with `mizzen inputs export`.",
      }],
    };
  }
  const header = bytes.subarray(0, firstEnd).toString("utf8");
  if (!header.startsWith(`${PACK_MAGIC}/`)) {
    return {
      diagnostics: [{
        id: "inputs.package-magic",
        severity: "error",
        message: `${file} is not an input package: its first line is not ${PACK_MAGIC}/<format>.`,
        help: "Create the package with `mizzen inputs export`.",
      }],
    };
  }
  const format = Number(header.slice(PACK_MAGIC.length + 1));
  if (!Number.isInteger(format) || format < 1) {
    return {
      diagnostics: [{
        id: "inputs.package-magic",
        severity: "error",
        message: `${file} names the package format "${header.slice(PACK_MAGIC.length + 1)}", which is not a whole number.`,
        help: "Create the package with `mizzen inputs export`.",
      }],
    };
  }
  if (PACK_FORMAT_VERSIONS[format] === undefined) return { diagnostics: [formatUnsupported(format)] };

  const secondEnd = bytes.indexOf(0x0a, firstEnd + 1);
  if (secondEnd < 0) {
    return { diagnostics: [manifestInvalid("the manifest line is missing")] };
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.subarray(firstEnd + 1, secondEnd).toString("utf8"));
  } catch (err) {
    return { diagnostics: [manifestInvalid(`the manifest is not JSON (${err instanceof Error ? err.message : String(err)})`)] };
  }
  const reason = validateManifest(value);
  if (reason !== undefined) return { diagnostics: [manifestInvalid(reason)] };
  const manifest = value as PackManifest;
  if (manifest.format !== format) {
    return { diagnostics: [manifestInvalid(`the header names format ${format} and the manifest names ${manifest.format}`)] };
  }

  const blobs = new Map<string, Uint8Array>();
  let offset = secondEnd + 1;
  for (const blob of manifest.blobs) {
    const end = offset + blob.bytes;
    if (end > bytes.length) {
      return {
        diagnostics: [{
          id: "inputs.package-truncated",
          severity: "error",
          message: `The input package ${file} ends before the content of ${blob.sha256}.`,
          help: "Export the package again, then import it.",
        }],
      };
    }
    const content = bytes.subarray(offset, end);
    if (content.byteLength !== blob.bytes || sha256(content) !== blob.sha256) {
      return {
        diagnostics: [{
          id: "inputs.package-mismatch",
          severity: "error",
          message: `The content of ${blob.sha256} in ${file} does not match its manifest hash.`,
          help: "Do not install this package; export it again from the site that owns the input.",
        }],
      };
    }
    blobs.set(blob.sha256, content);
    offset = end;
  }
  if (offset !== bytes.length) {
    return {
      diagnostics: [{
        id: "inputs.package-undeclared-data",
        severity: "error",
        message: `The input package ${file} holds ${bytes.length - offset} bytes that no input declares.`,
        help: "A package holds only its declared inputs; export it again instead of adding files.",
      }],
    };
  }

  return { pkg: { manifest, blobs, sha256: sha256(bytes), bytes: bytes.byteLength }, diagnostics: [] };
}
