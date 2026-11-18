/**
 * Converts a VitePress config's `themeConfig.nav` array to Mizzen's `main` navigation. The array is read as text and
 * never executed: an entry must be an object literal whose `text`, `link`, and `items` values are literals. `text`
 * becomes `title`, `link` becomes `url`, and `items` becomes `children`, in the order written. An internal link to an
 * imported page is rewritten to that page's destination URL; an external URL is copied unchanged.
 */
import { stringify } from "yaml";
import type { Diagnostic } from "../../contracts/index.ts";
import { permalink } from "../../content/permalink.ts";
import type { ImportedPage } from "../contract.ts";

/** One navigation entry as the config writes it. */
interface Entry {
  readonly text: string;
  readonly link?: string;
  readonly items?: readonly Entry[];
}

/** The generated navigation text, or the reasons it needs a person. */
export interface NavConversion {
  /** Absent when the config declares no navigation, or declares one this reader cannot parse. */
  readonly contents?: string;
  readonly diagnostics: readonly Diagnostic[];
}

/** A scheme (`https:`, `mailto:`), a protocol-relative URL, or a fragment stays as written. */
const EXTERNAL = /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i;

/** Whitespace and JavaScript comments, which may sit between any two tokens. */
function skip(text: string, at: number): number {
  let index = at;
  for (;;) {
    while (/\s/.test(text.charAt(index))) index++;
    if (text.startsWith("//", index)) {
      const newline = text.indexOf("\n", index);
      index = newline === -1 ? text.length : newline + 1;
    } else if (text.startsWith("/*", index)) {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 2;
    } else {
      return index;
    }
  }
}

/** A quoted string literal and the offset after it. */
function quotedAt(text: string, at: number): { readonly value: string; readonly end: number } | undefined {
  const quote = text.charAt(at);
  if (quote !== '"' && quote !== "'" && quote !== "`") return undefined;
  let value = "";
  let index = at + 1;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char === "\\") {
      const next = text.charAt(index + 1);
      value += next === "n" ? "\n" : next === "t" ? "\t" : next === "r" ? "\r" : next;
      index += 2;
      continue;
    }
    if (char === quote) return { value, end: index + 1 };
    if (quote === "`" && char === "$" && text.charAt(index + 1) === "{") return undefined;
    value += char;
    index++;
  }
  return undefined;
}

/** Any literal value; a call or an identifier is skipped and reads as undefined. */
function valueAt(text: string, at: number): { readonly value: unknown; readonly end: number } | undefined {
  const start = skip(text, at);
  if (text.charAt(start) === "{") return objectAt(text, start);
  if (text.charAt(start) === "[") return arrayAt(text, start);
  const string = quotedAt(text, start);
  if (string !== undefined) return string;
  let index = start;
  let depth = 0;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char === "(" || char === "[" || char === "{") depth++;
    else if (char === ")" || char === "]" || char === "}") {
      if (depth === 0) break;
      depth--;
    } else if (char === "," && depth === 0) break;
    index++;
  }
  return index === start ? undefined : { value: undefined, end: index };
}

/** An object literal's own keys and values; a shorthand property or a spread reads as no value. */
function objectAt(text: string, at: number): { readonly value: Record<string, unknown>; readonly end: number } | undefined {
  let index = skip(text, at + 1);
  const value: Record<string, unknown> = {};
  while (index < text.length && text.charAt(index) !== "}") {
    let key: string;
    const quoted = quotedAt(text, index);
    if (quoted !== undefined) {
      key = quoted.value;
      index = quoted.end;
    } else {
      const name = /^[A-Za-z_$][\w$]*/.exec(text.slice(index));
      if (name === null) return undefined;
      key = name[0];
      index += key.length;
    }
    index = skip(text, index);
    if (text.charAt(index) !== ":") return undefined;
    const parsed = valueAt(text, index + 1);
    if (parsed === undefined) return undefined;
    value[key] = parsed.value;
    index = skip(text, parsed.end);
    if (text.charAt(index) === ",") index = skip(text, index + 1);
    else if (text.charAt(index) !== "}") return undefined;
  }
  return text.charAt(index) === "}" ? { value, end: index + 1 } : undefined;
}

/** An array literal's values; a hole or spread reads as no value. */
function arrayAt(text: string, at: number): { readonly value: unknown[]; readonly end: number } | undefined {
  let index = skip(text, at + 1);
  const value: unknown[] = [];
  while (index < text.length && text.charAt(index) !== "]") {
    const parsed = valueAt(text, index);
    if (parsed === undefined) return undefined;
    value.push(parsed.value);
    index = skip(text, parsed.end);
    if (text.charAt(index) === ",") index = skip(text, index + 1);
    else if (text.charAt(index) !== "]") return undefined;
  }
  return text.charAt(index) === "]" ? { value, end: index + 1 } : undefined;
}

/** The `nav` value in the config's `themeConfig`, and whether a `nav` key was written at all. */
function navArray(config: string): { readonly found: boolean; readonly entries?: readonly unknown[] } {
  const theme = /\bthemeConfig\s*:/.exec(config);
  const from = theme?.index ?? 0;
  const match = /\bnav\s*:/.exec(config.slice(from));
  if (match === null) return { found: false };
  const at = skip(config, from + match.index + match[0].length);
  if (config.charAt(at) !== "[") return { found: true };
  const parsed = arrayAt(config, at);
  return parsed === undefined ? { found: true } : { found: true, entries: parsed.value };
}

/** A written entry as a navigation entry; `undefined` when it is not an object with literal text. */
function entryOf(value: unknown): Entry | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.text !== "string" || record.text.trim() === "") return undefined;
  const children = Array.isArray(record.items)
    ? record.items.map(entryOf).filter((child): child is Entry => child !== undefined)
    : undefined;
  return {
    text: record.text,
    ...(typeof record.link === "string" ? { link: record.link } : {}),
    ...(children === undefined ? {} : { items: children }),
  };
}

/** One output entry: a link or a group, the shape `navFromYaml` reads. */
type NavOut = { readonly title: string; readonly url: string } | { readonly title: string; readonly children: readonly NavOut[] };

/** The destination URL of an internal link, or `undefined` when it names no imported page. */
function pageUrl(link: string, prefix: string, urls: ReadonlyMap<string, string>): string | undefined {
  const at = link.search(/[?#]/);
  const path = at === -1 ? link : link.slice(0, at);
  const tail = at === -1 ? "" : link.slice(at);
  const relative = path.replace(/^\/+/, "");
  if (relative === "") {
    const home = urls.get(`${prefix}index.md`);
    return home === undefined ? undefined : `${home}${tail}`;
  }
  const candidates = /\.(?:md|markdown|html?)$/i.test(relative)
    ? [relative]
    : relative.endsWith("/")
      ? [`${relative}index.md`]
      : [`${relative}.md`, `${relative}/index.md`];
  for (const candidate of candidates) {
    const url = urls.get(`${prefix}${candidate}`);
    if (url !== undefined) return `${url}${tail}`;
  }
  return undefined;
}

/** Turns the written entries into output entries, reporting each one that cannot be converted. */
function converted(
  entries: readonly Entry[],
  prefix: string,
  urls: ReadonlyMap<string, string>,
  report: (message: string) => void,
): NavOut[] {
  const out: NavOut[] = [];
  for (const entry of entries) {
    if (entry.items !== undefined) {
      const children = converted(entry.items, prefix, urls, report);
      if (children.length === 0) {
        report(`navigation group \`${entry.text}\` has no entries this reader can convert; it is not migrated.`);
        continue;
      }
      out.push({ title: entry.text, children });
      continue;
    }
    if (entry.link === undefined) {
      report(`navigation entry \`${entry.text}\` has no \`link\` or \`items\`; it is not migrated.`);
      continue;
    }
    out.push({ title: entry.text, url: EXTERNAL.test(entry.link) ? entry.link : (pageUrl(entry.link, prefix, urls) ?? entry.link) });
  }
  return out;
}

/**
 * Converts the navigation of one config file. `prefix` is the source path of the content root, with a trailing `/`,
 * so an internal link names the same file the importer read. Every problem is a warning at the config file: the rest
 * of the navigation still migrates.
 */
export function convertNav(
  config: string,
  file: string,
  pages: readonly ImportedPage[],
  prefix: string,
): NavConversion {
  const nav = navArray(config);
  if (!nav.found) return { diagnostics: [] };
  const diagnostics: Diagnostic[] = [];
  const report = (message: string): void => {
    diagnostics.push({
      id: "import.nav",
      severity: "warning",
      message,
      pos: { file, line: 1, column: 1, endLine: 1, endColumn: 1 },
    });
  };
  if (nav.entries === undefined) {
    report("`themeConfig.nav` is not an array literal this reader can convert; convert it by hand.");
    return { diagnostics };
  }

  const urls = new Map(pages.map((page) => [page.source, permalink(page.destination)]));
  const entries = nav.entries.map(entryOf).filter((entry): entry is Entry => entry !== undefined);
  if (entries.length !== nav.entries.length) report("a navigation entry is not an object literal with a `text`; it is not migrated.");
  const items = converted(entries, prefix, urls, report);
  if (items.length === 0) return { diagnostics };
  return { contents: stringify({ main: items }), diagnostics };
}
