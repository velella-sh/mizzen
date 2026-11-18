/**
 * The small importer `mizzen import plain` selects: a folder of plain Markdown and static files. Every `.md` keeps its
 * path, an `.mdx` page becomes `.md` and carries a warning that its components need a person, a static file is copied,
 * and `mizzen.yml` becomes the generated config. The command tests its wiring against this importer.
 */
import { basename, extname } from "node:path";
import type { Diagnostic } from "../contracts/index.ts";
import type { ImportedAsset, ImportedConfig, ImportedPage, ImportFile, Importer } from "./contract.ts";

/** Files copied without changing a byte. */
const ASSET_EXTENSIONS = new Set([
  ".css",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".js",
  ".mjs",
  ".mp4",
  ".otf",
  ".pdf",
  ".png",
  ".svg",
  ".ttf",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".zip",
]);

const MDX = /\.mdx$/i;

/** One warning per MDX page: its text migrates, its components do not. */
function mdxWarning(path: string): Diagnostic {
  return {
    id: "import.mdx",
    severity: "warning",
    message: "copied as Markdown; its JSX components need a person to convert them",
    pos: { file: path, line: 1, column: 1, endLine: 1, endColumn: 1 },
  };
}

export const plainImporter: Importer = {
  name: "plain",
  description: "a folder of plain Markdown and static files",
  import(source) {
    const files: ImportFile[] = [];
    const pages: ImportedPage[] = [];
    const assets: ImportedAsset[] = [];
    const diagnostics: Diagnostic[] = [];
    let config: ImportedConfig | undefined;

    for (const path of source.files) {
      if (path === "mizzen.yml") {
        files.push({ path, kind: "config" });
        config = { source: path, contents: source.read(path) };
      } else if (/\.md$/i.test(path) || MDX.test(path)) {
        files.push({ path, kind: "content" });
        pages.push({ source: path, destination: path.replace(MDX, ".md"), contents: source.read(path) });
        if (MDX.test(path)) diagnostics.push(mdxWarning(path));
      } else if (ASSET_EXTENSIONS.has(extname(path).toLowerCase())) {
        files.push({ path, kind: "asset" });
        assets.push({ source: path, destination: path });
      } else {
        files.push({ path, kind: "unsupported", reason: "not a Markdown page, a static file, or mizzen.yml" });
      }
    }

    return {
      files,
      pages,
      assets,
      config: config ?? { contents: `title: ${JSON.stringify(basename(source.root))}\n` },
      diagnostics,
    };
  },
};
