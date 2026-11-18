/**
 * What a migration carries, per file, before and after. A content page counts the blocks it holds and the internal
 * page links it writes; an asset and an unsupported file count as themselves. The difference between the two columns is
 * what the migration loses, so a page with an unresolved link and an asset that is not copied both show up here.
 */
import type { ImportedPage } from "./contract.ts";
import type { PageLinkCount } from "./links.ts";
import type { ImportMapping } from "./mapping.ts";

/** The four things a migration carries. */
export interface CoverageCounts {
  readonly blocks: number;
  readonly links: number;
  readonly assets: number;
  readonly unsupported: number;
}

/** One file's counts before and after the conversion. */
export interface CoverageDelta {
  readonly before: CoverageCounts;
  readonly after: CoverageCounts;
}

/** One input file's contribution, in mapping order. */
export interface FileCoverage extends CoverageDelta {
  readonly source: string;
  readonly destination?: string;
}

/** The whole coverage report: every file, then their totals. */
export interface CoverageReport {
  readonly files: readonly FileCoverage[];
  readonly totals: CoverageDelta;
}

/** The four measures, in the order a report names them. */
export const COVERAGE_MEASURES = ["blocks", "links", "assets", "unsupported"] as const;

const ZERO: CoverageCounts = { blocks: 0, links: 0, assets: 0, unsupported: 0 };

/** Adds one file's counts into a running total. */
function add(total: CoverageCounts, counts: CoverageCounts): CoverageCounts {
  return {
    blocks: total.blocks + counts.blocks,
    links: total.links + counts.links,
    assets: total.assets + counts.assets,
    unsupported: total.unsupported + counts.unsupported,
  };
}

/**
 * Compares every mapped file. A content page keeps its blocks and rewritten links when it has a destination; an asset
 * is one asset before and, when copied, one after; an unsupported file is one before and none after.
 */
export function coverageReport(
  pages: readonly ImportedPage[],
  mappings: readonly ImportMapping[],
  links: readonly PageLinkCount[],
): CoverageReport {
  const pageBySource = new Map(pages.map((page) => [page.source, page]));
  const linksBySource = new Map(links.map((count) => [count.source, count]));
  const files: FileCoverage[] = [];
  let totals: CoverageDelta = { before: ZERO, after: ZERO };
  for (const mapping of mappings) {
    const kept = mapping.destination !== undefined;
    const blocks = mapping.kind === "content" ? (pageBySource.get(mapping.source)?.blocks?.length ?? 1) : 0;
    const pageLinks = linksBySource.get(mapping.source);
    const before: CoverageCounts = {
      blocks,
      links: pageLinks?.links ?? 0,
      assets: mapping.kind === "asset" ? 1 : 0,
      unsupported: mapping.kind === "unsupported" ? 1 : 0,
    };
    const after: CoverageCounts = {
      blocks: kept ? before.blocks : 0,
      links: pageLinks?.rewritten ?? 0,
      assets: mapping.kind === "asset" && kept ? 1 : 0,
      unsupported: 0,
    };
    files.push({
      source: mapping.source,
      ...(mapping.destination === undefined ? {} : { destination: mapping.destination }),
      before,
      after,
    });
    totals = { before: add(totals.before, before), after: add(totals.after, after) };
  }
  return { files, totals };
}
