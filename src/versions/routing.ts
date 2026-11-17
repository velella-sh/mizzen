import type { Diagnostic, SourcePos } from "../contracts/index.ts";
import { discoverVersions, type VersionOptions, type VersionPage } from "../content/versions.ts";

/**
 * Version routing: which release owns the canonical URL, and which URLs every page is written at.
 *
 * The dispositions come from the site's `_data/versions.yml`:
 *
 * ```yaml
 * default: v2   # a released version folder, or `current`; omitted means `current`
 * old: [v1]     # released versions replaced by the default
 * ```
 *
 * A missing file is a site with no version settings, so current docs stay canonical and every release keeps its
 * versioned URL. The routing is a pure transform of the pages and that value; it reads no disk, clock, or environment.
 *
 * ## URL policy
 *
 * | State | Canonical | Versioned | Written |
 * | --- | --- | --- | --- |
 * | Current, default | `/path/` | — | canonical |
 * | Current, not default | — | — | nothing |
 * | Released, not default | — | `/vN/path/` | versioned |
 * | Default release | `/path/` | `/vN/path/` | both, canonical first |
 * | Old release | — | `/vN/path/` | versioned |
 *
 * The versioned URL is always the page's existing `url`, so switching the default never moves it. The canonical URL
 * of the default release is that URL with its version folder removed. A versioned page whose `permalink` removes the
 * version folder has no stable versioned URL, so it is diagnosed and written nowhere rather than given an invented
 * URL. Current docs are drafts while a release is default: they stay in the route list for editing and navigation,
 * but write nothing.
 */

/** The version name that means the current docs rather than a released folder. */
export const CURRENT_VERSION = "current";

/** The site data file that records the dispositions. */
export const VERSIONS_FILE = "_data/versions.yml";

/** Where a page sits in the lifecycle. */
export type VersionState = "current" | "default" | "released" | "old";

/** The dispositions after validation, with duplicate old entries removed. */
export interface VersionSettings {
  /** The version served at canonical URLs: a released folder, or {@link CURRENT_VERSION}. */
  readonly default: string;
  /** The released versions replaced by the default, in file order. */
  readonly old: readonly string[];
}

/** One page and the URLs routing assigns to it. */
export interface VersionRoute<P extends VersionPage = VersionPage> {
  readonly page: P;
  /** The version folder, or `null` for current docs. */
  readonly version: string | null;
  /** The path inside the version folder, or the source path for current docs. */
  readonly path: string;
  readonly state: VersionState;
  /** The URL that owns the canonical link, or `null` when the page does not own one. */
  readonly canonical: string | null;
  /** The stable versioned URL, or `null` for current docs. */
  readonly versioned: string | null;
  /** The URLs this page is written at, canonical first; empty when it is not written. */
  readonly urls: readonly string[];
}

/** The dispositions, every route, and the findings that made a route invalid. */
export interface VersionRouting<P extends VersionPage = VersionPage> {
  readonly settings: VersionSettings;
  readonly routes: readonly VersionRoute<P>[];
  readonly diagnostics: readonly Diagnostic[];
}

/** Options of {@link resolveVersionRouting}. */
export interface VersionRoutingOptions extends VersionOptions {
  /** The site `base`, `/docs`-shaped and without a trailing slash; `""` at a domain root. Default `""`. */
  readonly base?: string;
  /** The versions file path, used only by diagnostics. Default `_data/versions.yml`. */
  readonly file?: string;
}

/** A plain mapping, never an array. */
function isMapping(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The start of the versions file, for findings whose exact line the parsed data no longer carries. */
function fileStart(file: string): SourcePos {
  return { file, line: 1, column: 1, endLine: 1, endColumn: 1 };
}

/** One error at a known position. */
function problem(id: string, message: string, pos: SourcePos, help?: string): Diagnostic {
  return { id, severity: "error", message, pos, ...(help === undefined ? {} : { help }) };
}

/** Read `default` and `old`, replacing an invalid shape with the unversioned defaults and reporting why. */
function readSettings(value: unknown, pos: SourcePos): { settings: VersionSettings; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  let name = CURRENT_VERSION;
  const old: string[] = [];

  if (value === undefined || value === null) return { settings: { default: name, old }, diagnostics };
  if (!isMapping(value)) {
    diagnostics.push(problem("versions.invalid", "The versions file must map `default` and `old`.", pos));
    return { settings: { default: name, old }, diagnostics };
  }

  for (const key of Object.keys(value)) {
    if (key !== "default" && key !== "old") {
      diagnostics.push(problem("versions.unknown-key", `Unknown key \`${key}\` in the versions file.`, pos));
    }
  }

  const configured = value["default"];
  if (configured !== undefined) {
    if (typeof configured === "string" && configured !== "") name = configured;
    else diagnostics.push(problem("versions.default-invalid", "`default` must name a version folder or `current`.", pos));
  }

  const listed = value["old"];
  if (listed !== undefined) {
    if (!Array.isArray(listed)) {
      diagnostics.push(problem("versions.old-invalid", "`old` must be a list of version folders.", pos));
    } else {
      const seen = new Set<string>();
      for (const entry of listed) {
        if (typeof entry !== "string" || entry === "") {
          diagnostics.push(problem("versions.old-entry", "Every entry in `old` must be a version folder.", pos));
        } else if (seen.has(entry)) {
          diagnostics.push(problem("versions.old-duplicate", `The version \`${entry}\` is listed twice in \`old\`.`, pos));
        } else {
          seen.add(entry);
          old.push(entry);
        }
      }
    }
  }

  return { settings: { default: name, old }, diagnostics };
}

/**
 * Resolve the default release and the canonical and versioned routes of every page.
 *
 * Pass the parsed `_data/versions.yml` value as `versions`; `undefined` is the missing file. `options` carries the
 * site base, the version detection choices of `discoverVersions`, and the versions file path for diagnostics.
 *
 * A default or old entry that names no version folder, a version that is both default and old, a repeated old entry,
 * and a versioned page whose URL does not keep its version folder are reported as errors. Routes are still complete:
 * an invalid disposition never invents a default or a URL.
 */
export function resolveVersionRouting<P extends VersionPage>(
  pages: readonly P[],
  versions?: unknown,
  options: VersionRoutingOptions = {},
): VersionRouting<P> {
  const pos = fileStart(options.file ?? VERSIONS_FILE);
  const read = readSettings(versions, pos);
  const settings = read.settings;
  const diagnostics = [...read.diagnostics];

  const entries = discoverVersions(pages, options);
  const known = new Set<string>();
  for (const entry of entries) if (entry.version !== null) known.add(entry.version);

  if (settings.default !== CURRENT_VERSION && !known.has(settings.default)) {
    diagnostics.push(
      problem(
        "versions.default-missing",
        `The default version \`${settings.default}\` is not a version folder.`,
        pos,
        "Name a released version folder, or `current`.",
      ),
    );
  }

  for (const version of settings.old) {
    if (version === settings.default) {
      diagnostics.push(problem("versions.default-old", `The version \`${version}\` is both the default and old.`, pos));
    } else if (!known.has(version)) {
      diagnostics.push(problem("versions.old-missing", `The old version \`${version}\` is not a version folder.`, pos));
    }
  }

  // A version named as both default and old is diagnosed; the default wins so a bad file cannot mark two states.
  const old = new Set(settings.old.filter((version) => version !== settings.default));
  const base = options.base ?? "";

  const routes = entries.map((entry): VersionRoute<P> => {
    const version = entry.version;
    if (version === null) {
      const canonical = settings.default === CURRENT_VERSION ? entry.page.url : null;
      return {
        page: entry.page,
        version,
        path: entry.path,
        state: "current",
        canonical,
        versioned: null,
        urls: canonical === null ? [] : [canonical],
      };
    }

    const versioned = entry.page.url;
    const state: VersionState = version === settings.default ? "default" : old.has(version) ? "old" : "released";
    const prefix = `${base}/${version}/`;
    if (!versioned.startsWith(prefix)) {
      diagnostics.push(
        problem(
          "versions.permalink",
          `The page \`${entry.page.source.file}\` is at \`${versioned}\`, which does not keep the version folder \`${version}\` in its URL.`,
          entry.page.source,
          "Keep the version folder in the page's URL, or take the page out of the version folder.",
        ),
      );
      return { page: entry.page, version, path: entry.path, state, canonical: null, versioned: null, urls: [] };
    }

    const canonical = `${base}/${versioned.slice(prefix.length)}`;
    if (state === "default") {
      return { page: entry.page, version, path: entry.path, state, canonical, versioned, urls: [canonical, versioned] };
    }
    return { page: entry.page, version, path: entry.path, state, canonical: null, versioned, urls: [versioned] };
  });

  return { settings, routes, diagnostics };
}
