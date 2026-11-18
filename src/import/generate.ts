/**
 * Writes a mapped migration to a separate folder. The destination must stay outside the source folder; text is written
 * with LF and in code-point order, so two runs produce the same folder.
 */
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { Diagnostic } from "../contracts/index.ts";
import type { ImportedAsset, ImportedConfig, ImportedPage, ImportSource } from "./contract.ts";
import { CONFIG_DESTINATION, type ImportMapping } from "./mapping.ts";

/** Everything the generator may write, in the destinations the mapping chose. */
export interface GenerateRequest {
  readonly source: ImportSource;
  /** The folder to create or fill; must be outside the source tree. */
  readonly destination: string;
  readonly mappings: readonly ImportMapping[];
  readonly pages: readonly ImportedPage[];
  readonly assets: readonly ImportedAsset[];
  readonly config: ImportedConfig;
}

/** The files written, relative to the destination, and every reason nothing was written. */
export interface GenerateResult {
  readonly files: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
}

type Target =
  | { readonly kind: "text"; readonly source?: string; readonly destination: string; readonly contents: string }
  | { readonly kind: "bytes"; readonly source: string; readonly destination: string; readonly contents: Uint8Array };

/** A diagnostic at one input file, or at the destination when no input file is to blame. */
function finding(id: string, message: string, source?: string): Diagnostic {
  return {
    id,
    severity: "error",
    message,
    ...(source === undefined
      ? {}
      : { pos: { file: source, line: 1, column: 1, endLine: 1, endColumn: 1 } }),
  };
}

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Every file the mapping promises, plus the config. */
function targetsOf(request: GenerateRequest): Target[] {
  const pageBySource = new Map(request.pages.map((page) => [page.source, page]));
  const assetBySource = new Map(request.assets.map((asset) => [asset.source, asset]));
  const targets: Target[] = [
    {
      kind: "text",
      destination: CONFIG_DESTINATION,
      contents: request.config.contents,
      ...(request.config.source === undefined ? {} : { source: request.config.source }),
    },
  ];
  for (const mapping of request.mappings) {
    const { destination } = mapping;
    if (destination === undefined || mapping.kind === "config" || mapping.kind === "unsupported") continue;
    if (mapping.kind === "content") {
      const page = pageBySource.get(mapping.source);
      if (page !== undefined) targets.push({ kind: "text", source: page.source, destination, contents: page.contents });
      continue;
    }
    const asset = assetBySource.get(mapping.source);
    if (asset !== undefined) {
      targets.push({ kind: "bytes", source: asset.source, destination, contents: request.source.bytes(asset.source) });
    }
  }
  return targets;
}

/** Why `destination` cannot receive this migration, if it cannot. */
function destinationProblem(sourceRoot: string, destination: string): Diagnostic | undefined {
  const realSource = realpathSync(sourceRoot);
  const realDestination = existsSync(destination) ? realpathSync(destination) : destination;
  if (realDestination === realSource || realDestination.startsWith(`${realSource}${sep}`)) {
    return finding("import.destination-in-source", `\`${destination}\` is inside the source folder; choose a folder outside \`${sourceRoot}\`.`);
  }
  return undefined;
}

/** Writes the config, pages, and assets in code-point order. */
export function generateProject(request: GenerateRequest): GenerateResult {
  const destination = resolve(request.destination);
  const sourceRoot = resolve(request.source.root);
  const diagnostics: Diagnostic[] = [];
  const problem = destinationProblem(sourceRoot, destination);
  if (problem !== undefined) diagnostics.push(problem);
  if (diagnostics.some((entry) => entry.severity === "error")) return { files: [], diagnostics };

  const ordered = targetsOf(request).sort((a, b) => byCodePoint(a.destination, b.destination));
  mkdirSync(destination, { recursive: true });
  const files: string[] = [];
  for (const target of ordered) {
    const path = join(destination, target.destination);
    mkdirSync(dirname(path), { recursive: true });
    if (target.kind === "text") writeFileSync(path, target.contents.replace(/\r\n?/g, "\n"), "utf8");
    else writeFileSync(path, target.contents);
    files.push(target.destination);
  }
  return { files, diagnostics };
}
