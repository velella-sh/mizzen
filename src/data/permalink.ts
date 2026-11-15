/**
 * Fills a collection's URL pattern from one record: `/items/{id}/` plus the fields the record has. A missing field is
 * an error at the record, never a page with an empty segment, and `base` and the trailing-slash rule come from the same
 * rules file pages use, so a record page and a file page are addressed the same way.
 *
 * A field is written as it is, or as its URL-safe slug with `{name|slug}`; `disambiguate` then appends another field to
 * the last segment, so a pattern two records share still gives one URL each.
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
 */
export function fillPermalink(pattern: string, fields: Readonly<Record<string, unknown>>): Filled {
  const missing: string[] = [];
  const empty: string[] = [];
  let unknown: string | undefined;
  let text = "";
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
    } else {
      text += value;
    }
    index = close;
  }
  return { value: text, missing, empty, ...(unknown === undefined ? {} : { unknown }) };
}

/**
 * `url` with a second field appended to its last segment, so two records a first field cannot tell apart are still
 * one URL each: `/people/jane/` becomes `/people/jane-42/`, and a file URL keeps its extension before the suffix.
 */
function withDisambiguation(url: string, value: string): string {
  const suffix = `-${slugOf(value)}`;
  if (url.endsWith("/")) return `${url.slice(0, -1)}${suffix}/`;
  const dot = url.lastIndexOf(".");
  const slash = url.lastIndexOf("/");
  return dot > slash ? `${url.slice(0, dot)}${suffix}${url.slice(dot)}` : `${url}${suffix}`;
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
  config: Pick<CollectionConfig, "permalink" | "disambiguate">,
  options: { readonly base: string; readonly prefix?: string; readonly position: RecordPos },
): RecordUrl {
  const pattern = config.permalink;
  if (pattern === undefined) return {};
  const filled = fillPermalink(pattern, fields);
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
  let url = urlOfPattern(filled.value, options.base, options.prefix ?? "");
  const disambiguator = config.disambiguate;
  if (disambiguator !== undefined) {
    const value = resolveIn(fields, disambiguator);
    const text = value.found ? scalar(value.value) : undefined;
    if (text === undefined || slugOf(text) === "") {
      return {
        diagnostic: {
          id: "data.permalink-disambiguator",
          severity: "error",
          message: `The URL pattern of ${collection}.${id} adds \`${disambiguator}\`, which the record does not hold as a slug.`,
          pos: recordSourcePos(options.position),
          help: "Add the field to the record, or change `collections.<name>.disambiguate`.",
        },
      };
    }
    url = withDisambiguation(url, text);
  }
  return { url };
}
