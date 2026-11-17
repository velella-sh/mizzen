/**
 * Copies the current documentation into a new version folder (#594).
 *
 * A snapshot freezes what a build would publish as the current docs: every published page outside a version folder,
 * byte for byte and with LF endings, at the same path inside the new `vN/` folder. The navigation file is copied to
 * the same relative path inside that folder, and each link that targets a snapshotted page is rewritten to the
 * page's versioned URL (its `match` prefix included). Nothing else is copied: config, theme, other `_data`, data
 * collections, assets, build output, and every existing version stay where they are.
 *
 * The new name must be unused and newer than every version folder already in the source. The copy is staged in a
 * temporary folder beside the target and renamed into place only when it is complete, so a failure leaves every
 * existing version untouched and no half-written folder publishable. The result lists the files written, in
 * code-point order, so a caller can show exactly what the snapshot recorded.
 */
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isMap, isScalar, isSeq, parseDocument, type Node } from "yaml";
import { loadConfig } from "../config/load.ts";
import { discover } from "../content/discover.ts";
import { parseFrontMatter } from "../content/frontmatter.ts";
import { permalink } from "../content/permalink.ts";

/** A version folder name: `v1`, `v1.2`, or `v1.2.3`. */
const VERSION_NAME = /^v(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;

/** Why a snapshot was refused. */
export type SnapshotErrorCode =
  | "snapshot.invalid-name"
  | "snapshot.exists"
  | "snapshot.not-newer"
  | "snapshot.missing"
  | "snapshot.invalid-navigation"
  | "snapshot.write-failed";

/** A refused snapshot. Nothing is written when one is thrown. */
export class SnapshotError extends Error {
  readonly code: SnapshotErrorCode;
  /** The file or folder the failure names, when it has one. */
  readonly path: string | undefined;

  constructor(code: SnapshotErrorCode, message: string, path?: string) {
    super(message);
    this.name = "SnapshotError";
    this.code = code;
    this.path = path;
  }
}

/** Test seams. Production callers pass nothing. */
export interface SnapshotHooks {
  /** After every file is staged, before the version folder is renamed into place. Throw to fail the snapshot. */
  readonly beforeCommit?: () => void | Promise<void>;
}

/** Options of {@link createSnapshot}. */
export interface SnapshotOptions {
  /** The site root: the folder that holds `mizzen.yml`. */
  readonly root: string;
  /** The new version folder name, such as `v3`. */
  readonly version: string;
  /** Test seam; the CLI never sets it. */
  readonly hooks?: SnapshotHooks;
}

/** What {@link createSnapshot} wrote. */
export interface SnapshotResult {
  readonly version: string;
  /** The new version folder, absolute. */
  readonly folder: string;
  /** Files written, relative to the version folder, with `/` separators and sorted by code point. */
  readonly files: readonly string[];
}

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The numeric parts of a version name, or undefined for any other name. */
function versionNumbers(name: string): readonly number[] | undefined {
  const match = VERSION_NAME.exec(name);
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

/** Whether `a` is a newer version than `b`; names are already known to match {@link VERSION_NAME}. */
function isNewer(a: string, b: string): boolean {
  const left = versionNumbers(a) ?? [];
  const right = versionNumbers(b) ?? [];
  for (let index = 0; index < left.length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

/** True when the path is a safe relative file path inside a folder. */
function isInside(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.includes("\\") || isAbsolute(path)) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** The URL a current path has inside its new version, with the site base kept in front. */
function navUrl(raw: string, version: string, base: string): string {
  return `${base}/${version}${raw}`;
}

/** The current URL without the site base: the form a navigation file writes. */
function withoutBase(url: string, base: string): string {
  return base !== "" && url.startsWith(base) ? url.slice(base.length) : url;
}

/** Whether a navigation `match` prefix covers a page URL. */
function covers(match: string, url: string): boolean {
  return url === match || url.startsWith(match.endsWith("/") ? match : `${match}/`);
}

/** The text with `[start, end)` replaced by `replacement`, from the last edit backwards. */
function replaceRanges(text: string, edits: readonly { readonly start: number; readonly end: number; readonly text: string }[]): string {
  let out = text;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    out = `${out.slice(0, edit.start)}${edit.text}${out.slice(edit.end)}`;
  }
  return out;
}

/**
 * Rewrites the `url` and `match` values of links whose target is a snapshotted page.
 *
 * The parse keeps the original bytes, so comments, order, and formatting survive; only the scalar tokens that
 * change are replaced. A link to an external site, an anchor, or a page outside the snapshot stays as written.
 */
function rewriteNavigation(
  text: string,
  options: {
    readonly version: string;
    readonly base: string;
    readonly urls: ReadonlyMap<string, string>;
  },
): string {
  const document = parseDocument(text);
  if (document.errors.length > 0) {
    const first = document.errors[0];
    throw new SnapshotError("snapshot.invalid-navigation", `The navigation file is not valid YAML: ${first?.message ?? "parse failed"}.`);
  }

  const edits: { start: number; end: number; text: string }[] = [];
  const remember = (node: Node, value: string): void => {
    const range = node.range;
    if (range === null || range === undefined) return;
    // range[1] is the value's end; range[2] also covers the newline and a trailing comment.
    const token = text.slice(range[0], range[1]);
    const quoted = token.startsWith("\"") || token.startsWith("'");
    edits.push({ start: range[0], end: range[1], text: quoted ? JSON.stringify(value) : value });
  };

  const walk = (node: unknown): void => {
    if (isMap(node)) {
      for (const pair of node.items) {
        const key = isScalar(pair.key) && typeof pair.key.value === "string" ? pair.key.value : undefined;
        const value = pair.value;
        if ((key === "url" || key === "match") && isScalar(value) && typeof value.value === "string") {
          const raw = value.value;
          if (!raw.startsWith("/")) continue;
          const target = key === "url" ? options.urls.get(withoutBase(raw, options.base)) : undefined;
          const prefix = key === "match" && [...options.urls].some(([url]) => covers(withoutBase(raw, options.base), url));
          if (target !== undefined || prefix === true) remember(value, navUrl(raw, options.version, options.base));
          continue;
        }
        walk(value);
      }
      return;
    }
    if (isSeq(node)) {
      for (const item of node.items) walk(item);
    }
  };
  walk(document.contents);

  return replaceRanges(text, edits);
}

/** Normalizes line endings to LF; the engine writes LF on every platform. */
function withLf(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** Front matter with the config's folder defaults applied; the page wins, as in a build. */
function withDefaults(
  defaults: readonly { readonly path: string; readonly values: Readonly<Record<string, unknown>> }[],
  path: string,
  data: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  let merged: Record<string, unknown> = {};
  for (const entry of defaults) {
    const folder = entry.path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
    if (folder === "" || path === folder || path.startsWith(`${folder}/`)) merged = { ...merged, ...entry.values };
  }
  return { ...merged, ...data };
}

/** True when a path exists. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Reports a filesystem failure with the path it names. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Copies the current pages and navigation into a new version folder.
 *
 * The snapshot is one all-or-nothing write: a refusal or failure writes nothing, and the target folder is renamed
 * into place only when every file is staged.
 */
export async function createSnapshot(options: SnapshotOptions): Promise<SnapshotResult> {
  const root = resolve(options.root);
  const version = options.version;
  if (versionNumbers(version) === undefined) {
    throw new SnapshotError("snapshot.invalid-name", `The version name "${version}" is not a version folder name; use v1, v1.2, or v1.2.3.`, version);
  }

  const config = loadConfig(root).config;
  const sourceDir = resolve(root, config.source);
  const folder = join(sourceDir, version);

  let sourceEntries;
  try {
    sourceEntries = await readdir(sourceDir, { withFileTypes: true });
  } catch (error) {
    throw new SnapshotError("snapshot.missing", `The source folder "${sourceDir}" cannot be read: ${reasonOf(error)}.`, sourceDir);
  }

  if (await exists(folder)) {
    throw new SnapshotError("snapshot.exists", `The version folder "${version}" already exists; a release is never overwritten.`, folder);
  }
  const released = sourceEntries
    .filter((entry) => entry.isDirectory() && versionNumbers(entry.name) !== undefined)
    .map((entry) => entry.name)
    .sort(byCodePoint);
  const older = released.find((name) => !isNewer(version, name));
  if (older !== undefined) {
    throw new SnapshotError("snapshot.not-newer", `The version "${version}" is not newer than the released version "${older}".`, folder);
  }

  const navigationPath = resolve(root, config.navigation);
  let navigationText: string;
  try {
    navigationText = await readFile(navigationPath, "utf8");
  } catch (error) {
    throw new SnapshotError("snapshot.missing", `The navigation file "${config.navigation}" cannot be read: ${reasonOf(error)}.`, navigationPath);
  }

  const files = await discover(sourceDir, { include: config.include, exclude: config.exclude });
  const pages: { readonly path: string; readonly url: string; readonly versionedUrl: string; readonly text: string }[] = [];
  for (const file of files) {
    if (file.kind !== "doc") continue;
    if (VERSION_NAME.test(file.path.split("/")[0] ?? "")) continue;
    const text = withLf(await readFile(join(sourceDir, file.path), "utf8"));
    const frontMatter = withDefaults(config.defaults, file.path, parseFrontMatter(text, file.path).data);
    if (frontMatter["published"] === false) continue;
    pages.push({
      path: file.path,
      text,
      url: withoutBase(permalink(file.path, { base: config.base, ...(typeof frontMatter["permalink"] === "string" ? { permalink: frontMatter["permalink"] } : {}) }), config.base),
      versionedUrl: permalink(`${version}/${file.path}`, { base: config.base }),
    });
  }

  const urls = new Map(pages.map((page) => [page.url, page.versionedUrl]));
  const navigationRelative = config.navigation.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
  if (!isInside(navigationRelative)) {
    throw new SnapshotError(
      "snapshot.invalid-navigation",
      `The navigation file "${config.navigation}" is not a relative path inside a folder, so it cannot be copied into "${version}".`,
      navigationPath,
    );
  }
  const navigation = rewriteNavigation(withLf(navigationText), { version, base: config.base, urls });

  const staged: { readonly path: string; readonly text: string }[] = pages.map((page) => ({ path: page.path, text: page.text }));
  staged.push({ path: navigationRelative, text: navigation });

  let staging: string | undefined;
  const written: string[] = [];
  try {
    staging = await mkdtemp(join(sourceDir, ".mizzen-snapshot-"));
    for (const file of staged) {
      const destination = join(staging, file.path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, file.text, "utf8");
      written.push(file.path);
    }
    written.sort(byCodePoint);
    if (options.hooks?.beforeCommit !== undefined) await options.hooks.beforeCommit();
    if (await exists(folder)) {
      throw new SnapshotError("snapshot.exists", `The version folder "${version}" appeared while the snapshot was staged; nothing was written.`, folder);
    }
    await rename(staging, folder);
  } catch (error) {
    if (staging !== undefined) await rm(staging, { recursive: true, force: true });
    if (error instanceof SnapshotError) throw error;
    throw new SnapshotError("snapshot.write-failed", `The version folder "${version}" could not be written: ${reasonOf(error)}.`, folder);
  }

  return { version, folder, files: written };
}
