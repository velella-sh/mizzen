/**
 * Builds one page per record from a collection's template, with no intermediate Markdown file on disk.
 *
 * A template is parsed once, then cloned for every record: its front matter is filled from the record, its directives
 * are resolved against the record, and its body becomes the page's Markdown twin. Field values keep the position of the
 * line they came from in the data file, so the page, its HTML, and its outputs all point at the record to edit. The
 * page's own source is the record's span, and `Page.record` names the collection, the record, and the template.
 *
 * Records keep source order; the caller sorts the finished pages by URL together with the file pages, so a record page
 * and a file page with the same URL collide through the model's ordinary duplicate-URL check.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Nodes, Root, RootContent } from "mdast";
import type {
  Collection,
  CollectionConfig,
  DataRecord,
  Diagnostic,
  Heading,
  Page,
  SiteConfig,
} from "../contracts/index.ts";
import { directionFromLang } from "../content/lang.ts";
import { parseMarkdown } from "../markdown/parse.ts";
import { applyField, type FieldResult } from "../markdown/plugins/field.ts";
import { eachItems, ifKeeps } from "../markdown/plugins/field-blocks.ts";
import { selectRecords } from "../markdown/plugins/records.ts";
import { applyRecordLinks } from "../markdown/plugins/links.ts";
import { markdownToHtml } from "../markdown/to-html.ts";
import { parseSpan } from "../source/spans.ts";
import { substituteFrontMatter } from "./frontmatter.ts";
import { markdownFieldBlocks } from "./markdown-field.ts";
import { recordSourcePos, recordUrl } from "./permalink.ts";
import { localizeFields, prefixed, prefixOfLang, type RecordScope } from "./record-context.ts";
import type { Template } from "./template.ts";

/** What {@link buildRecordPages} needs. */
export interface RecordPagesOptions {
  /** Absolute site root, for reading a schema and the data file a Markdown field lives in. */
  readonly root: string;
  readonly config: SiteConfig;
  readonly collections: Readonly<Record<string, Collection>>;
  readonly templates: Readonly<Record<string, Template>>;
  /** Repository folder in front of every displayed data path, such as `docs`; `""` when the site is the root. */
  readonly filePrefix?: string;
}

/** The record pages a build made, and every finding it made while making them. */
export interface RecordPagesResult {
  readonly pages: readonly Page[];
  readonly diagnostics: readonly Diagnostic[];
}

/** One language a record page is built in. */
interface PageLanguage {
  readonly code: string;
  readonly prefix: string;
}

/** A field's directory in the data file's text, for a Markdown field's block positions. */
async function linesOf(
  root: string,
  file: string,
  cache: Map<string, readonly string[]>,
  filePrefix?: string,
): Promise<readonly string[]> {
  const known = cache.get(file);
  if (known !== undefined) return known;
  // A displayed path may carry the repository folder; the file on disk is always relative to the site root.
  const candidates =
    filePrefix === undefined || filePrefix === "" || !file.startsWith(`${filePrefix}/`)
      ? [file]
      : [file, file.slice(filePrefix.length + 1)];
  let lines: readonly string[] = [];
  for (const candidate of candidates) {
    try {
      lines = (await readFile(resolve(root, candidate), "utf8")).split("\n");
      break;
    } catch {
      lines = [];
    }
  }
  cache.set(file, lines);
  return lines;
}

/** The fields a collection's schema declares, when it has one; a bad schema is the collection stage's finding. */
async function schemaFieldsOf(root: string, entry: CollectionConfig): Promise<ReadonlySet<string> | undefined> {
  if (entry.schema === undefined) return undefined;
  try {
    const document: unknown = JSON.parse(await readFile(resolve(root, entry.schema), "utf8"));
    if (typeof document !== "object" || document === null || Array.isArray(document)) return undefined;
    const properties = (document as { properties?: unknown }).properties;
    if (typeof properties !== "object" || properties === null || Array.isArray(properties)) return undefined;
    return new Set(Object.keys(properties));
  } catch {
    // A schema that cannot be read is the collection stage's finding; every field stays readable here.
    return undefined;
  }
}

/** The offset span of a node in the template body, when the parser recorded one. */
function offsetsOf(node: Nodes): { start: number; end: number } | undefined {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return typeof start === "number" && typeof end === "number" ? { start, end } : undefined;
}

/** The item's fields as a scope: the item's own keys first, then the record's. */
function withItem(scope: RecordScope, item: Readonly<Record<string, unknown>>): RecordScope {
  return { ...scope, fields: item };
}

/** A selected record as a scope: its fields come first, and its own positions name its file. */
function withRecord(scope: RecordScope, record: DataRecord): RecordScope {
  return { ...scope, record, fields: record.fields, recordFields: record.fields };
}

/** True for a node whose type field the page reads. */
function isDirective(node: Nodes): node is Nodes & { readonly name: string } {
  return node.type === "textDirective" || node.type === "leafDirective" || node.type === "containerDirective";
}

/** The page-building state shared by every record of one template and language. */
interface Build {
  readonly root: string;
  readonly filePrefix: string | undefined;
  readonly scope: RecordScope;
  readonly depth: number;
  readonly diagnostics: Diagnostic[];
  readonly sourceLines: Map<string, readonly string[]>;
}

/**
 * Rewrites one `:field[…]` at the node that holds it. A Markdown field alone in a paragraph becomes its blocks; any
 * other Markdown field is shown inline, and a plain field is a span naming its line in the data file.
 */
async function rewriteField(
  node: Nodes,
  scope: RecordScope,
  build: Build,
  block: boolean,
): Promise<FieldResult | readonly RootContent[]> {
  const result = applyField(node, scope);
  build.diagnostics.push(...result.diagnostics);
  if (block && result.markdown !== undefined) {
    const lines = await linesOf(build.root, result.markdown.span.file, build.sourceLines, build.filePrefix);
    return markdownFieldBlocks(result.markdown.value, result.markdown.span, lines);
  }
  return result;
}

/** Rewrites a list of nodes, returning their replacements in order. */
async function rewriteChildren(
  children: readonly Nodes[],
  build: Build,
): Promise<RootContent[]> {
  const out: RootContent[] = [];
  for (const node of children) {
    out.push(...(await rewriteNode(node, build)).map((entry) => entry as RootContent));
  }
  return out;
}

/** Rewrites one node into the nodes that replace it. */
async function rewriteNode(node: Nodes, build: Build): Promise<RootContent[]> {
  if (isDirective(node) && node.type === "textDirective" && node.name === "field") {
    const result = await rewriteField(node, build.scope, build, false);
    return result instanceof Array ? [...result] : result.replacement === undefined ? [] : [result.replacement as RootContent];
  }
  if (isDirective(node) && node.type === "leafDirective" && node.name === "field") {
    const result = await rewriteField(node, build.scope, build, true);
    return result instanceof Array ? [...result] : result.replacement === undefined ? [] : [result.replacement as RootContent];
  }
  if (isDirective(node) && node.type === "containerDirective") {
    if (node.name === "if" || node.name === "each" || node.name === "records") {
      if (build.depth >= 2) {
        build.diagnostics.push({
          id: "data.block-nesting",
          severity: "error",
          message: `A \`:::${node.name}\` block is nested more than one level deep in ${build.scope.file}.`,
          ...(node.position === undefined
            ? {}
            : {
                pos: {
                  file: build.scope.file,
                  line: node.position.start.line,
                  column: node.position.start.column,
                  endLine: node.position.end.line,
                  endColumn: Math.max(1, node.position.end.column - 1),
                },
              }),
          help: "A template may nest one block inside another, not more.",
        });
        return [];
      }
      const children = (node as Nodes & { children: Nodes[] }).children;
      if (node.name === "if") {
        const kept = ifKeeps(node as never, build.scope);
        build.diagnostics.push(...kept.diagnostics);
        if (!kept.keep) return [];
        return rewriteChildren(children, { ...build, depth: build.depth + 1 });
      }
      if (node.name === "each") {
        const each = eachItems(node as never, build.scope);
        build.diagnostics.push(...each.diagnostics);
        const out: RootContent[] = [];
        for (const item of each.items) {
          out.push(
            ...(await rewriteChildren(children, { ...build, scope: withItem(build.scope, item), depth: build.depth + 1 })),
          );
        }
        return out;
      }
      const selected = selectRecords(node as never, build.scope);
      build.diagnostics.push(...selected.diagnostics);
      const out: RootContent[] = [];
      for (const record of selected.records) {
        out.push(
          ...(await rewriteChildren(children, { ...build, scope: withRecord(build.scope, record), depth: build.depth + 1 })),
        );
      }
      return out;
    }
    (node as Nodes & { children: RootContent[] }).children = await rewriteChildren(
      (node as Nodes & { children: Nodes[] }).children,
      build,
    );
    return [node as RootContent];
  }
  if (node.type === "paragraph") {
    const children = node.children;
    if (children.length === 1 && isDirective(children[0]!) && children[0]!.name === "field") {
      const result = await rewriteField(children[0]!, build.scope, build, true);
      if (result instanceof Array) return [...result];
      return result.replacement === undefined ? [] : [{ ...node, children: [result.replacement as never] }];
    }
    node.children = (await rewriteChildren(children, build)) as typeof node.children;
    return [node];
  }
  if ("children" in node) {
    (node as Nodes & { children: RootContent[] }).children = await rewriteChildren(node.children, build);
    return [node as RootContent];
  }
  return [node as RootContent];
}

/** The template text between a block's children, with each child's twin in its place. */
function twinInner(children: readonly Nodes[], body: string, scope: RecordScope): string {
  if (children.length === 0) return "";
  const first = offsetsOf(children[0]!);
  const last = offsetsOf(children[children.length - 1]!);
  if (first === undefined || last === undefined) return "";
  let out = "";
  let cursor = first.start;
  for (const child of children) {
    const span = offsetsOf(child);
    if (span === undefined) continue;
    out += body.slice(cursor, span.start);
    out += twinNode(child, body, scope);
    cursor = span.end;
  }
  // the last child's twin already covers through its own end; keep no closing fence
  return out;
}

/** The Markdown twin of one node, with directives resolved for the record. */
function twinNode(node: Nodes, body: string, scope: RecordScope): string {
  const span = offsetsOf(node);
  if (span === undefined) return "";
  if (isDirective(node) && (node.type === "textDirective" || node.type === "leafDirective") && node.name === "field") {
    const result = applyField(node, scope);
    return result.markdown?.value ?? result.twin;
  }
  if (isDirective(node) && node.type === "containerDirective") {
    const children = (node as Nodes & { children: Nodes[] }).children;
    if (node.name === "if") {
      const kept = ifKeeps(node as never, scope);
      return kept.keep ? twinInner(children, body, scope) : "";
    }
    if (node.name === "each") {
      const each = eachItems(node as never, scope);
      return each.items.map((item) => twinInner(children, body, withItem(scope, item))).join("\n");
    }
    if (node.name === "records") {
      const selected = selectRecords(node as never, scope);
      return selected.records.map((record) => twinInner(children, body, withRecord(scope, record))).join("\n");
    }
    return twinInner(children, body, scope);
  }
  if ("children" in node && node.children.length > 0) {
    const first = offsetsOf(node.children[0]!);
    const last = offsetsOf(node.children[node.children.length - 1]!);
    if (first === undefined || last === undefined) return body.slice(span.start, span.end);
    return `${body.slice(span.start, first.start)}${twinInner(node.children, body, scope)}${body.slice(last.end, span.end)}`;
  }
  return body.slice(span.start, span.end);
}

/** The whole twin: the body with each directive resolved. */
function twinOf(children: readonly Nodes[], body: string, scope: RecordScope): string {
  let out = "";
  let cursor = 0;
  for (const child of children) {
    const span = offsetsOf(child);
    if (span === undefined) continue;
    out += body.slice(cursor, span.start);
    out += twinNode(child, body, scope);
    cursor = span.end;
  }
  return out;
}

/** Headings with their positions, preferring a `data-src` a field block already carries. */
function headingsOf(tree: Root, collected: readonly { depth: number; text: string; id: string }[], template: string): Heading[] {
  const nodes = tree.children.filter((node): node is Extract<RootContent, { type: "heading" }> => node.type === "heading");
  return collected.map((heading, index) => {
    const node = nodes[index];
    const properties = (node?.data as { hProperties?: Record<string, unknown> } | undefined)?.hProperties;
    const stamped = typeof properties?.["data-src"] === "string" ? parseSpan(properties["data-src"] as string) : undefined;
    const start = node?.position?.start ?? { line: 1, column: 1 };
    const end = node?.position?.end ?? start;
    return {
      depth: heading.depth as Heading["depth"],
      id: heading.id,
      text: heading.text,
      pos: stamped ?? {
        file: template,
        line: start.line,
        column: start.column,
        endLine: end.line,
        endColumn: end.line === start.line ? Math.max(start.column, end.column - 1) : Math.max(1, end.column - 1),
      },
    };
  });
}

/** The first top-level `h1`'s text, with a field's rendered HTML reduced to its text. */
function firstHeadingText(tree: Root): string {
  const heading = tree.children.find((node) => node.type === "heading" && node.depth === 1);
  if (heading === undefined || !("children" in heading)) return "";
  const text = heading.children
    .map((child) => {
      if (child.type === "text" || child.type === "inlineCode") return child.value;
      if (child.type === "html") return child.value.replace(/<[^>]*>/g, "");
      return "";
    })
    .join("");
  return text.trim();
}

/**
 * Builds the record pages of every collection that names both a template and a URL pattern, in config order. A
 * collection without either builds no pages, so an ordinary data collection is untouched.
 */
export async function buildRecordPages(options: RecordPagesOptions): Promise<RecordPagesResult> {
  const { root, config, collections, templates, filePrefix } = options;
  const diagnostics: Diagnostic[] = [];
  const pages: Page[] = [];
  const sourceLines = new Map<string, readonly string[]>();
  const languages: readonly PageLanguage[] =
    config.languages.length === 0
      ? [{ code: config.lang, prefix: "" }]
      : config.languages.map((language) => ({ code: language.code, prefix: language.prefix }));

  for (const [name, entry] of Object.entries(config.collections)) {
    if (entry.template === undefined || entry.permalink === undefined) continue;
    const template = templates[name];
    const collection = collections[name];
    if (template === undefined || collection === undefined) continue;
    const schemaFields = await schemaFieldsOf(root, entry);
    const markdownFields = new Set(entry.markdown ?? []);

    for (const language of languages) {
      const source: Template = template.localized[language.code] ?? template;
      const parsed = await parseMarkdown(source.body, source.bodyLine);
      for (const record of collection.records) {
        const localized = localizeFields(record.fields, language.code, config.lang);
        const fields =
          localized.fields["id"] === undefined ? { ...localized.fields, id: record.id } : localized.fields;
        const scope: RecordScope = {
          collection: name,
          record,
          recordFields: fields,
          fields,
          collections,
          ...(schemaFields === undefined ? {} : { schemaFields }),
          markdownFields,
          lang: language.code,
          defaultLang: config.lang,
          ...(filePrefix === undefined || filePrefix === "" ? {} : { filePrefix }),
          file: source.path,
        };
        const filled = substituteFrontMatter(source.frontMatter, {
          fields,
          file: source.path,
          line: 1,
          ...(schemaFields === undefined ? {} : { schemaFields }),
        });
        diagnostics.push(...filled.diagnostics);

        // A template may set its language from a field (`lang: "{lang}"`); the page's language and direction follow
        // the substituted front matter, and fall back to the language this build pass is making.
        const declaredLang = typeof filled.data.lang === "string" ? filled.data.lang.trim() : "";
        const pageLangCode = declaredLang === "" ? language.code : declaredLang;
        const pagePrefix = prefixOfLang(config, pageLangCode);

        const url = recordUrl(name, record.id, fields, entry, {
          base: config.base,
          prefix: language.prefix,
          position: record.position,
        });
        if (url.diagnostic !== undefined) {
          diagnostics.push(url.diagnostic);
          continue;
        }
        if (url.url === undefined) continue;

        const tree = structuredClone(parsed) as Root;
        const build: Build = { scope, depth: 0, diagnostics, sourceLines, root, filePrefix };
        tree.children = await rewriteChildren(tree.children, build);
        applyRecordLinks(tree, {
          collections,
          config: config.collections,
          base: config.base,
          prefix: pagePrefix,
          lang: pageLangCode,
          defaultLang: config.lang,
          file: source.path,
        });

        const rendered = await markdownToHtml(tree, source.path);
        const markdown = twinOf(parsed.children, source.body, scope);
        const frontMatter: Record<string, unknown> = {
          ...filled.data,
          layout: typeof filled.data.layout === "string" ? filled.data.layout : "record",
        };
        if (languages.length > 1 && frontMatter.translation_key === undefined) {
          frontMatter.translation_key = `${name}:${record.id}`;
        }
        const title =
          typeof frontMatter.title === "string"
            ? frontMatter.title
            : typeof frontMatter.title === "number"
              ? String(frontMatter.title)
              : firstHeadingText(tree) || record.id;
        const dir =
          frontMatter.dir === "ltr" || frontMatter.dir === "rtl" ? frontMatter.dir : directionFromLang(pageLangCode);
        const sourcePosition = recordSourcePos({
          ...record.position,
          file: prefixed(record.position.file, filePrefix),
        });

        pages.push({
          url: url.url,
          source: sourcePosition,
          frontMatter: frontMatter as Page["frontMatter"],
          title,
          lang: pageLangCode,
          dir,
          headings: headingsOf(tree, rendered.headings, prefixed(source.path, filePrefix)),
          html: rendered.html,
          markdown,
          kind: "doc",
          record: {
            collection: name,
            id: record.id,
            position: {
              ...record.position,
              file: prefixed(record.position.file, filePrefix),
            },
            template: prefixed(source.path, filePrefix),
            templateLine: source.bodyLine,
            fallbacks: localized.fallbacks,
          },
        });
      }
    }
  }

  return { pages, diagnostics };
}
