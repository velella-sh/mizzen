/**
 * Where every input file goes. A page gets its destination file and the URL that file will answer at; an asset gets
 * its copied path and URL; a config file is merged into `mizzen.yml`; a file with no destination carries the reason.
 */
import type { Diagnostic } from "../contracts/index.ts";
import { permalink } from "../content/permalink.ts";
import type { ImportFile, ImportedAsset, ImportedConfig, ImportedPage } from "./contract.ts";

/** One input path and what the generated project holds for it. */
export interface ImportMapping {
  readonly source: string;
  readonly kind: ImportFile["kind"];
  /** Destination path relative to the generated project; absent when the file is not migrated. */
  readonly destination?: string;
  /** The site-root URL the destination answers at; absent for config and unsupported files. */
  readonly url?: string;
  /** Why no destination exists, or how the file is used when it is not copied as itself. */
  readonly reason?: string;
}

/** The generated config's destination. */
export const CONFIG_DESTINATION = "mizzen.yml";

/** The generated navigation's destination, the default `navigation` path. */
export const NAVIGATION_DESTINATION = "_data/navigation.yml";

/** Where the generated project records every input file's destination and URL. */
export const MAPPING_DESTINATION = ".mizzen-import.json";

/** The record's format version; a reader that does not know it must not guess. */
export const MAPPING_VERSION = 1;

/** Extra report sections the generated record carries beside the mapping, when the command computed them. */
export interface ImportRecordSections {
  readonly accuracy?: unknown;
  readonly coverage?: unknown;
}

/** The mapping record as the generated file's exact text: every input path, sorted by source. */
export function mappingRecord(mappings: readonly ImportMapping[], sections: ImportRecordSections = {}): string {
  const files = [...mappings]
    .sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0))
    .map(({ source, kind, destination, url, reason }) => ({ source, kind, destination, url, reason }));
  return `${JSON.stringify(
    {
      version: MAPPING_VERSION,
      files,
      ...(sections.accuracy === undefined ? {} : { accuracy: sections.accuracy }),
      ...(sections.coverage === undefined ? {} : { coverage: sections.coverage }),
    },
    null,
    2,
  )}\n`;
}

/** What {@link buildMappings} found. */
export interface MappingResult {
  readonly mappings: readonly ImportMapping[];
  readonly diagnostics: readonly Diagnostic[];
}

/** A destination path that stays inside the generated project, or `undefined` when it would escape it. */
export function safeDestination(path: string): string | undefined {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalized === "" || normalized.startsWith("/")) return undefined;
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return undefined;
  return normalized;
}

/** A diagnostic at an input file, naming the path that cannot be written. */
function badDestination(source: string, destination: string): Diagnostic {
  return {
    id: "import.invalid-destination",
    severity: "error",
    message: `\`${destination}\` is not a path inside the generated project; the file is not migrated.`,
    pos: { file: source, line: 1, column: 1, endLine: 1, endColumn: 1 },
  };
}

/**
 * Builds one mapping per input path. A page whose destination is missing or unsafe is reported as an error and gets
 * no destination; a page and an asset that name one destination are an error too, because writing both would lose one.
 */
export function buildMappings(
  files: readonly ImportFile[],
  pages: readonly ImportedPage[],
  assets: readonly ImportedAsset[],
  config: ImportedConfig,
  base = "",
): MappingResult {
  const pageBySource = new Map(pages.map((page) => [page.source, page]));
  const assetBySource = new Map(assets.map((asset) => [asset.source, asset]));
  const diagnostics: Diagnostic[] = [];
  const destinations = new Map<string, string>();
  const mappings: ImportMapping[] = [];

  const claim = (source: string, destination: string): string | undefined => {
    const safe = safeDestination(destination);
    if (safe === undefined) {
      diagnostics.push(badDestination(source, destination));
      return undefined;
    }
    const owner = destinations.get(safe);
    if (owner !== undefined && owner !== source) {
      diagnostics.push({
        id: "import.duplicate-destination",
        severity: "error",
        message: `${source} and ${owner} would both be written to \`${safe}\`; one of them has no destination.`,
        pos: { file: source, line: 1, column: 1, endLine: 1, endColumn: 1 },
      });
      return undefined;
    }
    destinations.set(safe, source);
    return safe;
  };

  for (const file of files) {
    const page = file.kind === "content" ? pageBySource.get(file.path) : undefined;
    if (page !== undefined) {
      const destination = claim(file.path, page.destination);
      if (destination === undefined) mappings.push({ source: file.path, kind: file.kind, reason: file.reason ?? "the destination is invalid" });
      else mappings.push({ source: file.path, kind: file.kind, destination, url: permalink(destination, { base }) });
      continue;
    }
    if (file.kind === "content") {
      mappings.push({ source: file.path, kind: file.kind, reason: file.reason ?? "no page was converted" });
      continue;
    }
    if (file.kind === "config") {
      const destination = claim(file.path, CONFIG_DESTINATION);
      mappings.push({
        source: file.path,
        kind: file.kind,
        ...(destination === undefined
          ? { reason: "the destination is invalid" }
          : { destination, ...(file.path === destination ? {} : { reason: "merged into mizzen.yml" }) }),
      });
      continue;
    }
    const asset = file.kind === "asset" ? assetBySource.get(file.path) : undefined;
    if (asset !== undefined) {
      const destination = claim(file.path, asset.destination);
      if (destination === undefined) mappings.push({ source: file.path, kind: file.kind, reason: file.reason ?? "the destination is invalid" });
      else mappings.push({ source: file.path, kind: file.kind, destination, url: `${base}/${destination}` });
      continue;
    }
    if (file.kind === "asset") {
      mappings.push({ source: file.path, kind: file.kind, reason: file.reason ?? "the asset was not copied" });
      continue;
    }
    mappings.push({ source: file.path, kind: file.kind, reason: file.reason ?? "not supported by the importer" });
  }

  return { mappings, diagnostics };
}
