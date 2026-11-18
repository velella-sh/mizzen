/**
 * The inventory: every input file in exactly one of four kinds, in a stable order. An importer classifies what it can;
 * the shared command completes the list so a file is never silently absent from the report.
 */
import type { ImportFile, ImportFileKind } from "./contract.ts";

/** The four kinds, in the order a report lists them. */
export const FILE_KINDS: readonly ImportFileKind[] = ["content", "config", "asset", "unsupported"];

/** Input paths by kind, each list sorted. */
export interface ImportInventory {
  readonly content: readonly string[];
  readonly config: readonly string[];
  readonly assets: readonly string[];
  readonly unsupported: readonly string[];
}

/** The completed file list and its grouping. */
export interface ImportInventoryResult {
  readonly files: readonly ImportFile[];
  readonly inventory: ImportInventory;
}

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Groups every file the importer reported, then adds an unsupported entry for each input it did not name. */
export function inventoryOf(sourceFiles: readonly string[], reported: readonly ImportFile[]): ImportInventoryResult {
  const known = new Set(sourceFiles);
  const byPath = new Map<string, ImportFile>();
  for (const file of reported) {
    if (known.has(file.path)) byPath.set(file.path, file);
  }

  const content: string[] = [];
  const config: string[] = [];
  const assets: string[] = [];
  const unsupported: string[] = [];
  const files: ImportFile[] = [];
  for (const path of [...sourceFiles].sort(byCodePoint)) {
    const found = byPath.get(path);
    const file: ImportFile =
      found === undefined
        ? { path, kind: "unsupported", reason: "the importer did not classify this file" }
        : found.kind === "unsupported" && found.reason === undefined
          ? { path, kind: "unsupported", reason: "not supported by the importer" }
          : found;
    files.push(file);
    if (file.kind === "content") content.push(path);
    else if (file.kind === "config") config.push(path);
    else if (file.kind === "asset") assets.push(path);
    else unsupported.push(path);
  }

  return { files, inventory: { content, config, assets, unsupported } };
}
