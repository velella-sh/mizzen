/**
 * The Astro Starlight importer: reads `astro.config.*` as text, never runs it, and takes the content root from
 * `srcDir`. Pages keep their text for now; a later step converts their components.
 */
import { basename, extname } from "node:path";
import type { Diagnostic } from "../../contracts/index.ts";
import type { ImportedAsset, ImportedConfig, ImportedPage, ImportFile, Importer } from "../contract.ts";
import { ASSET_EXTENSIONS } from "../plain.ts";

const CONFIGS = ["astro.config.mjs", "astro.config.js", "astro.config.ts"];
const CONTENT = /\.(?:md|mdx|mdoc)$/i;
const DOCS = "content/docs";

/** One error with the first character of `file` as its position. */
function error(id: string, message: string, file?: string): Diagnostic {
  return {
    id,
    severity: "error",
    message,
    ...(file === undefined ? {} : { pos: { file, line: 1, column: 1, endLine: 1, endColumn: 1 } }),
  };
}

/** The braces' contents of `starlight({ ... })`, skipping braces inside strings, or `undefined` without the call. */
function starlightBlock(text: string): string | undefined {
  const call = /\bstarlight\s*\(/.exec(text);
  if (call === null) return undefined;
  const open = text.indexOf("{", call.index);
  if (open === -1) return undefined;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const char = text[i]!;
    if (char === '"' || char === "'" || char === "`") {
      for (i++; i < text.length && text[i] !== char; i++) if (text[i] === "\\") i++;
    } else if (char === "{") {
      depth++;
    } else if (char === "}" && --depth === 0) {
      return text.slice(open + 1, i);
    }
  }
  return undefined;
}

/** A quoted value of `name: "..."` in `text`, or `undefined`. */
function quoted(text: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*:\\s*(?:"([^"]*)"|'([^']*)')`).exec(text);
  return match?.[1] ?? match?.[2];
}

/** A source path relative to the content root, with only its last separator removed. */
function relativeTo(root: string, path: string): string {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

export const starlightImporter: Importer = {
  name: "starlight",
  description: "an Astro Starlight site",
  import(source) {
    const files: ImportFile[] = [];
    const pages: ImportedPage[] = [];
    const assets: ImportedAsset[] = [];
    const diagnostics: Diagnostic[] = [];

    const configPath = CONFIGS.find((name) => source.files.includes(name));
    const configText = configPath === undefined ? undefined : source.read(configPath);
    const block = configText === undefined ? undefined : starlightBlock(configText);
    if (configPath === undefined) {
      diagnostics.push(error("import.config-missing", "no astro.config.mjs, astro.config.js, or astro.config.ts"));
    } else if (block === undefined) {
      diagnostics.push(error("import.starlight-missing", "the Astro config has no starlight({...}) integration", configPath));
    }

    const title = block === undefined ? undefined : quoted(block, "title");
    const config: ImportedConfig = {
      ...(configPath === undefined ? {} : { source: configPath }),
      contents: `title: ${title ?? basename(source.root)}\n`,
    };

    const srcDir = (configText === undefined ? undefined : quoted(configText, "srcDir")) ?? "src";
    const root = `${srcDir.replace(/^\.\//, "").replace(/\/+$/, "")}/${DOCS}`;
    const under = (path: string): boolean => path.startsWith(`${root}/`);

    if (!source.files.some(under)) {
      diagnostics.push(error("import.content-root", `no ${root} folder`, configPath));
    }

    for (const path of source.files) {
      if (path === configPath) {
        files.push({ path, kind: "config" });
        continue;
      }
      if (!under(path)) continue;
      const relative = relativeTo(root, path);
      if (CONTENT.test(relative)) {
        files.push({ path, kind: "content" });
        pages.push({ source: path, destination: relative.replace(/\.(?:mdx|mdoc)$/i, ".md"), contents: source.read(path) });
      } else if (ASSET_EXTENSIONS.has(extname(relative).toLowerCase())) {
        files.push({ path, kind: "asset" });
        assets.push({ source: path, destination: relative });
      } else {
        files.push({ path, kind: "unsupported", reason: "not a Markdown page or a static file" });
      }
    }

    return { files, pages, assets, config, diagnostics };
  },
};
