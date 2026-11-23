/**
 * Build the versioned surface report: the adapters' items, each one's documentation state, the gaps with their kind, id,
 * source, and introduction version, the documented exclusions kept apart from gaps, and the counts and percentages by
 * area.
 *
 * A gap's `introduced` is the item's own version metadata, so a report names when a missing item arrived. An item the
 * configuration excludes is never in scope: it is counted in `excluded`, left out of `documented`, `partial`,
 * `undocumented`, and `total`, and never appears in `gaps`, so a documented exclusion is not a gap.
 */
import type { SurfaceConfig } from "../contracts/config.ts";
import type { Diagnostic } from "../contracts/diagnostic.ts";
import type { Site } from "../contracts/content.ts";
import type {
  SurfaceArea,
  SurfaceAreaCoverage,
  SurfaceCounts,
  SurfaceCoverage,
  SurfaceExclusion,
  SurfaceGap,
  SurfaceItem,
  SurfaceMatch,
  SurfaceReport,
} from "../contracts/surface.ts";
import { SURFACE_AREAS, byCodePoint, sortItems } from "./contract.ts";
import { discoverSymbols } from "./adapters/symbols.ts";
import { discoverConfig } from "./adapters/config.ts";
import { discoverOpenApi } from "./adapters/openapi.ts";
import { discoverData } from "./adapters/data.ts";
import { discoverVersions } from "./adapters/versions.ts";
import { documentationPages, matchDocumentation } from "./match.ts";
import type { SurfaceAdapterResult, SurfaceFinding } from "../contracts/surface.ts";

/** What a report needs. */
export interface SurfaceReportOptions {
  /** The site root. */
  readonly root: string;
  /** The built site model, for the data pages and the config. */
  readonly site: Site;
  /** The product version the surface is inventoried at, when known. */
  readonly version?: string;
  /** The config file's site-relative path, default `mizzen.yml`. */
  readonly configFile?: string;
}

/** An empty accumulator of the counts. */
function emptyCounts(): { -readonly [K in keyof SurfaceCounts]: number } {
  return { documented: 0, partial: 0, undocumented: 0, excluded: 0, total: 0 };
}

/** A percentage rounded to two decimals, or `null` when the total is zero. */
function percent(part: number, total: number): number | null {
  if (total === 0) return null;
  return Math.round((part / total) * 10_000) / 100;
}

/** Adds one item's state to an accumulator. */
function tally(counts: ReturnType<typeof emptyCounts>, match: SurfaceMatch, excluded: boolean): void {
  if (excluded) {
    counts.excluded += 1;
    return;
  }
  counts.total += 1;
  if (match.state === "complete") counts.documented += 1;
  else if (match.state === "partial") counts.partial += 1;
  else counts.undocumented += 1;
}

/** The coverage of one accumulator. */
function coverageOf(counts: SurfaceCounts): { documentedPercent: number | null; undocumentedPercent: number | null } {
  return {
    documentedPercent: percent(counts.documented, counts.total),
    undocumentedPercent: percent(counts.partial + counts.undocumented, counts.total),
  };
}

/** The whole coverage, with one row per area in report order. */
function coverageFrom(counts: SurfaceCounts, byArea: ReadonlyMap<SurfaceArea, SurfaceCounts>): SurfaceCoverage {
  const areas: SurfaceAreaCoverage[] = SURFACE_AREAS.map((area) => {
    const areaCounts = byArea.get(area) ?? { documented: 0, partial: 0, undocumented: 0, excluded: 0, total: 0 };
    return { area, counts: areaCounts, ...coverageOf(areaCounts) };
  });
  return { counts, ...coverageOf(counts), areas };
}

/** Reads the configured adapter module and validates its result; a bad module is one error and no items. */
async function externalAdapter(root: string, source: string, area: SurfaceArea): Promise<SurfaceAdapterResult | undefined> {
  const { pathToFileURL } = await import("node:url");
  const { resolve } = await import("node:path");
  try {
    const module = (await import(pathToFileURL(resolve(root, source)).href)) as { default?: unknown; adapter?: unknown };
    const candidate = module.default ?? module.adapter;
    if (typeof candidate !== "function") return undefined;
    const result = (await (candidate as () => unknown | Promise<unknown>)()) as unknown;
    const { validateAdapterResult } = await import("./contract.ts");
    return validateAdapterResult(result);
  } catch (error) {
    const { SurfaceContractError } = await import("./contract.ts");
    if (error instanceof SurfaceContractError) throw error;
    throw new Error(`Adapter "${source}" for area "${area}" failed: ${error instanceof Error ? error.message : String(error)}.`);
  }
}

/** The OpenAPI document the site pins, from its `apiReference` key's `source`. */
function openApiSource(site: Site): string | undefined {
  return site.config.apiReference?.source;
}

/**
 * Builds the report from a built site: runs the built-in adapters, the site's `surface.adapters`, and any external
 * OpenAPI document the site pins, matches the documentation, and computes the gaps and the coverage.
 *
 * An adapter whose result is not the contract is a `surface.invalid-adapter` error and contributes no items, so the
 * report never counts a partial adapter.
 */
export async function surfaceReportOf(options: SurfaceReportOptions): Promise<{ report: SurfaceReport; diagnostics: readonly Diagnostic[] }> {
  const { root, site, version } = options;
  const config: SurfaceConfig | undefined = site.config.surface;
  const diagnostics: Diagnostic[] = [];

  const results: SurfaceAdapterResult[] = [];
  const run = async (area: SurfaceArea, read: () => Promise<SurfaceAdapterResult>): Promise<void> => {
    try {
      results.push(await read());
    } catch (error) {
      diagnostics.push({
        id: "surface.invalid-adapter",
        severity: "error",
        message: `The ${area} adapter was rejected: ${error instanceof Error ? error.message : String(error)}.`,
      });
    }
  };

  // The CLI adapter imports the whole command-line parser, so it is loaded only when a surface report is asked for,
  // never by a build that does not declare `surface`.
  const { discoverCommands } = await import("./adapters/cli.ts");
  await run("cli", () => discoverCommands(version === undefined ? {} : { version }));
  await run("config", () => discoverConfig(version === undefined ? {} : { version }));
  // The api area reads the package entry the config names; without one there is no public API surface to inventory.
  const entry = config?.package;
  if (entry !== undefined) {
    await run("api", () => discoverSymbols({ entry, root, ...(version === undefined ? {} : { version }) }));
  }
  if (openApiSource(site) !== undefined) {
    await run("openapi", () => discoverOpenApi({ source: openApiSource(site)!, root, ...(version === undefined ? {} : { version }) }));
  }
  await run("data", () => discoverData({ root, config: site.config, collections: site.collections, ...(version === undefined ? {} : { version }) }));
  await run("version", () => discoverVersions({ root, config: site.config, ...(options.configFile === undefined ? {} : { configFile: options.configFile }), ...(version === undefined ? {} : { version }) }));

  // The package entry point is the api area; a site that names one reads it, so a docs site for another package can.
  if (config?.adapters !== undefined) {
    for (const adapter of config.adapters) {
      try {
        const result = await externalAdapter(root, adapter.source, adapter.area);
        if (result === undefined) {
          diagnostics.push({ id: "surface.adapter-shape", severity: "error", message: `Adapter "${adapter.source}" does not export a default function.` });
          continue;
        }
        results.push(result);
      } catch (error) {
        diagnostics.push({
          id: "surface.invalid-adapter",
          severity: "error",
          message: `The ${adapter.area} adapter "${adapter.source}" was rejected: ${error instanceof Error ? error.message : String(error)}.`,
        });
      }
    }
  }

  const excluded = new Set((config?.exclude ?? []).map((entry) => entry.id));
  const exclusions: SurfaceExclusion[] = (config?.exclude ?? []).map((entry) => ({ id: entry.id, reason: entry.reason })).sort((a, b) => byCodePoint(a.id, b.id));
  const findings: SurfaceFinding[] = results.flatMap((result) => result.findings);
  const items = sortItems(dedupe(results.flatMap((result) => result.items)));

  const pages = documentationPages(site.pages, config?.docs ?? ["."]);
  const matched = await matchDocumentation({ pages, items });
  diagnostics.push(...matched.diagnostics);

  const counts = emptyCounts();
  const byArea = new Map<SurfaceArea, ReturnType<typeof emptyCounts>>();
  const gaps: SurfaceGap[] = [];
  for (const item of items) {
    const match = matched.matches.find((candidate) => candidate.item === item.id);
    const state = match?.state ?? "missing";
    const isExcluded = excluded.has(item.id);
    tally(counts, { item: item.id, area: item.area, state, evidence: [] }, isExcluded);
    const areaCounts = byArea.get(item.area) ?? emptyCounts();
    tally(areaCounts, { item: item.id, area: item.area, state, evidence: [] }, isExcluded);
    byArea.set(item.area, areaCounts);
    if (!isExcluded && state !== "complete") {
      gaps.push({
        item: item.id,
        area: item.area,
        kind: item.kind,
        source: item.source,
        introduced: item.version?.introduced ?? "unknown",
        gap: state === "partial" ? "partial" : "undocumented",
      });
    }
  }

  const report: SurfaceReport = {
    version: 1,
    source: version === undefined ? {} : { version },
    items,
    matches: matched.matches,
    gaps: gaps.sort((a, b) => byCodePoint(a.area, b.area) || byCodePoint(a.item, b.item)),
    exclusions,
    coverage: coverageFrom(counts, byArea),
    findings: findings.sort((a, b) => byCodePoint(a.code, b.code) || byCodePoint(a.message, b.message)),
  };

  for (const finding of report.findings) {
    diagnostics.push({
      id: finding.code,
      severity: finding.severity,
      message: finding.message,
      ...(finding.pos === undefined ? {} : { pos: finding.pos }),
    });
  }
  return { report, diagnostics };
}

/** Keeps the first item of each id, so two adapters that read the same name contribute one item. */
function dedupe(items: readonly SurfaceItem[]): SurfaceItem[] {
  const seen = new Map<string, SurfaceItem>();
  for (const item of items) if (!seen.has(item.id)) seen.set(item.id, item);
  return [...seen.values()];
}

/** The per-page surface summary the `page-json` output publishes: the counts, never the whole item list. */
export interface PageSurface {
  readonly coverage: SurfaceCoverage;
  readonly gaps: number;
  readonly exclusions: number;
}

/** The small surface summary a page JSON carries, so an agent reads the counts without the full report. */
export function pageSurfaceOf(report: SurfaceReport): PageSurface {
  return {
    coverage: report.coverage,
    gaps: report.gaps.length,
    exclusions: report.exclusions.length,
  };
}
