/**
 * Writes a mapped migration to a separate folder. Nothing is written until every target has been checked: the
 * destination must be empty, stay outside the source folder, and hold no two files at one path. Text is written with
 * LF and in code-point order, so two runs produce the same folder.
 */
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { Diagnostic } from "../contracts/index.ts";
import type { ImportedAsset, ImportedConfig, ImportedPage, ImportSource } from "./contract.ts";
import { CONFIG_DESTINATION, safeDestination, type ImportMapping } from "./mapping.ts";

/** Everything the generator may write, in the destinations the mapping chose. */
export interface GenerateRequest {
  readonly source: ImportSource;
  /** The folder to create or fill; must be outside the source tree and empty. */
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

/** Every file the mapping promises, plus the config, before any path is trusted. */
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

/** The first path below `root`, in code-point order, or `undefined` when the folder is empty. */
function firstEntry(root: string): string | undefined {
  const entries = readdirSync(root, { recursive: true, encoding: "utf8" }).sort(byCodePoint);
  return entries[0] === undefined ? undefined : join(root, entries[0]);
}

/** Why `destination` cannot receive this migration, if it cannot. */
function destinationProblem(sourceRoot: string, destination: string): Diagnostic | undefined {
  const realSource = realpathSync(sourceRoot);
  const realDestination = existsSync(destination) ? realpathSync(destination) : destination;
  if (realDestination === realSource || realDestination.startsWith(`${realSource}${sep}`)) {
    return finding("import.destination-in-source", `\`${destination}\` is inside the source folder; choose a folder outside \`${sourceRoot}\`.`);
  }
  let exists = false;
  try {
    exists = statSync(destination).isDirectory();
  } catch {
    return undefined;
  }
  if (!exists) return finding("import.destination-not-folder", `\`${destination}\` exists and is not a folder.`);
  const first = firstEntry(destination);
  if (first !== undefined) {
    return finding("import.destination-not-empty", `\`${destination}\` is not empty; it already holds \`${first}\`; choose an empty folder.`);
  }
  return undefined;
}

/**
 * Validates every target, then writes the config, pages, and assets. A refused destination or one conflicting target
 * leaves the destination exactly as it was.
 */
export function generateProject(request: GenerateRequest): GenerateResult {
  const destination = resolve(request.destination);
  const sourceRoot = resolve(request.source.root);
  const diagnostics: Diagnostic[] = [];
  const problem = destinationProblem(sourceRoot, destination);
  if (problem !== undefined) diagnostics.push(problem);

  const targets = targetsOf(request);
  const seen = new Map<string, string | undefined>();
  const checked: Target[] = [];
  for (const target of targets) {
    const safe = safeDestination(target.destination);
    if (safe === undefined) {
      diagnostics.push(finding("import.invalid-destination", `\`${target.destination}\` is not a path inside the generated project.`, target.source));
      continue;
    }
    if (seen.has(safe)) {
      const owner = seen.get(safe) ?? "the generated config";
      const source = target.source ?? "the generated config";
      diagnostics.push(
        finding("import.duplicate-destination", `${source} and ${owner} would both be written to \`${safe}\`; one of them has no destination.`, target.source),
      );
      continue;
    }
    seen.set(safe, target.source);
    checked.push(target);
  }

  const destinations = new Set(checked.map((target) => target.destination));
  for (const target of checked) {
    const segments = target.destination.split("/");
    for (let count = 1; count < segments.length; count++) {
      const parent = segments.slice(0, count).join("/");
      if (destinations.has(parent)) {
        diagnostics.push(finding("import.destination-conflict", `\`${parent}\` is a file and a parent folder of \`${target.destination}\`.`));
        break;
      }
    }
  }

  if (diagnostics.some((entry) => entry.severity === "error")) return { files: [], diagnostics };

  const ordered = [...checked].sort((a, b) => byCodePoint(a.destination, b.destination));
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
