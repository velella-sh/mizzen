/**
 * Reads the Markdown template each collection declares: a file under `_templates/` with its own front matter and a
 * body. A template is not a page and not a copied asset; a later stage instantiates it once per record, so the body
 * keeps its starting line for exact positions.
 *
 * A problem is a diagnostic, never a throw: a template that is missing, unreadable, or outside `_templates/` is left
 * out and reported at the `template` key that named it.
 */
import { readFileSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { LineCounter, parseDocument, type Node } from "yaml";
import { CONFIG_FILE } from "../config/load.ts";
import { MARKDOWN } from "../content/discover.ts";
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
  /** One template per language that has its own file, named `<template>.<lang>.md`, keyed by language code. */
  readonly localized: Readonly<Record<string, Template>>;
}

/** What {@link loadTemplates} read. */
export interface TemplatesResult {
  /** Templates keyed by collection name, in config order; a template that failed is absent. */
  readonly templates: Readonly<Record<string, Template>>;
  /** Named view templates, keyed by collection then view name; a view that failed is absent. */
  readonly views: Readonly<Record<string, Readonly<Record<string, Template>>>>;
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

/** True when `file` sits inside `root`; both are already resolved real paths. */
function insideRoot(root: string, file: string): boolean {
  const path = relative(root, file);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/** One template-path finding at the key that named it, whatever made the path unusable. */
function pathFinding(collection: string, template: string, pos: SourcePos, reason: string, key: string): Diagnostic {
  return {
    id: "data.template-path",
    severity: "error",
    message: `Collection "${collection}" names template "${template}", which ${reason}`,
    pos,
    help: `Point \`${key}\` at a \`.md\` or \`.markdown\` file under \`_templates/\` in the source folder.`,
  };
}

/** Where a value under `collections` is written in `mizzen.yml`, so a bad path points at its config line. */
function keyPosition(root: string, path: readonly (string | number)[]): SourcePos {
  let text: string;
  try {
    text = readFileSync(resolve(root, CONFIG_FILE), "utf8");
  } catch {
    return AT_CONFIG;
  }
  const document = parseDocument(text, { lineCounter: new LineCounter() });
  const node = document.getIn(path, true) as Node | undefined;
  if (node === undefined) return AT_CONFIG;
  return sourcePosOf(nodePos(lineIndex(text), CONFIG_FILE, node));
}

/** What {@link readTemplate} needs to read one template and its localized variants. */
interface ReadTemplateOptions {
  /** Absolute site root. */
  readonly root: string;
  /** Absolute source folder. */
  readonly sourceDir: string;
  /** Collection the template belongs to. */
  readonly collection: string;
  /** The template path as the config writes it. */
  readonly template: string;
  /** Where the key that named the template is written. */
  readonly pos: SourcePos;
  /** The key that named the template, for the finding's help. */
  readonly key: string;
  /** The loaded config, for its languages. */
  readonly config: SiteConfig;
  /** Where findings are added. */
  readonly diagnostics: Diagnostic[];
}

/** Reads one template and its localized variants; a problem is a finding and the template is absent. */
async function readTemplate(options: ReadTemplateOptions): Promise<Template | undefined> {
  const { root, sourceDir, collection, template, pos, key, config, diagnostics } = options;
  const value = normalize(template);
  const file = resolve(sourceDir, value);
  const inside = relative(sourceDir, file);
  const relativeToSource = inside.split(sep).join("/");
  if (!MARKDOWN.test(value)) {
    diagnostics.push(pathFinding(collection, template, pos, "is not a Markdown file.", key));
    return undefined;
  }
  if (
    inside === ".." ||
    inside.startsWith(`..${sep}`) ||
    isAbsolute(inside) ||
    !relativeToSource.startsWith("_templates/")
  ) {
    diagnostics.push(pathFinding(collection, template, pos, "is not a file under `_templates/` in the source folder.", key));
    return undefined;
  }

  // Links are resolved before the read, so a link that leaves `_templates` or the source folder is refused
  // without opening the file it points at.
  const real = await realpath(file).catch(() => undefined);
  if (real !== undefined) {
    const sourceReal = await realpath(sourceDir).catch(() => undefined);
    const templatesReal = await realpath(resolve(sourceDir, "_templates")).catch(() => undefined);
    if (
      sourceReal === undefined ||
      templatesReal === undefined ||
      !insideRoot(sourceReal, real) ||
      !insideRoot(templatesReal, real)
    ) {
      diagnostics.push(pathFinding(collection, template, pos, "resolves outside `_templates/` in the source folder.", key));
      return undefined;
    }
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
        ? `Collection "${collection}" reads template "${template}", which does not exist.`
        : `Collection "${collection}" cannot read template "${template}".`,
      pos,
      help: missing
        ? `Create the file under \`_templates/\`, or fix \`${key}\` in mizzen.yml.`
        : `Point \`${key}\` at a readable Markdown file.`,
    });
    return undefined;
  }

  const parsed = parseFrontMatter(text, display);
  diagnostics.push(...parsed.diagnostics);
  const localized: Record<string, Template> = {};
  // A language gets its own template when `<name>.<lang>.md` exists beside the declared one. A missing localized
  // file falls back to the declared template, which is the ordinary case for a one-language site.
  for (const language of config.languages) {
    if (language.code === config.lang) continue;
    const name = /^(.*?)(\.[^./]+)$/.exec(value);
    if (name === null) continue;
    const localizedValue = `${name[1]}.${language.code}${name[2]}`;
    const localizedFile = resolve(sourceDir, localizedValue);
    const localizedDisplay = relative(root, localizedFile).split(sep).join("/");
    // The name is derived, but the file may still be a link out of the site; refuse it before it is read.
    const localizedReal = await realpath(localizedFile).catch(() => undefined);
    if (localizedReal !== undefined) {
      const sourceReal = await realpath(sourceDir).catch(() => undefined);
      const templatesReal = await realpath(resolve(sourceDir, "_templates")).catch(() => undefined);
      if (
        sourceReal === undefined ||
        templatesReal === undefined ||
        !insideRoot(sourceReal, localizedReal) ||
        !insideRoot(templatesReal, localizedReal)
      ) {
        diagnostics.push(pathFinding(collection, localizedValue, pos, "resolves outside `_templates/` in the source folder.", key));
        continue;
      }
    }
    let localizedText: string;
    try {
      localizedText = await readFile(localizedFile, "utf8");
    } catch {
      continue;
    }
    const localizedParsed = parseFrontMatter(localizedText, localizedDisplay);
    diagnostics.push(...localizedParsed.diagnostics);
    localized[language.code] = {
      collection,
      path: localizedDisplay,
      frontMatter: localizedParsed.data,
      body: localizedParsed.body,
      bodyLine: localizedParsed.bodyLine,
      localized: {},
    };
  }
  return {
    collection,
    path: display,
    frontMatter: parsed.data,
    body: parsed.body,
    bodyLine: parsed.bodyLine,
    localized,
  };
}

/**
 * Reads the template of every collection that declares one, in config order, and the template of every view that
 * collection declares. A collection without `template` is skipped, so an ordinary data collection needs no template.
 */
export async function loadTemplates(options: LoadTemplatesOptions): Promise<TemplatesResult> {
  const { root, config } = options;
  const sourceDir = resolve(root, config.source);
  const diagnostics: Diagnostic[] = [];
  const templates: Record<string, Template> = {};
  const views: Record<string, Readonly<Record<string, Template>>> = {};

  for (const [collection, entry] of Object.entries(config.collections)) {
    if (entry.template === undefined) continue;
    const key = `collections.${collection}.template`;
    const template = await readTemplate({
      root,
      sourceDir,
      collection,
      template: entry.template,
      pos: keyPosition(root, ["collections", collection, "template"]),
      key,
      config,
      diagnostics,
    });
    if (template === undefined) continue;
    templates[collection] = template;

    const loadedViews: Record<string, Template> = {};
    for (const [view, viewEntry] of Object.entries(entry.views ?? {})) {
      const viewKey = `collections.${collection}.views.${view}.template`;
      const viewTemplate = await readTemplate({
        root,
        sourceDir,
        collection,
        template: viewEntry.template,
        pos: keyPosition(root, ["collections", collection, "views", view, "template"]),
        key: viewKey,
        config,
        diagnostics,
      });
      if (viewTemplate !== undefined) loadedViews[view] = viewTemplate;
    }
    if (Object.keys(loadedViews).length > 0) views[collection] = loadedViews;
  }

  return { templates, views, diagnostics };
}
