/**
 * `mizzen inputs inspect`: reads a package and reports its format, package hash, and every declared input with its
 * source, size, and hash. It changes nothing in the site; it only reads the file it names.
 */
import type { Diagnostic } from "../contracts/index.ts";
import { MAX_PACKAGE_BYTES, type PackedInput } from "./manifest.ts";
import { readPackage } from "./pack.ts";

/** What an inspection reports. */
export interface Inspection {
  /** The package file. */
  readonly file: string;
  /** The package format. */
  readonly format: number;
  /** SHA-256 of the package file. */
  readonly sha256: string;
  /** Byte size of the package file. */
  readonly bytes: number;
  /** The declared inputs, in manifest order. */
  readonly inputs: readonly PackedInput[];
  /** How many unique contents the package holds. */
  readonly contents: number;
}

/** What {@link inspectPackage} found. */
export interface InspectResult {
  /** 0 when the package is valid, 1 when it is not. */
  readonly code: number;
  /** Every problem found. */
  readonly diagnostics: readonly Diagnostic[];
  /** The report, absent when the package cannot be read. */
  readonly inspection?: Inspection;
}

/** Reads a package and reports what it holds; nothing is written. */
export async function inspectPackage(options: { readonly file: string; readonly maxBytes?: number }): Promise<InspectResult> {
  const read = await readPackage(options.file, options.maxBytes ?? MAX_PACKAGE_BYTES);
  if (read.pkg === undefined) return { code: 1, diagnostics: read.diagnostics };
  return {
    code: 0,
    diagnostics: [],
    inspection: {
      file: options.file,
      format: read.pkg.manifest.format,
      sha256: read.pkg.sha256,
      bytes: read.pkg.bytes,
      inputs: read.pkg.manifest.inputs,
      contents: read.pkg.manifest.blobs.length,
    },
  };
}

/** The inspection as the lines the CLI prints, one per input. */
export function inspectionText(inspection: Inspection): string {
  const lines = [
    `package ${inspection.file}`,
    `format ${inspection.format}`,
    `sha256 ${inspection.sha256}`,
    `inputs ${inspection.inputs.length} (${inspection.contents} unique contents, ${inspection.bytes} bytes)`,
  ];
  for (const input of inspection.inputs) {
    lines.push(`  ${input.id}  ${input.source}  ${input.bytes} bytes  ${input.sha256}`);
  }
  return lines.join("\n");
}
