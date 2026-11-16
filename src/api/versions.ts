/**
 * The versions of the data API: the current one (`api.version` with `api.collections`) and the further ones under
 * `api.versions`. Each is published under its own `api/<version>/` folder with its own field lists; a version marked
 * deprecated says so in its index, with the date after which it may go and the version to move to.
 *
 * Removing a version is the one change this module cannot judge: it sees only the config. `mizzen api check` compares
 * with the earlier build and refuses to let a version vanish while that build did not mark it deprecated.
 */
import type { Diagnostic, Site } from "../contracts/index.ts";
import type { ApiCollectionConfig } from "../contracts/index.ts";

/** One version to publish. */
export interface ApiVersion {
  readonly version: string;
  readonly collections: Readonly<Record<string, ApiCollectionConfig>>;
  readonly status: "current" | "deprecated";
  readonly sunset: string | null;
  readonly successor: string | null;
}

/** Every version the config publishes, sorted by number; reports a deprecation that is incomplete or points nowhere. */
export function apiVersions(site: Site, report: (diagnostic: Diagnostic) => void): ApiVersion[] {
  const api = site.config.api;
  if (api === undefined) return [];
  const out: ApiVersion[] = [{ version: api.version, collections: api.collections, status: "current", sunset: null, successor: null }];
  const known = new Set([api.version, ...Object.keys(api.versions ?? {})]);
  for (const [version, entry] of Object.entries(api.versions ?? {})) {
    if (version === api.version) {
      report({
        id: "api.version-current",
        severity: "error",
        message: `api.versions lists "${version}", which is already the current version.`,
        help: "Keep the current version in `api.version` and `api.collections`, and list only the others under `api.versions`.",
      });
      continue;
    }
    const deprecated = entry.deprecated === true;
    if (deprecated) {
      if (entry.sunset === undefined || entry.successor === undefined) {
        report({
          id: "api.version-deprecation",
          severity: "error",
          message: `The deprecated version ${version} needs a "sunset" date and a "successor".`,
          help: `Add \`sunset: YYYY-MM-DD\` and \`successor: ${api.version}\` under api.versions.${version}.`,
        });
      }
      if (entry.successor !== undefined && (!known.has(entry.successor) || entry.successor === version)) {
        report({
          id: "api.version-successor",
          severity: "error",
          message: `The successor of ${version} is "${entry.successor}", which the API does not publish.`,
          help: "Name another version that `api.version` or `api.versions` publishes.",
        });
      }
    } else if (entry.sunset !== undefined || entry.successor !== undefined) {
      report({
        id: "api.version-deprecation",
        severity: "error",
        message: `${version} has a "sunset" or "successor" but is not marked deprecated.`,
        help: `Set \`deprecated: true\` under api.versions.${version}, or remove the two keys.`,
      });
    }
    out.push({
      version,
      collections: entry.collections,
      status: deprecated ? "deprecated" : "current",
      sunset: entry.sunset ?? null,
      successor: entry.successor ?? null,
    });
  }
  return out.sort((a, b) => Number(a.version.slice(1)) - Number(b.version.slice(1)));
}
