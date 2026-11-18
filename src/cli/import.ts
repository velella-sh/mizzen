/**
 * `mizzen import <name> <dir> [--out <folder>]`: previews a migration, or writes it to a separate folder. The named
 * importer reads the source, the shared command builds one mapping per input file, rewrites links to the mapped
 * destination, and the report lists the proposed destinations and the items a person still has to do. A preview writes
 * nothing; `--out` writes the mapped project and never touches the source.
 */
import { resolve } from "node:path";
import type { Diagnostic } from "../contracts/index.ts";
import { FILE_KINDS } from "../import/inventory.ts";
import type { Importer } from "../import/contract.ts";
import { accuracyReport, type AccuracyCounts, type AccuracyReport } from "../import/accuracy.ts";
import { COVERAGE_MEASURES, coverageReport, type CoverageReport, type FileCoverage } from "../import/coverage.ts";
import { CONFIG_DESTINATION, buildMappings, type ImportMapping } from "../import/mapping.ts";
import { generateProject } from "../import/generate.ts";
import { rewriteLinks } from "../import/links.ts";
import { plainImporter } from "../import/plain.ts";
import { vitepressImporter } from "../import/vitepress/importer.ts";
import { inventoryOf } from "../import/inventory.ts";
import { readImportSource } from "../import/source.ts";

/** The importers `mizzen import <name>` can select. */
export const IMPORTERS: readonly Importer[] = [plainImporter, vitepressImporter];

/** What the command prints to. */
export interface ImportIo {
  readonly log: (message: string) => void;
  readonly error: (message: string) => void;
}

/** The importer with this name, or `undefined` when the command does not ship it. */
export function importerNamed(name: string): Importer | undefined {
  return IMPORTERS.find((importer) => importer.name === name);
}

/** A noun with its count, so a summary reads `1 file` and `2 files`. */
function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** One mapping as a report line: its destination and URL, or the reason it has none. */
function mappingLine(mapping: ImportMapping): string {
  if (mapping.destination === undefined) return `  ${mapping.source}  (${mapping.reason ?? "not migrated"})`;
  const used = mapping.reason === undefined ? "" : `  (${mapping.reason})`;
  return `  ${mapping.source} -> ${mapping.destination}${mapping.url === undefined ? used : `  ${mapping.url}${used}`}`;
}

/** One diagnostic as a report line, pointing at its file when it has one. */
function diagnosticLine(finding: Diagnostic): string {
  const where = finding.pos === undefined ? "" : `${finding.pos.file}:${finding.pos.line}:${finding.pos.column}  `;
  return `  ${where}${finding.id}  ${finding.message}`;
}

/** Status counts as `4 full, 0 approximate, 1 manual`. */
function statusCounts(counts: AccuracyCounts): string {
  return `${counts.full} full, ${counts.approximate} approximate, ${counts.manual} manual`;
}

/** The accuracy section: file and block counts, then every file and each block that is not full. */
function accuracyLines(report: AccuracyReport): string[] {
  const blocks = report.counts.blocks;
  const lines = [
    "Accuracy:",
    `  ${counted(report.files.length, "file")}: ${statusCounts(report.counts.files)}`,
    `  ${counted(blocks.full + blocks.approximate + blocks.manual, "block")}: ${statusCounts(blocks)}`,
  ];
  for (const file of report.files) {
    lines.push(`  ${file.source}  ${file.status}`);
    for (const block of file.blocks) {
      if (block.status === "full") continue;
      const note = block.note === undefined ? "" : `  ${block.note}`;
      lines.push(`    ${file.source}:${block.line}  ${block.status}${note}`);
    }
  }
  return lines;
}

/** The measures that differ from zero before or after, as `blocks 1 -> 1, links 2 -> 1`; absent when all are zero. */
function coverageLine(file: FileCoverage): string | undefined {
  const parts = COVERAGE_MEASURES.filter((measure) => file.before[measure] !== 0 || file.after[measure] !== 0).map(
    (measure) => `${measure} ${file.before[measure]} -> ${file.after[measure]}`,
  );
  return parts.length === 0 ? undefined : `  ${file.source}  ${parts.join(", ")}`;
}

/** The coverage section: every file whose counts are not all zero, then the totals of all four measures. */
function coverageLines(report: CoverageReport): string[] {
  const lines = ["Coverage:"];
  for (const file of report.files) {
    const line = coverageLine(file);
    if (line !== undefined) lines.push(line);
  }
  const totals = COVERAGE_MEASURES.map(
    (measure) => `${measure} ${report.totals.before[measure]} -> ${report.totals.after[measure]}`,
  );
  lines.push(`  totals  ${totals.join(", ")}`);
  return lines;
}

/** The destination a generation filled, for a report that must not claim it was a preview. */
export interface GeneratedDestination {
  readonly path: string;
  readonly files: readonly string[];
}

/**
 * The whole report, in inventory order: the non-empty kinds, the accuracy and coverage of every file, then the manual
 * items and the counts. `generated` says the importer wrote the config rather than converting one, so its destination
 * is reported too. `destination` is absent for a preview and names the folder just written for a generation.
 */
export function importReport(
  name: string,
  root: string,
  mappings: readonly ImportMapping[],
  generated: boolean,
  diagnostics: readonly Diagnostic[],
  accuracy: AccuracyReport,
  coverage: CoverageReport,
  destination?: GeneratedDestination,
): string {
  const header =
    destination === undefined
      ? `${name} import of ${root} (preview; nothing is written)`
      : `${name} import of ${root} into ${destination.path} (${counted(destination.files.length, "file")} written)`;
  const lines = [header];
  for (const kind of FILE_KINDS) {
    const group = mappings.filter((mapping) => mapping.kind === kind);
    if (kind === "config" && generated) {
      lines.push("config:", `  (generated) -> ${CONFIG_DESTINATION}`);
    } else if (group.length === 0) continue;
    else lines.push(`${kind}:`);
    for (const mapping of group) lines.push(mappingLine(mapping));
  }
  lines.push(...accuracyLines(accuracy), ...coverageLines(coverage));
  lines.push("Manual items:");
  if (diagnostics.length === 0) lines.push("  none");
  else for (const finding of diagnostics) lines.push(diagnosticLine(finding));
  const counts = FILE_KINDS.map((kind) => `${mappings.filter((mapping) => mapping.kind === kind).length} ${kind}`);
  const errors = diagnostics.filter((finding) => finding.severity === "error").length;
  lines.push(`${counted(mappings.length, "file")}: ${counts.join(", ")}.`);
  lines.push(`${counted(diagnostics.length, "manual item")}, ${counted(errors, "error")}.`);
  return `${lines.join("\n")}\n`;
}

/** The policy that decides whether the items a person still has to do fail the command. */
export interface ImportPolicy {
  /** Exit 1 while any manual item has no recorded decision. */
  readonly failOnManual?: boolean;
  /** Diagnostic ids recorded as reviewed; an item whose id is here no longer fails the policy. */
  readonly allow?: readonly string[];
}

/** How many manual items no recorded decision covers. */
function unresolvedItems(diagnostics: readonly Diagnostic[], policy: ImportPolicy): number {
  const allow = policy.allow ?? [];
  return diagnostics.filter((finding) => !allow.includes(finding.id)).length;
}

/** 1 when an error needs fixing or the policy is on and an item is unresolved, else 0. */
function importStatus(diagnostics: readonly Diagnostic[], policy: ImportPolicy): number {
  if (diagnostics.some((finding) => finding.severity === "error")) return 1;
  return policy.failOnManual === true && unresolvedItems(diagnostics, policy) > 0 ? 1 : 0;
}

/**
 * Reads the source, maps every file, prints the preview, and exits 1 when a mapping is an error. With `out`, writes the
 * mapped project there instead, but only when nothing is an error and the destination is empty and outside the source.
 * `policy` can also fail the command while a manual item lacks a recorded decision.
 */
export async function runImport(
  name: string,
  root: string,
  io: ImportIo,
  out?: string,
  policy: ImportPolicy = {},
): Promise<number> {
  const importer = importerNamed(name);
  if (importer === undefined) {
    const names = IMPORTERS.map((known) => known.name).join(", ");
    io.error(`mizzen: unknown importer: ${name}; choose ${names}`);
    return 2;
  }
  const source = readImportSource(resolve(root));
  const outcome = await importer.import(source);
  const { files } = inventoryOf(source.files, outcome.files);
  const { mappings, diagnostics } = buildMappings(files, outcome.pages, outcome.assets, outcome.config);
  const links = rewriteLinks(outcome.pages, mappings);
  const found = [...outcome.diagnostics, ...diagnostics, ...links.diagnostics];
  const accuracy = accuracyReport(links.pages, mappings, found);
  const coverage = coverageReport(links.pages, mappings, links.counts);
  if (out === undefined) {
    io.log(
      importReport(name, source.root, mappings, outcome.config.source === undefined, found, accuracy, coverage).replace(/\n$/, ""),
    );
    return importStatus(found, policy);
  }

  const destination = resolve(out);
  const generated = found.some((finding) => finding.severity === "error")
    ? { files: [] as readonly string[], diagnostics: [] as readonly Diagnostic[] }
    : generateProject({
        source,
        destination,
        mappings,
        pages: links.pages,
        assets: outcome.assets,
        config: outcome.config,
        ...(outcome.navigation === undefined ? {} : { navigation: outcome.navigation }),
        sections: { accuracy, coverage },
      });
  const all = [...found, ...generated.diagnostics];
  io.log(
    importReport(name, source.root, mappings, outcome.config.source === undefined, all, accuracy, coverage, {
      path: destination,
      files: generated.files,
    }).replace(/\n$/, ""),
  );
  return importStatus(all, policy);
}
