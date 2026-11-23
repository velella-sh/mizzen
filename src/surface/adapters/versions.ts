/**
 * Discover product versions: records each data API version the config declares as a `version` item, so a report has an
 * area that counts versions beside the symbols, commands, keys, operations, and fields.
 *
 * A version that is deprecated carries its sunset and successor, and its successor is a stability signal: a version a
 * release replaced is `deprecated` even before the config marks it so. The span points at the `api.version` key in the
 * site config file, or at the first line of the config when the file cannot be located exactly.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { SiteConfig } from "../../contracts/config.ts";
import type { SourcePos } from "../../contracts/source.ts";
import type { SurfaceAdapterResult, SurfaceFinding, SurfaceItem, SurfaceStability } from "../../contracts/surface.ts";
import { itemId, sortItems } from "../contract.ts";

/** What a version discovery needs. */
export interface DiscoverVersionsOptions {
  /** The site root, to locate the config key's line. */
  readonly root: string;
  readonly config: SiteConfig;
  /** The config file's site-relative path. Default `mizzen.yml`. */
  readonly configFile?: string;
  /** The version the product ships in, so its items carry an introduction version. Default: none. */
  readonly version?: string;
}

/** The line `api.version` (or a `vN` under `api.versions`) is declared on, found by a small key scan of the config. */
async function versionLines(root: string, file: string): Promise<Map<string, number>> {
  const found = new Map<string, number>();
  let text: string;
  try {
    text = await readFile(resolve(root, file), "utf8");
  } catch {
    return found;
  }
  let inApi = false;
  let inVersions = false;
  let apiIndent = -1;
  let versionsIndent = -1;
  for (const [index, line] of text.split("\n").entries()) {
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (/^api:\s*$/.test(trimmed)) {
      inApi = true;
      inVersions = false;
      apiIndent = indent;
      continue;
    }
    if (inApi && indent <= apiIndent) {
      inApi = false;
      inVersions = false;
    }
    if (!inApi) continue;
    const version = /^version:\s*["']?([^"'\s#]+)["']?/.exec(trimmed);
    if (version !== null && !inVersions && !found.has(version[1]!)) {
      found.set(version[1]!, index + 1);
      continue;
    }
    if (/^versions:\s*$/.test(trimmed)) {
      inVersions = true;
      versionsIndent = indent;
      continue;
    }
    if (inVersions) {
      if (indent <= versionsIndent) {
        inVersions = false;
        continue;
      }
      const key = /^(v[1-9][0-9]*):\s*$/.exec(trimmed);
      if (key !== null && !found.has(key[1]!)) found.set(key[1]!, index + 1);
    }
  }
  return found;
}

/** The stability a version shows: `deprecated` when the config marks it so. */
function stabilityOf(entry: { deprecated?: boolean }): SurfaceStability {
  return entry.deprecated === true ? "deprecated" : "stable";
}

/** A point span at a config line. */
function spanOf(file: string, line: number): SourcePos {
  return { file, line, column: 1, endLine: line, endColumn: 1 };
}

/**
 * Reads every data API version the config declares. Without an `api` key there are no version items, which is a site
 * with no versioned API rather than a gap. A version whose sunset or successor is set without `deprecated` is a
 * finding, mirroring the data API's own three rules.
 */
export async function discoverVersions(options: DiscoverVersionsOptions): Promise<SurfaceAdapterResult> {
  const file = options.configFile ?? "mizzen.yml";
  const api = options.config.api;
  const items: SurfaceItem[] = [];
  const findings: SurfaceFinding[] = [];
  if (api === undefined) return { version: 1, area: "version", items, findings };
  const lines = await versionLines(options.root, file);

  const add = (version: string, entry: { deprecated?: boolean; sunset?: string; successor?: string }): void => {
    const introduced = options.version ?? "unknown";
    const versionInfo = {
      introduced,
      ...(entry.successor === undefined ? {} : { successor: entry.successor }),
    };
    items.push({
      id: itemId("version", version),
      area: "version",
      kind: "version",
      name: version,
      source: spanOf(file, lines.get(version) ?? 1),
      stability: stabilityOf(entry),
      ...(entry.sunset === undefined ? {} : { signature: `sunset ${entry.sunset}` }),
      version: versionInfo,
    });
    if (entry.deprecated !== true && (entry.sunset !== undefined || entry.successor !== undefined)) {
      findings.push({
        code: "surface.version-deprecation",
        severity: "error",
        message: `Version "${version}" names a sunset or successor but is not marked \`deprecated: true\`.`,
        pos: spanOf(file, lines.get(version) ?? 1),
      });
    }
  };

  add(api.version, {});
  for (const [version, entry] of Object.entries(api.versions ?? {})) {
    add(version, {
      ...(entry.deprecated === undefined ? {} : { deprecated: entry.deprecated }),
      ...(entry.sunset === undefined ? {} : { sunset: entry.sunset }),
      ...(entry.successor === undefined ? {} : { successor: entry.successor }),
    });
  }
  return { version: 1, area: "version", items: sortItems(items), findings };
}
