/**
 * The importer `mizzen import vitepress` selects: a VitePress site. `.vitepress/config.*` names the content folder
 * through `srcDir`, read textually and never executed; every page and static file under it moves over and the rest of
 * the source is not input.
 */
import { basename, posix } from "node:path";
import type { Diagnostic } from "../../contracts/index.ts";
import type { ImportedAsset, ImportedConfig, ImportedPage, ImportFile, Importer } from "../contract.ts";
import { convertFrontMatter } from "./frontmatter.ts";
import { convertNav } from "./nav.ts";

const CONFIG = /(?:^|\/)\.vitepress\/config\.(?:js|ts|mjs|mts)$/;
const EXCLUDED = /(?:^|\/)(?:\.vitepress|node_modules|dist)\//;
const MD = /\.md$/i;

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

/** One error at the top of a source file. */
function error(id: string, message: string, file: string): Diagnostic {
  return { id, severity: "error", message, pos: { file, line: 1, column: 1, endLine: 1, endColumn: 1 } };
}

function titleLine(title: string): string {
  return `title: ${JSON.stringify(title)}\n`;
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
    const title = quoted(config, "title") ?? basename(source.root);

    let srcDir = "";
    let refused = false;
    if (configPath === undefined) {
      diagnostics.push(
        error("import.config-missing", "no VitePress config; expected .vitepress/config.js, .ts, .mjs, or .mts", ".vitepress/config.mjs"),
      );
    } else {
      files.push({ path: configPath, kind: "config" });
      const declared = underRoot(siteFolder(configPath), quoted(config, "srcDir") ?? ".");
      if (declared === undefined) {
        refused = true;
        diagnostics.push(error("import.src-dir", `srcDir "${quoted(config, "srcDir")}" is outside the source folder`, configPath));
      } else {
        srcDir = declared;
      }
    }
    const prefix = srcDir === "" ? "" : `${srcDir}/`;

    for (const path of source.files) {
      if (refused || path === configPath || EXCLUDED.test(path) || !path.startsWith(prefix)) continue;
      const destination = path.slice(prefix.length);
      if (MD.test(path)) {
        files.push({ path, kind: "content" });
        const page = convertFrontMatter(source.read(path), path);
        diagnostics.push(...page.diagnostics);
        pages.push({ source: path, destination, contents: page.contents });
      } else {
        files.push({ path, kind: "asset" });
        assets.push({ source: path, destination });
      }
    }

    const navigation = configPath === undefined ? { diagnostics: [] } : convertNav(config, configPath, pages, prefix);
    diagnostics.push(...navigation.diagnostics);

    const imported: ImportedConfig =
      configPath === undefined ? { contents: titleLine(title) } : { source: configPath, contents: titleLine(title) };
    return {
      files,
      pages,
      assets,
      config: imported,
      ...(configPath === undefined || navigation.contents === undefined
        ? {}
        : { navigation: { source: configPath, contents: navigation.contents } }),
      diagnostics,
    };
  },
};
