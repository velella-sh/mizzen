/**
 * `mizzen import docusaurus` reads every docs section of a Docusaurus site. The config is scanned as text, never run:
 * a section is a `{...}` block that follows `docs:` or `@docusaurus/plugin-content-docs` and holds a `path`, so a
 * classic preset and a plugin with its own folder both become pages. Files under a section keep their paths; `static/`
 * is copied unchanged; the generated `mizzen.yml` says the site was imported.
 */
import type { Diagnostic } from "../../contracts/index.ts";
import type { ImportedAsset, ImportedConfig, ImportedPage, ImportFile, Importer } from "../contract.ts";

/** One docs section: the folder to read and the URL prefix it is served under. */
interface DocsSection {
  readonly path: string;
  readonly routeBasePath: string;
}

const CONFIG = /(^|\/)docusaurus\.config\.(js|ts|mjs)$/;
const SECTION = /docs\s*:|@docusaurus\/plugin-content-docs/g;
const MARKDOWN = /\.mdx?$/i;
const STATIC = "static/";

/** An error at the first line of `file`, the only position a missing-folder finding has. */
function finding(id: string, message: string, file: string): Diagnostic {
  return { id, severity: "error", message, pos: { file, line: 1, column: 1, endLine: 1, endColumn: 1 } };
}

/** The text of the `{...}` block that starts at or after `from`, its braces excluded. */
function blockAfter(text: string, from: number): string | undefined {
  const open = text.indexOf("{", from);
  if (open === -1) return undefined;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(open + 1, i);
  }
  return undefined;
}

/** The quoted value of `key` in a config block. */
function quoted(block: string, key: string): string | undefined {
  return new RegExp(`\\b${key}\\s*:\\s*["']([^"']+)["']`).exec(block)?.[1];
}

/** Every docs section the config names, in the order it names them. */
function docsSections(text: string): readonly DocsSection[] {
  const sections: DocsSection[] = [];
  for (let match = SECTION.exec(text); match; match = SECTION.exec(text)) {
    const block = blockAfter(text, match.index + match[0].length);
    if (block === undefined) continue;
    const path = quoted(block, "path");
    if (path === undefined) continue;
    sections.push({ path: path.replace(/\/+$/, ""), routeBasePath: quoted(block, "routeBasePath") ?? "docs" });
  }
  return sections;
}

export const docusaurusImporter: Importer = {
  name: "docusaurus",
  description: "a Docusaurus site",
  import(source) {
    const config: ImportedConfig = { contents: "title: Imported site\n" };
    const configPath = source.files.find((path) => CONFIG.test(path));
    if (configPath === undefined) {
      return {
        files: [],
        pages: [],
        assets: [],
        config,
        diagnostics: [
          finding(
            "import.config-missing",
            "no docusaurus.config.js, docusaurus.config.ts, or docusaurus.config.mjs to read the docs sections from",
            "docusaurus.config.js",
          ),
        ],
      };
    }

    const files: ImportFile[] = [{ path: configPath, kind: "config" }];
    const pages: ImportedPage[] = [];
    const assets: ImportedAsset[] = [];
    const diagnostics: Diagnostic[] = [];

    for (const section of docsSections(source.read(configPath))) {
      const prefix = `${section.path}/`;
      const found = source.files.filter((path) => path.startsWith(prefix));
      if (found.length === 0) {
        diagnostics.push(finding("import.docs-missing", `docs section \`${section.path}\` has no files`, configPath));
        continue;
      }
      for (const path of found) {
        if (MARKDOWN.test(path)) {
          files.push({ path, kind: "content" });
          pages.push({ source: path, destination: path, contents: source.read(path) });
        } else {
          files.push({ path, kind: "asset" });
          assets.push({ source: path, destination: path });
        }
      }
    }

    for (const path of source.files.filter((path) => path.startsWith(STATIC))) {
      files.push({ path, kind: "asset" });
      assets.push({ source: path, destination: path });
    }

    return { files, pages, assets, config, diagnostics };
  },
};
