/**
 * Fills a collection's URL pattern from one record: `/items/{id}/` plus the fields the record has. A missing field is
 * an error at the record, never a page with an empty segment, and `base` and the trailing-slash rule come from the same
 * rules file pages use, so a record page and a file page are addressed the same way.
 *
 * Slugs are not derived here: the pattern is filled with the value as written.
 */
import type { CollectionConfig, Diagnostic, RecordPos, SourcePos } from "../contracts/index.ts";

/** One field value substituted into a pattern. */
interface Filled {
  readonly value: string;
  readonly missing: readonly string[];
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
 */
export function fillPermalink(pattern: string, fields: Readonly<Record<string, unknown>>): Filled {
  const missing: string[] = [];
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
    const path = pattern.slice(index + 1, close).trim();
    const found = resolveIn(fields, path);
    const value = found.found ? scalar(found.value) : undefined;
    if (value === undefined) {
      missing.push(path);
      text += pattern.slice(index, close + 1);
    } else {
      text += value;
    }
    index = close;
  }
  return { value: text, missing };
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
  options: { readonly base: string; readonly prefix?: string; readonly position: RecordPos },
): RecordUrl {
  const pattern = config.permalink;
  if (pattern === undefined) return {};
  const filled = fillPermalink(pattern, fields);
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
  return { url: urlOfPattern(filled.value, options.base, options.prefix ?? "") };
}
