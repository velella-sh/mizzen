/**
 * `mizzen import <name> <dir> [--out <folder>]`: previews a migration, or writes it to a separate folder. The named
 * importer reads the source, the shared command builds one mapping per input file, and the report lists the proposed
 * destinations and the items a person still has to do. A preview writes nothing; `--out` writes the mapped project and
 * never touches the source.
 */
import { resolve } from "node:path";
import type { Diagnostic } from "../contracts/index.ts";
import { FILE_KINDS } from "../import/inventory.ts";
import type { Importer } from "../import/contract.ts";
import { CONFIG_DESTINATION, buildMappings, type ImportMapping } from "../import/mapping.ts";
import { generateProject } from "../import/generate.ts";
import { plainImporter } from "../import/plain.ts";
import { inventoryOf } from "../import/inventory.ts";
import { readImportSource } from "../import/source.ts";

/** The importers `mizzen import <name>` can select. */
export const IMPORTERS: readonly Importer[] = [plainImporter];

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

/** The destination a generation filled, for a report that must not claim it was a preview. */
export interface GeneratedDestination {
  readonly path: string;
  readonly files: readonly string[];
}

/**
 * The whole report, in inventory order: the non-empty kinds, then the manual items, then the counts. `generated` says
 * the importer wrote the config rather than converting one, so its destination is reported too. `destination` is
 * absent for a preview and names the folder just written for a generation.
 */
export function importReport(
  name: string,
  root: string,
  mappings: readonly ImportMapping[],
  generated: boolean,
  diagnostics: readonly Diagnostic[],
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
  lines.push("Manual items:");
  if (diagnostics.length === 0) lines.push("  none");
  else for (const finding of diagnostics) lines.push(diagnosticLine(finding));
  const counts = FILE_KINDS.map((kind) => `${mappings.filter((mapping) => mapping.kind === kind).length} ${kind}`);
  const errors = diagnostics.filter((finding) => finding.severity === "error").length;
  lines.push(`${counted(mappings.length, "file")}: ${counts.join(", ")}.`);
  lines.push(`${counted(diagnostics.length, "manual item")}, ${counted(errors, "error")}.`);
  return `${lines.join("\n")}\n`;
}

/**
 * Reads the source, maps every file, prints the preview, and exits 1 when a mapping is an error. With `out`, writes the
 * mapped project there instead, but only when nothing is an error and the destination is outside the source.
 */
export async function runImport(name: string, root: string, io: ImportIo, out?: string): Promise<number> {
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
  const found = [...outcome.diagnostics, ...diagnostics];
  if (out === undefined) {
    io.log(importReport(name, source.root, mappings, outcome.config.source === undefined, found).replace(/\n$/, ""));
    return found.some((finding) => finding.severity === "error") ? 1 : 0;
  }

  const destination = resolve(out);
  const generated = found.some((finding) => finding.severity === "error")
    ? { files: [] as readonly string[], diagnostics: [] as readonly Diagnostic[] }
    : generateProject({ source, destination, mappings, pages: outcome.pages, assets: outcome.assets, config: outcome.config });
  const all = [...found, ...generated.diagnostics];
  io.log(
    importReport(name, source.root, mappings, outcome.config.source === undefined, all, { path: destination, files: generated.files }).replace(/\n$/, ""),
  );
  return all.some((finding) => finding.severity === "error") ? 1 : 0;
}
