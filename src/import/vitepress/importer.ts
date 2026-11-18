/**
 * The importer `mizzen import vitepress` selects: a VitePress site. `.vitepress/config.*` names the content folder
 * through `srcDir`, read textually and never executed; every page and static file under it moves over and the rest of
 * the source is not input. `base` becomes the site base, `rewrites` moves pages, `locales` become languages, and
 * `public/` files land at the site root the way VitePress serves them.
 */
import { basename, posix } from "node:path";
import { stringify } from "yaml";
import type { Diagnostic } from "../../contracts/index.ts";
import { normalizeBase } from "../../content/permalink.ts";
import type { ImportedAsset, ImportedConfig, ImportedPage, ImportFile, Importer } from "../contract.ts";
import { convertFrontMatter } from "./frontmatter.ts";
import { literalObject } from "./literal.ts";
import { convertNav } from "./nav.ts";

const CONFIG = /(?:^|\/)\.vitepress\/config\.(?:js|ts|mjs|mts)$/;
const EXCLUDED = /(?:^|\/)(?:\.vitepress|node_modules|dist)\//;
const MD = /\.md$/i;
const PAGE_EXT = /\.(?:md|markdown)$/i;

/** The first string value of a top-level key in a config object literal. */
function quoted(contents: string, key: string): string | undefined {
  const match = new RegExp(`\\b${key}\\s*:\\s*(?:"([^"]*)"|'([^']*)'|\\x60([^\\x60]*)\\x60)`).exec(contents);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

/** The folder that holds `.vitepress`, relative to the source root. */
function siteFolder(configPath: string): string {
  const folder = posix.dirname(posix.dirname(configPath));
  return folder === "." ? "" : folder;
}

/** A path relative to `root`, or `undefined` when it climbs out of it or is absolute. */
function underRoot(root: string, path: string): string | undefined {
  if (posix.isAbsolute(path)) return undefined;
  const joined = root === "" ? posix.normalize(path) : posix.normalize(`${root}/${path}`);
  if (joined === ".." || joined.startsWith("../")) return undefined;
  return joined === "." ? "" : joined;
}

/** A config value that is a string, read from the object when it parsed and from the text otherwise. */
function text(config: string, parsed: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = parsed?.[key];
  return typeof value === "string" ? value : quoted(config, key);
}

/** A record of strings, such as `rewrites`. */
function strings(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return out;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

/** One error at the top of a source file. */
function error(id: string, message: string, file: string): Diagnostic {
  return { id, severity: "error", message, pos: { file, line: 1, column: 1, endLine: 1, endColumn: 1 } };
}

function titleLine(title: string): string {
  return `title: ${JSON.stringify(title)}\n`;
}

/** A page's destination after `rewrites`, or the destination itself. */
function rewritten(rewrites: Readonly<Record<string, string>>, destination: string): string {
  const found = rewrites[destination] ?? rewrites[destination.replace(PAGE_EXT, "")];
  if (found === undefined) return destination;
  const path = found.replace(/^\.?\//, "");
  return PAGE_EXT.test(path) ? path : `${path}.md`;
}

/** The site languages `locales` declares, in the order written. */
function languagesOf(parsed: Record<string, unknown> | undefined): { readonly code: string; readonly name: string; readonly prefix: string }[] {
  const locales = parsed?.locales;
  if (typeof locales !== "object" || locales === null || Array.isArray(locales)) return [];
  const languages: { code: string; name: string; prefix: string }[] = [];
  for (const [key, value] of Object.entries(locales as Record<string, unknown>)) {
    if (key === "root" || value === undefined || typeof value !== "object" || value === null) continue;
    const locale = value as Record<string, unknown>;
    const prefix = `/${key.replace(/^\/+|\/+$/g, "")}`;
    languages.push({
      code: typeof locale.lang === "string" && locale.lang.trim() !== "" ? locale.lang : key,
      name: typeof locale.label === "string" && locale.label.trim() !== "" ? locale.label : key,
      prefix,
    });
  }
  return languages;
}

export const vitepressImporter: Importer = {
  name: "vitepress",
  description: "a VitePress site",
  import(source) {
    const files: ImportFile[] = [];
    const pages: ImportedPage[] = [];
    const assets: ImportedAsset[] = [];
    const diagnostics: Diagnostic[] = [];

    const configPath = source.files.find((path) => CONFIG.test(path));
    const config = configPath === undefined ? "" : source.read(configPath);
    const parsed = configPath === undefined ? undefined : literalObject(config);
    const locales = parsed?.locales;
    const rootLocale =
      typeof locales === "object" && locales !== null && typeof (locales as Record<string, unknown>).root === "object"
        ? ((locales as Record<string, unknown>).root as Record<string, unknown>)
        : {};
    const title = (typeof rootLocale.title === "string" ? rootLocale.title : text(config, parsed, "title")) ?? basename(source.root);
    const base = normalizeBase(text(config, parsed, "base") ?? "");
    const lang = typeof rootLocale.lang === "string" ? rootLocale.lang : text(config, parsed, "lang");
    const languages = languagesOf(parsed);
    const rewrites = strings(parsed?.rewrites);
    const publicDir = (text(config, parsed, "publicDir") ?? "public").replace(/^\.?\//, "").replace(/\/$/, "");

    let srcDir = "";
    let refused = false;
    if (configPath === undefined) {
      diagnostics.push(
        error("import.config-missing", "no VitePress config; expected .vitepress/config.js, .ts, .mjs, or .mts", ".vitepress/config.mjs"),
      );
    } else {
      files.push({ path: configPath, kind: "config" });
      const declared = underRoot(siteFolder(configPath), text(config, parsed, "srcDir") ?? ".");
      if (declared === undefined) {
        refused = true;
        diagnostics.push(error("import.src-dir", `srcDir "${quoted(config, "srcDir")}" is outside the source folder`, configPath));
      } else {
        srcDir = declared;
      }
      for (const [from, to] of Object.entries(rewrites)) {
        if (!from.includes(":")) continue;
        diagnostics.push({
          id: "import.rewrite",
          severity: "warning",
          message: `rewrite \`${from}\` has a dynamic segment; it is not applied and its pages keep their paths.`,
          pos: { file: configPath, line: 1, column: 1, endLine: 1, endColumn: 1 },
        });
        delete rewrites[from];
        void to;
      }
    }
    const prefix = srcDir === "" ? "" : `${srcDir}/`;
    const publicPrefix = publicDir === "" || publicDir.startsWith("..") ? undefined : `${prefix}${publicDir}/`;

    for (const path of source.files) {
      if (refused || path === configPath || EXCLUDED.test(path) || !path.startsWith(prefix)) continue;
      const destination = path.slice(prefix.length);
      if (publicPrefix !== undefined && path.startsWith(publicPrefix)) {
        files.push({ path, kind: "asset" });
        assets.push({ source: path, destination: path.slice(publicPrefix.length) });
      } else if (MD.test(path)) {
        files.push({ path, kind: "content" });
        const page = convertFrontMatter(source.read(path), path);
        diagnostics.push(...page.diagnostics);
        pages.push({ source: path, destination: rewritten(rewrites, destination), contents: page.contents });
      } else {
        files.push({ path, kind: "asset" });
        assets.push({ source: path, destination });
      }
    }

    const navigation = configPath === undefined ? { diagnostics: [] } : convertNav(config, configPath, pages, prefix, base);
    diagnostics.push(...navigation.diagnostics);

    const generated = [
      titleLine(title),
      ...(base === "" ? [] : [`base: ${JSON.stringify(base)}\n`]),
      ...(lang === undefined || lang === "en" ? [] : [`lang: ${JSON.stringify(lang)}\n`]),
      ...(languages.length === 0 ? [] : [stringify({ languages })]),
    ].join("");
    const imported: ImportedConfig =
      configPath === undefined ? { contents: generated } : { source: configPath, contents: generated };
    return {
      files,
      pages,
      assets,
      config: imported,
      ...(base === "" ? {} : { base }),
      ...(prefix === "" ? {} : { contentRoot: prefix }),
      ...(configPath === undefined || navigation.contents === undefined
        ? {}
        : { navigation: { source: configPath, contents: navigation.contents } }),
      diagnostics,
    };
  },
};
