/**
 * How faithfully each input file and block migrated. Nothing is rescanned: a page's own blocks and the diagnostics the
 * import already reported at a file and line are the whole input. A warning makes its block approximate; an error, or a
 * file with no destination, makes it manual. A file with nothing to report is one full block.
 */
import type { Diagnostic } from "../contracts/index.ts";
import type { ImportAccuracy, ImportBlock, ImportedPage } from "./contract.ts";
import type { ImportMapping } from "./mapping.ts";

/** The three statuses from most to least faithful, so the worst of two wins. */
export const IMPORT_ACCURACIES: readonly ImportAccuracy[] = ["full", "approximate", "manual"];

/** One input file and the accuracy of the blocks it migrated. */
export interface FileAccuracy {
  readonly source: string;
  readonly destination?: string;
  /** The least faithful block's status. */
  readonly status: ImportAccuracy;
  /** In line order; the whole file is one block when the importer recorded none. */
  readonly blocks: readonly ImportBlock[];
}

/** How many files or blocks hold each status. */
export interface AccuracyCounts {
  readonly full: number;
  readonly approximate: number;
  readonly manual: number;
}

/** The whole accuracy report, in mapping order. */
export interface AccuracyReport {
  readonly files: readonly FileAccuracy[];
  readonly counts: { readonly files: AccuracyCounts; readonly blocks: AccuracyCounts };
}

/** The least faithful of two statuses. */
function worst(a: ImportAccuracy, b: ImportAccuracy): ImportAccuracy {
  return IMPORT_ACCURACIES.indexOf(a) >= IMPORT_ACCURACIES.indexOf(b) ? a : b;
}

/** Counts statuses, always naming all three in the same order. */
function tally(statuses: readonly ImportAccuracy[]): AccuracyCounts {
  return {
    full: statuses.filter((status) => status === "full").length,
    approximate: statuses.filter((status) => status === "approximate").length,
    manual: statuses.filter((status) => status === "manual").length,
  };
}

/** One block per diagnostic at this file: a warning is approximate, an error needs a person. */
function reportedBlocks(source: string, diagnostics: readonly Diagnostic[]): ImportBlock[] {
  const blocks: ImportBlock[] = [];
  for (const finding of diagnostics) {
    if (finding.pos?.file !== source) continue;
    blocks.push({
      line: finding.pos.line,
      status: finding.severity === "error" ? "manual" : "approximate",
      note: finding.message,
    });
  }
  return blocks;
}

/**
 * Reports every mapped file in order. An importer's own blocks come first and a diagnostic adds its block at its line;
 * with neither, the file is one block at line 1, full when it has a destination and manual with the mapping's reason
 * when it does not.
 */
export function accuracyReport(
  pages: readonly ImportedPage[],
  mappings: readonly ImportMapping[],
  diagnostics: readonly Diagnostic[],
): AccuracyReport {
  const pageBySource = new Map(pages.map((page) => [page.source, page]));
  const files: FileAccuracy[] = [];
  for (const mapping of mappings) {
    const recorded = pageBySource.get(mapping.source)?.blocks ?? [];
    const blocks = [...recorded, ...reportedBlocks(mapping.source, diagnostics)].sort((a, b) => a.line - b.line);
    const kept = mapping.destination !== undefined;
    const fileBlocks =
      blocks.length > 0
        ? blocks
        : [
            {
              line: 1,
              status: kept ? ("full" as const) : ("manual" as const),
              ...(kept ? {} : { note: mapping.reason ?? "not migrated" }),
            },
          ];
    const status = fileBlocks.reduce<ImportAccuracy>((result, block) => worst(result, block.status), "full");
    files.push({
      source: mapping.source,
      ...(mapping.destination === undefined ? {} : { destination: mapping.destination }),
      status,
      blocks: fileBlocks,
    });
  }
  return {
    files,
    counts: {
      files: tally(files.map((file) => file.status)),
      blocks: tally(files.flatMap((file) => file.blocks.map((block) => block.status))),
    },
  };
}
