import { readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type { Page, Site } from "../contracts/content.ts";
import type { Diagnostic } from "../contracts/diagnostic.ts";
import type { Output, OutputContext, OutputFile } from "../contracts/output.ts";

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The span of a page's front matter, from its first line to the closing fence. Front matter is parsed by the time the
 * model holds the page, so this is the closest real span a diagnostic about the `tool:` key can name.
 */
function frontMatterSpan(page: Page): Diagnostic["pos"] {
  const close = page.source.line - 1;
  if (close < 2) return undefined;
  return { file: page.source.file, line: 1, column: 1, endLine: close, endColumn: 1 };
}

/**
 * URL a page tool is served at: the site's `base` and the file's path, so the same file is correct at a domain root
 * and under a nested base. `path` is the output path, relative to the output folder, with `/` separators.
 */
export function toolUrl(base: string, path: string): string {
  return `${base}/${path}`;
}

/** The path a `tool:` front-matter string names, relative to the site source and with no leading slash; `undefined` for anything else. */
function toolPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const path = value.trim().replace(/^\/+/, "");
  return path === "" ? undefined : path;
}

/** True when a source-relative path is still inside its folder, so a `..` segment cannot escape it. */
function isInside(rel: string): boolean {
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith("/");
}

/**
 * Copies the file each page names in its `tool:` front matter to the same path under the output folder, so a page
 * that opts in gets a base-aware URL (`toolUrl`) without the file being republished per page. Files are deduplicated
 * across pages and written in path order. A file that is missing, unreadable, or outside the site source is an error
 * at the page's front-matter span.
 */
export const pageTools: Output = {
  name: "page-tools",
  async run(site: Site, ctx: OutputContext): Promise<readonly OutputFile[]> {
    const build = ctx.build;
    if (build === undefined) return [];
    const source = resolve(build.root, site.config.source);

    // Every page that names the same file reports its own error, but the file is read once.
    const owners = new Map<string, Page[]>();
    for (const page of site.pages) {
      const path = toolPath(page.frontMatter.tool);
      if (path === undefined) continue;
      const pages = owners.get(path);
      if (pages === undefined) owners.set(path, [page]);
      else pages.push(page);
    }

    const files: OutputFile[] = [];
    for (const path of [...owners.keys()].sort(byCodePoint)) {
      const pages = owners.get(path)!;
      const rel = relative(source, resolve(source, path));
      if (!isInside(rel)) {
        for (const page of pages) {
          ctx.report({
            id: "page-tools.path",
            severity: "error",
            message: `Page tool "${path}" leaves the site source.`,
            pos: frontMatterSpan(page) ?? page.source,
            help: "Name a file inside the site source, such as `tool/tool.js`.",
          });
        }
        continue;
      }
      let contents: Uint8Array;
      try {
        contents = await readFile(resolve(source, rel));
      } catch {
        for (const page of pages) {
          ctx.report({
            id: "page-tools.missing",
            severity: "error",
            message: `Page tool "${path}" is missing.`,
            pos: frontMatterSpan(page) ?? page.source,
            help: "Add the file, or remove `tool` from the page's front matter.",
          });
        }
        continue;
      }
      files.push({ path: rel.split(sep).join("/"), contents });
    }
    return files;
  },
};
