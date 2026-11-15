/**
 * Fills a collection's URL pattern from one record: `/items/{id}/` plus the fields the record has. A missing field is
 * an error at the record, never a page with an empty segment, and `base` and the trailing-slash rule come from the same
 * rules file pages use, so a record page and a file page are addressed the same way.
 *
 * A field is written as it is, or as its URL-safe slug with `{name|slug}`. When a pattern gives two records one URL,
 * {@link recordUrlsOf} appends the collection's `disambiguate` field to those records only, so a URL a record already
 * owns never changes for a rename elsewhere in the collection.
 */
import type { CollectionConfig, Diagnostic, RecordPos, SourcePos } from "../contracts/index.ts";
import { slugOf } from "./slug.ts";

/** One field value substituted into a pattern. */
interface Filled {
  readonly value: string;
  readonly missing: readonly string[];
  /** Fields a `slug` filter emptied, so the caller reports the record instead of writing an empty segment. */
  readonly empty: readonly string[];
  /** The first filter that is not `slug`, when the pattern names one. */
  readonly unknown?: string;
}

/** The text of a scalar, or `undefined` for a value a URL cannot show. */
function scalar(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return undefined;
}

/** The value at a dot-separated path, with own keys only and numeric list indexes. */
function resolveIn(value: unknown, path: string): { readonly found: boolean; readonly value?: unknown } {
  let current: unknown = value;
  for (const segment of path.split(".").map((part) => part.trim()).filter((part) => part !== "")) {
    if (typeof current !== "object" || current === null) return { found: false };
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment) || Number(segment) >= current.length) return { found: false };
      current = current[Number(segment)];
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return { found: false };
    current = (current as Record<string, unknown>)[segment];
  }
  return { found: true, value: current };
}

/**
 * Fills every `{path}` in `pattern` from `fields`. `{{` and `}}` are literal braces. A path that names no scalar is
 * collected in `missing`; the pattern keeps its placeholder so the caller reports where it was written.
 *
 * A placeholder may name a filter after `|`: `{name|slug}` fills the URL-safe slug of the value instead of the value as
 * written. Only `slug` exists, and it never produces a `/`, so the pattern alone decides the URL's segments. A slug
 * that comes out empty is collected in `empty`.
 *
 * With `suffix`, `-<slug of suffix>` is appended to the last field the pattern substitutes, so a disambiguated record
 * keeps the extra value inside the segment the pattern meant for the record: `/p/{name|slug}/print/` becomes
 * `/p/jane-42/print/`, never `/p/jane/print-42/`.
 */
export function fillPermalink(
  pattern: string,
  fields: Readonly<Record<string, unknown>>,
  suffix?: string,
): Filled {
  const missing: string[] = [];
  const empty: string[] = [];
  let unknown: string | undefined;
  let text = "";
  let lastValueEnd: number | undefined;
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]!;
    if (char === "{" && pattern[index + 1] === "{") {
      text += "{";
      index += 1;
      continue;
    }
    if (char === "}" && pattern[index + 1] === "}") {
      text += "}";
      index += 1;
      continue;
    }
    if (char !== "{") {
      text += char;
      continue;
    }
    const close = pattern.indexOf("}", index + 1);
    if (close < 0) {
      text += char;
      continue;
    }
    const [path = "", ...filters] = pattern.slice(index + 1, close).split("|").map((part) => part.trim());
    const filter = filters[0];
    const found = resolveIn(fields, path);
    const value = found.found ? scalar(found.value) : undefined;
    if (filter !== undefined && filter !== "slug") {
      unknown ??= filter;
      text += pattern.slice(index, close + 1);
    } else if (value === undefined) {
      missing.push(path);
      text += pattern.slice(index, close + 1);
    } else if (filter === "slug") {
      const slug = slugOf(value);
      if (slug === "") empty.push(path);
      text += slug;
      lastValueEnd = text.length;
    } else {
      text += value;
      lastValueEnd = text.length;
    }
    index = close;
  }
  if (suffix !== undefined && lastValueEnd !== undefined) {
    text = `${text.slice(0, lastValueEnd)}-${slugOf(suffix)}${text.slice(lastValueEnd)}`;
  }
  return { value: text, missing, empty, ...(unknown === undefined ? {} : { unknown }) };
}

/** A URL path with a leading `/` and, when it does not name a file, a trailing `/`. */
function pretty(path: string): string {
  const trimmed = path.trim();
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const last = withSlash.slice(withSlash.lastIndexOf("/") + 1);
  if (last === "" || last.includes(".")) return withSlash;
  return `${withSlash}/`;
}

/** A page URL: the site `base`, then the language prefix, then the filled pattern. */
export function urlOfPattern(pattern: string, base: string, prefix = ""): string {
  const path = pretty(pattern);
  const language = prefix === "" || path === prefix || path.startsWith(`${prefix}/`) ? path : `${prefix}${path}`;
  if (base === "") return language;
  return language === "/" ? `${base}/` : `${base}${language}`;
}

/** A record position as a diagnostic position. */
export function recordSourcePos(position: RecordPos): SourcePos {
  return {
    file: position.file,
    line: position.startLine,
    column: position.startColumn,
    endLine: position.endLine,
    endColumn: position.endColumn,
  };
}

/** One record page's URL, or the finding that kept it from being filled. */
export interface RecordUrl {
  /** The URL including `base`, when every field was present. */
  readonly url?: string;
  /** The finding for a pattern that could not be filled. */
  readonly diagnostic?: Diagnostic;
}

/** Fills one record's URL, reporting a missing or non-scalar field at the record. */
export function recordUrl(
  collection: string,
  id: string,
  fields: Readonly<Record<string, unknown>>,
  config: Pick<CollectionConfig, "permalink">,
  options: { readonly base: string; readonly prefix?: string; readonly position: RecordPos; readonly suffix?: string },
): RecordUrl {
  const pattern = config.permalink;
  if (pattern === undefined) return {};
  const filled = fillPermalink(pattern, fields, options.suffix);
  if (filled.unknown !== undefined) {
    return {
      diagnostic: {
        id: "data.permalink-filter",
        severity: "error",
        message: `The URL pattern of ${collection}.${id} uses the filter "${filled.unknown}", which does not exist.`,
        pos: recordSourcePos(options.position),
        help: 'The only filter is `slug`, written `{name|slug}`.',
      },
    };
  }
  if (filled.missing.length > 0) {
    const names = filled.missing.map((name) => `"${name}"`).join(", ");
    return {
      diagnostic: {
        id: "data.permalink-field",
        severity: "error",
        message: `The URL pattern of ${collection}.${id} names ${names}, which the record does not hold as a scalar.`,
        pos: recordSourcePos(options.position),
        help: "Add the field to the record, or change `collections.<name>.permalink`.",
      },
    };
  }
  if (filled.empty.length > 0) {
    const names = filled.empty.map((name) => `"${name}"`).join(", ");
    return {
      diagnostic: {
        id: "data.permalink-slug",
        severity: "error",
        message: `The URL pattern of ${collection}.${id} makes an empty slug from ${names}.`,
        pos: recordSourcePos(options.position),
        help: "Give the record a value with a letter or digit, or use the field without the `slug` filter.",
      },
    };
  }
  return { url: urlOfPattern(filled.value, options.base, options.prefix ?? "") };
}

/** One record as the URL set needs it: its id, its fields in one language, and where it sits. */
export interface UrlRecord {
  readonly id: string;
  /** The fields the pattern fills from, with `id` filled in when the source omits it. */
  readonly fields: Readonly<Record<string, unknown>>;
  readonly position: RecordPos;
}

/** Every record page URL of one collection in one language. */
export interface RecordUrlMap {
  /** Each record's URL, or the finding that kept its pattern from being filled. */
  readonly urls: ReadonlyMap<string, RecordUrl>;
  /** URLs more than one record still shares, in URL order; the caller reports each group with both ids. */
  readonly collisions: readonly { readonly url: string; readonly ids: readonly string[]; readonly position: RecordPos }[];
  /** The disambiguator's value for each record whose URL needed it, so its views carry the same suffix. */
  readonly suffixes: ReadonlyMap<string, string>;
}

/**
 * Every record page URL of one collection in one language, with the collection's `disambiguate` field appended only to
 * the records whose pattern gives a URL another record's does. A record with a URL of its own keeps it unchanged, so
 * adding a colliding record does not move the addresses of the ones already published. Records whose URLs still match
 * after the suffix are reported together, and the order of the records never changes the result.
 */
export function recordUrlsOf(
  collection: string,
  records: readonly UrlRecord[],
  config: Pick<CollectionConfig, "permalink" | "disambiguate">,
  options: { readonly base: string; readonly prefix?: string },
): RecordUrlMap {
  const urls = new Map<string, RecordUrl>();
  const byUrl = new Map<string, UrlRecord[]>();
  for (const record of records) {
    const result = recordUrl(collection, record.id, record.fields, config, {
      base: options.base,
      ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
      position: record.position,
    });
    urls.set(record.id, result);
    if (result.url === undefined) continue;
    const seen = byUrl.get(result.url);
    byUrl.set(result.url, seen === undefined ? [record] : [...seen, record]);
  }

  const suffixes = new Map<string, string>();
  const field = config.disambiguate;
  if (field !== undefined) {
    for (const [url, group] of byUrl) {
      if (group.length < 2) continue;
      for (const record of group) {
        const found = resolveIn(record.fields, field);
        const value = found.found ? scalar(found.value) : undefined;
        if (value === undefined || slugOf(value) === "") {
          urls.set(record.id, {
            diagnostic: {
              id: "data.permalink-disambiguator",
              severity: "error",
              message: `The URL pattern of ${collection}.${record.id} adds \`${field}\`, which the record does not hold as a slug.`,
              pos: recordSourcePos(record.position),
              help: "Add the field to the record, or change `collections.<name>.disambiguate`.",
            },
          });
          continue;
        }
        suffixes.set(record.id, value);
        urls.set(
          record.id,
          recordUrl(collection, record.id, record.fields, config, {
            base: options.base,
            ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
            position: record.position,
            suffix: value,
          }),
        );
      }
    }
  }

  const resolved = new Map<string, UrlRecord[]>();
  for (const record of records) {
    const url = urls.get(record.id)?.url;
    if (url === undefined) continue;
    const seen = resolved.get(url);
    resolved.set(url, seen === undefined ? [record] : [...seen, record]);
  }
  const collisions = [...resolved.entries()]
    .filter(([, group]) => group.length > 1)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([url, group]) => ({ url, ids: group.map((record) => record.id), position: group[0]!.position }));

  return { urls, collisions, suffixes };
}
