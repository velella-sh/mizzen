/**
 * Reads the Markdown template each collection declares: a file under `_templates/` with its own front matter and a
 * body. A template is not a page and not a copied asset; a later stage instantiates it once per record, so the body
 * keeps its starting line for exact positions.
 *
 * A problem is a diagnostic, never a throw: a template that is missing, unreadable, or outside `_templates/` is left
 * out and reported at the `template` key that named it.
 */
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { LineCounter, parseDocument, type Node } from "yaml";
import { CONFIG_FILE } from "../config/load.ts";
import { parseFrontMatter } from "../content/frontmatter.ts";
import type { Diagnostic, SiteConfig, SourcePos } from "../contracts/index.ts";
import { lineIndex, nodePos, sourcePosOf } from "./positions.ts";

/** One collection's template, read once and ready to instantiate. */
export interface Template {
  /** Collection the template belongs to, as the config names it. */
  readonly collection: string;
  /** Template path relative to the site root, using `/`, for diagnostics and edit links. */
  readonly path: string;
  /** The template's front matter, such as the layout its record pages use. */
  readonly frontMatter: Readonly<Record<string, unknown>>;
  /** The Markdown body after the front matter, exactly as written. */
  readonly body: string;
  /** 1-based line of the template file where `body` starts. */
  readonly bodyLine: number;
}

/** What {@link loadTemplates} read. */
export interface TemplatesResult {
  /** Templates keyed by collection name, in config order; a template that failed is absent. */
  readonly templates: Readonly<Record<string, Template>>;
  /** Every finding, in the order it was made. */
  readonly diagnostics: readonly Diagnostic[];
}

/** Options of {@link loadTemplates}. */
export interface LoadTemplatesOptions {
  /** Absolute site root, where `mizzen.yml` lives. */
  readonly root: string;
  /** The loaded config. */
  readonly config: SiteConfig;
}

/** A position at the start of the config file, used when the exact key cannot be found. */
const AT_CONFIG: SourcePos = { file: CONFIG_FILE, line: 1, column: 1, endLine: 1, endColumn: 1 };

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Where a collection's `template` value is written in `mizzen.yml`, so a bad path points at its config line. */
function templatePosition(root: string, collection: string): SourcePos {
  let text: string;
  try {
    text = readFileSync(resolve(root, CONFIG_FILE), "utf8");
  } catch {
    return AT_CONFIG;
  }
  const document = parseDocument(text, { lineCounter: new LineCounter() });
  const node = document.getIn(["collections", collection, "template"], true) as Node | undefined;
  if (node === undefined) return AT_CONFIG;
  return sourcePosOf(nodePos(lineIndex(text), CONFIG_FILE, node));
}

/**
 * Reads the template of every collection that declares one, in config order. A collection without `template` is
 * skipped, so an ordinary data collection needs no template.
 */
export async function loadTemplates(options: LoadTemplatesOptions): Promise<TemplatesResult> {
  const { root, config } = options;
  const sourceDir = resolve(root, config.source);
  const diagnostics: Diagnostic[] = [];
  const templates: Record<string, Template> = {};

  for (const [collection, entry] of Object.entries(config.collections)) {
    if (entry.template === undefined) continue;
    const pos = templatePosition(root, collection);
    const value = normalize(entry.template);
    const file = resolve(sourceDir, value);
    const inside = relative(sourceDir, file);
    const relativeToSource = inside.split(sep).join("/");
    if (
      inside === ".." ||
      inside.startsWith(`..${sep}`) ||
      isAbsolute(inside) ||
      !relativeToSource.startsWith("_templates/")
    ) {
      diagnostics.push({
        id: "data.template-path",
        severity: "error",
        message: `Collection "${collection}" names template "${entry.template}", which is not a file under \`_templates/\` in the source folder.`,
        pos,
        help: "Move the template under `_templates/` and write its path relative to the source folder.",
      });
      continue;
    }

    const display = relative(root, file).split(sep).join("/");
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (err) {
      const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
      diagnostics.push({
        id: missing ? "data.template-missing" : "data.template-unreadable",
        severity: "error",
        message: missing
          ? `Collection "${collection}" reads template "${entry.template}", which does not exist.`
          : `Collection "${collection}" cannot read template "${entry.template}".`,
        pos,
        help: missing
          ? "Create the file under `_templates/`, or fix `collections.<name>.template` in mizzen.yml."
          : "Point `collections.<name>.template` at a readable Markdown file.",
      });
      continue;
    }

    const parsed = parseFrontMatter(text, display);
    diagnostics.push(...parsed.diagnostics);
    templates[collection] = {
      collection,
      path: display,
      frontMatter: parsed.data,
      body: parsed.body,
      bodyLine: parsed.bodyLine,
    };
  }

  return { templates, diagnostics };
}
