/**
 * The importer `mizzen import mkdocs` selects: a MkDocs project. `mkdocs.yml` names the docs folder and the title;
 * every page and asset under it keeps its path, and nothing outside it is read.
 */
import { isAbsolute } from "node:path";
import { isMap, isScalar, isSeq, LineCounter, parseDocument, stringify } from "yaml";
import type { Diagnostic, SourcePos } from "../../contracts/index.ts";
import type { ImportedAsset, ImportedConfig, ImportedPage, ImportFile, ImportUrls, Importer } from "../contract.ts";
import { pageUrl } from "../mapping.ts";

const CONFIG = "mkdocs.yml";
const FALLBACK: ImportedConfig = { source: CONFIG, contents: "title: MkDocs site\n" };

function at(line: number, column = 1): SourcePos {
  return { file: CONFIG, line, column, endLine: line, endColumn: column };
}

function configError(message: string, line = 1, column = 1): Diagnostic {
  return { id: "import.config-invalid", severity: "error", message, pos: at(line, column) };
}

/** A folder name from the config, without trailing slashes, or the default when the key is absent. */
function folder(value: unknown, fallback: string): string {
  return typeof value === "string" && value !== "" ? value.replace(/\/+$/, "") : fallback;
}

/** A navigation entry Mizzen's navigation file reads: a link or one level of children. */
type NavOut = { readonly title: string; readonly url: string } | { readonly title: string; readonly children: readonly NavOut[] };

/** A scheme, a protocol-relative URL, or a fragment is external and stays as written. */
const EXTERNAL = /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i;

/** The page title from its first `# ` heading, or the file name when it has none. */
function titleOf(page: ImportedPage | undefined, path: string): string {
  const heading = page?.contents.match(/^#\s+(.+?)\s*$/m)?.[1];
  if (heading !== undefined && heading !== "") return heading;
  const name = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
  return (name === "" ? path : name).replace(/[-_]+/g, " ");
}

/** The navigation's `nav` value as one `main` list, or `undefined` when it declares nothing usable. */
function navigationOf(
  nav: unknown,
  pages: readonly ImportedPage[],
  urls: ImportUrls,
): ImportedConfig | undefined {
  if (!Array.isArray(nav)) return undefined;
  const byDestination = new Map(pages.map((page) => [page.destination, page]));
  const linkOf = (title: string, link: string): NavOut => {
    if (EXTERNAL.test(link)) return { title, url: link };
    const at = link.search(/[?#]/);
    const path = (at === -1 ? link : link.slice(0, at)).replace(/^\/+/, "");
    const tail = at === -1 ? "" : link.slice(at);
    const destination = path === "" ? "index.md" : path.endsWith("/") ? `${path}index.md` : path;
    const page = byDestination.get(destination);
    return { title: title === "" ? titleOf(page, destination) : title, url: page === undefined ? link : `${pageUrl(page.destination, urls)}${tail}` };
  };
  const entriesOf = (items: readonly unknown[]): NavOut[] => {
    const out: NavOut[] = [];
    for (const item of items) {
      if (typeof item === "string") {
        out.push(linkOf("", item));
        continue;
      }
      if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
      for (const [title, value] of Object.entries(item)) {
        if (Array.isArray(value)) {
          const children = entriesOf(value).flatMap((entry) => ("children" in entry ? entry.children : [entry]));
          if (children.length > 0) out.push({ title, children });
        } else if (typeof value === "string") {
          out.push(linkOf(title, value));
        }
      }
    }
    return out;
  };

  const main = entriesOf(nav);
  return main.length === 0 ? undefined : { source: CONFIG, contents: stringify({ main }) };
}

export const mkdocsImporter: Importer = {
  name: "mkdocs",
  description: "a MkDocs site",
  import(source) {
    if (!source.files.includes(CONFIG)) {
      return {
        files: [],
        pages: [],
        assets: [],
        config: FALLBACK,
        diagnostics: [configError("mkdocs.yml is missing, so the site has no title or docs folder.")],
      };
    }

    const lineCounter = new LineCounter();
    const doc = parseDocument(source.read(CONFIG), { lineCounter });
    const yamlError = doc.errors[0];
    if (yamlError !== undefined) {
      const start = yamlError.linePos?.[0];
      return {
        files: [{ path: CONFIG, kind: "config" }],
        pages: [],
        assets: [],
        config: FALLBACK,
        diagnostics: [
          configError(`mkdocs.yml is not valid YAML: ${yamlError.message}`, start?.line ?? 1, start?.col ?? 1),
        ],
      };
    }

    const lineOf = (node: unknown): number => {
      const range = (node as { range?: readonly number[] } | null)?.range;
      return range === undefined ? 1 : lineCounter.linePos(range[0]!).line;
    };

    const docsNode = doc.get("docs_dir", true);
    const docsDir = folder(isScalar(docsNode) ? docsNode.value : undefined, "docs");
    const invalid =
      (docsNode !== undefined && !(isScalar(docsNode) && typeof docsNode.value === "string")) ||
      isAbsolute(docsDir) ||
      docsDir.split("/").includes("..") ||
      !source.files.some((path) => path.startsWith(`${docsDir}/`));

    const files: ImportFile[] = [{ path: CONFIG, kind: "config" }];
    if (invalid) {
      return {
        files,
        pages: [],
        assets: [],
        config: { source: CONFIG, contents: titleLine(doc.get("site_name")) },
        diagnostics: [docsDirError(`docs_dir \`${docsDir}\` is not a folder inside the source.`, lineOf(docsNode))],
      };
    }

    const siteNode = doc.get("site_dir", true);
    const siteDir = folder(isScalar(siteNode) ? siteNode.value : undefined, "site");
    const pages: ImportedPage[] = [];
    const assets: ImportedAsset[] = [];

    for (const path of source.files) {
      if (path === CONFIG) continue;
      if (path === siteDir || path.startsWith(`${siteDir}/`)) {
        files.push({ path, kind: "unsupported", reason: "inside site_dir, which the import never reads" });
      } else if (!path.startsWith(`${docsDir}/`)) {
        files.push({ path, kind: "unsupported", reason: "outside docs_dir" });
      } else if (/\.md$/i.test(path)) {
        files.push({ path, kind: "content" });
        pages.push({ source: path, destination: path.slice(docsDir.length + 1), contents: source.read(path) });
      } else {
        files.push({ path, kind: "asset" });
        assets.push({ source: path, destination: path.slice(docsDir.length + 1) });
      }
    }

    const data = doc.toJS() as Record<string, unknown> | null;
    const urls: ImportUrls = data?.["use_directory_urls"] === false ? "files" : "pretty";
    const navigation = navigationOf(data?.["nav"], pages, urls);

    return {
      files,
      pages,
      assets,
      config: { source: CONFIG, contents: titleLine(doc.get("site_name")) },
      ...(navigation === undefined ? {} : { navigation }),
      ...(urls === "files" ? { urls } : {}),
      diagnostics: [],
    };
  },
};

function docsDirError(message: string, line: number): Diagnostic {
  return { id: "import.docs-dir", severity: "error", message, pos: at(line) };
}

function titleLine(value: unknown): string {
  const title = typeof value === "string" && value.trim() !== "" ? value : "MkDocs site";
  return `title: ${/^[\w .-]+$/.test(title) ? title : JSON.stringify(title)}\n`;
}
