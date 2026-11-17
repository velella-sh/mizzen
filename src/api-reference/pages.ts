/**
 * Builds the page and navigation entries of one read API reference.
 *
 * Every operation becomes one page at its `url`, titled by its `title`, with plain text that search can index.
 * Pages and navigation entries are sorted by URL and tag, so the order of the operations as they arrive changes
 * nothing. Two operation ids that are equal after case folding would address one folder on a case-insensitive file
 * system, so they are one `api-reference.duplicate-id` error and no page is built.
 */
import type { Diagnostic } from "../contracts/index.ts";
import type { NavGroup, NavItem, NavLink } from "../contracts/nav.ts";
import type {
  ApiDocument,
  ApiExample,
  ApiMediaType,
  ApiOperation,
  ApiParameter,
  ApiSchema,
} from "./read.ts";

/** One operation's page, with the text search reads from it. */
export interface ApiReferencePage {
  /** The page URL, including the reference path and any `base` the reader was given. */
  readonly url: string;
  /** The page title: the operation's summary, else its method and path. */
  readonly title: string;
  /** The operation's description, when it has one. */
  readonly description?: string;
  /** The operation the page shows. */
  readonly operation: ApiOperation;
  /** Plain text of the operation: title, method, path, parameters, body, and responses. */
  readonly text: string;
}

/** What {@link buildApiReferencePages} built. */
export interface ApiReferencePages {
  /** One page per operation, sorted by URL. */
  readonly pages: readonly ApiReferencePage[];
  /** The operations grouped by tag, with untagged operations as top-level links. */
  readonly navigation: readonly NavItem[];
  /** Findings that kept pages from being built; empty on success. */
  readonly diagnostics: readonly Diagnostic[];
}

/** Compares by code point, never by locale or UTF-16 unit. */
function byCodePoint(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const difference = left[index]!.codePointAt(0)! - right[index]!.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

/** The examples as searchable text: their names, summaries, and values. */
function exampleText(examples: readonly ApiExample[]): readonly string[] {
  const out: string[] = [];
  for (const example of examples) {
    out.push(example.name);
    if (example.summary !== undefined) out.push(example.summary);
    out.push(JSON.stringify(example.value));
  }
  return out;
}

/** The schema's keywords and property names as searchable text. */
function schemaText(schema: ApiSchema): readonly string[] {
  const out: string[] = [];
  if (schema.type !== undefined) out.push(...(Array.isArray(schema.type) ? schema.type : [schema.type]));
  if (schema.format !== undefined) out.push(schema.format);
  if (schema.description !== undefined) out.push(schema.description);
  if (schema.enum !== undefined) out.push(...schema.enum.map((value) => JSON.stringify(value)));
  if (schema.default !== undefined) out.push(JSON.stringify(schema.default));
  out.push(...schema.required);
  for (const property of schema.properties) {
    out.push(property.name, ...schemaText(property.schema));
  }
  if (schema.items !== undefined) out.push(...schemaText(schema.items));
  if (typeof schema.additionalProperties === "object") out.push(...schemaText(schema.additionalProperties));
  return out;
}

/** One media type as searchable text: its type, schema, and examples. */
function mediaText(media: ApiMediaType): readonly string[] {
  return [media.type, ...(media.schema === undefined ? [] : schemaText(media.schema)), ...exampleText(media.examples)];
}

/** One parameter as searchable text. */
function parameterText(parameter: ApiParameter): readonly string[] {
  return [
    parameter.name,
    parameter.in,
    ...(parameter.description === undefined ? [] : [parameter.description]),
    ...schemaText(parameter.schema),
    ...exampleText(parameter.examples),
  ];
}

/** The operation's title, method, path, description, tags, parameters, body, and responses as plain text. */
function textOf(operation: ApiOperation): string {
  const lines = [operation.title, `${operation.method.toUpperCase()} ${operation.path}`];
  if (operation.description !== undefined) lines.push(operation.description);
  lines.push(...operation.tags);
  for (const parameter of operation.parameters) lines.push(...parameterText(parameter));
  if (operation.requestBody !== undefined) {
    lines.push("Request body");
    if (operation.requestBody.description !== undefined) lines.push(operation.requestBody.description);
    for (const media of operation.requestBody.content) lines.push(...mediaText(media));
  }
  for (const response of operation.responses) {
    lines.push(response.status, response.description);
    for (const media of response.content) lines.push(...mediaText(media));
  }
  return lines.filter((line) => line !== "").join("\n");
}

/** The navigation entries: one group per tag, then one link for each untagged operation. */
function navigationOf(pages: readonly ApiReferencePage[]): readonly NavItem[] {
  const groups = new Map<string, NavLink[]>();
  const untagged: NavLink[] = [];
  for (const page of pages) {
    const link: NavLink = { title: page.title, url: page.url };
    if (page.operation.tags.length === 0) untagged.push(link);
    for (const tag of new Set(page.operation.tags)) {
      const children = groups.get(tag);
      if (children === undefined) groups.set(tag, [link]);
      else children.push(link);
    }
  }
  const navigation: NavItem[] = [...groups.entries()]
    .sort(([a], [b]) => byCodePoint(a, b))
    .map(([title, children]): NavGroup => ({ title, children }));
  navigation.push(...untagged);
  return navigation;
}

/**
 * Builds one page and one navigation entry for every operation of `document`. A duplicate id, compared after case
 * folding, is an error and builds no page at all.
 */
export function buildApiReferencePages(document: ApiDocument): ApiReferencePages {
  const operations = [...document.operations].sort((a, b) => byCodePoint(a.url, b.url));
  const diagnostics: Diagnostic[] = [];
  const ids = new Map<string, string>();
  for (const operation of operations) {
    const folded = operation.id.toLowerCase();
    const previous = ids.get(folded);
    if (previous !== undefined) {
      diagnostics.push({
        id: "api-reference.duplicate-id",
        severity: "error",
        message: `Operation id "${operation.id}" duplicates "${previous}" after case folding.`,
      });
      return { pages: [], navigation: [], diagnostics };
    }
    ids.set(folded, operation.id);
  }
  const pages: ApiReferencePage[] = operations.map((operation) => ({
    url: operation.url,
    title: operation.title,
    ...(operation.description === undefined ? {} : { description: operation.description }),
    operation,
    text: textOf(operation),
  }));
  return { pages, navigation: navigationOf(pages), diagnostics };
}
