import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * What discovery found a file to be. `data` files (under `_data`) are read by the engine and never copied, and
 * `template` files (under `_templates`) are instantiated into pages rather than built themselves.
 */
export type DiscoveredKind = "doc" | "app" | "asset" | "data" | "template";

/** One file under the source folder. */
export interface DiscoveredFile {
  /** Path relative to the source folder, using `/` on every platform. */
  readonly path: string;
  readonly kind: DiscoveredKind;
}

/** The part of the site config discovery reads. */
export interface DiscoverOptions {
  /** Paths under the source folder that discovery would skip but should be kept, such as `.well-known`. */
  readonly include?: readonly string[];
  /** Paths under the source folder that are neither pages nor copied. */
  readonly exclude?: readonly string[];
}

/** Markdown file names: the template check and page discovery accept the same two extensions. */
export const MARKDOWN = /\.(md|markdown)$/i;
const HTML = /\.html?$/i;

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/** Files at the site root that describe the build rather than the site, so they are never pages or copied. */
const SITE_METADATA = new Set(["evidence.lock.json", "mizzen.lock.json", "urls.lock.json"]);

function covers(list: ReadonlySet<string>, path: string): boolean {
  for (const entry of list) {
    if (path === entry || path.startsWith(`${entry}/`)) return true;
  }
  return false;
}

/** True when the file starts with a front matter block (`---` on the first line, closed by `---` or `...`). */
async function hasFrontMatter(file: string): Promise<boolean> {
  const text = (await readFile(file, "utf8")).replace(/^﻿/, "");
  return /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.test(text);
}

/**
 * Lists every page, asset, data file, and template under `source`, sorted by path.
 *
 * `_templates` files are `template`: kept apart so no template is ever built as a page or copied as an asset.
 *
 * Skipped: folders starting with `_` (except `_data` and `_templates`), the site-root `data-changes` folder (the raw
 * change history, read by the engine and never copied), names starting with `.`, `node_modules`, and paths in `exclude`.
 * A path in `include` is kept even when a rule above would skip it. A folder whose `index.html` has no front matter is an
 * app page: every file in it, at any depth, is listed as `app` and passed through untouched.
 */
export async function discover(source: string, options: DiscoverOptions = {}): Promise<DiscoveredFile[]> {
  const include = new Set((options.include ?? []).map(normalize));
  const exclude = new Set((options.exclude ?? []).map(normalize));
  const found: DiscoveredFile[] = [];

  async function walk(dir: string, rel: string, inApp: boolean, inData: boolean, inTemplates: boolean): Promise<void> {
    const entries = await readdir(join(source, dir), { withFileTypes: true });
    entries.sort((a, b) => byCodePoint(a.name, b.name));

    // Decide once per folder whether it is an app page.
    let app = inApp;
    if (!app && rel !== "" && entries.some((e) => e.isFile() && e.name === "index.html")) {
      app = !(await hasFrontMatter(join(source, dir, "index.html")));
    }

    for (const entry of entries) {
      const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (rel === "" && SITE_METADATA.has(entry.name)) continue;
      if (path === ".mizzen/evidence") continue;
      if (covers(exclude, path)) continue;
      const kept = covers(include, path);
      if (!kept) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        // The change history is raw input: a public build reads it, never copies it as an asset.
        if (entry.isDirectory() && rel === "" && entry.name === "data-changes") continue;
        if (entry.isDirectory() && entry.name.startsWith("_") && !(rel === "" && (entry.name === "_data" || entry.name === "_templates"))) continue;
      }
      if (entry.isDirectory()) {
        await walk(
          join(dir, entry.name),
          path,
          app,
          inData || (rel === "" && entry.name === "_data"),
          inTemplates || (rel === "" && entry.name === "_templates"),
        );
        continue;
      }
      if (!entry.isFile()) continue;
      if (inTemplates) found.push({ path, kind: "template" });
      else if (inData) found.push({ path, kind: "data" });
      else if (app) found.push({ path, kind: "app" });
      else if (MARKDOWN.test(entry.name)) found.push({ path, kind: "doc" });
      else if (HTML.test(entry.name) && (await hasFrontMatter(join(source, dir, entry.name)))) found.push({ path, kind: "doc" });
      else found.push({ path, kind: "asset" });
    }
  }

  await walk("", "", false, false, false);
  return found.sort((a, b) => byCodePoint(a.path, b.path));
}
