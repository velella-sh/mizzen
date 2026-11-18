/**
 * Converts a VitePress config's navigation to Mizzen's: `themeConfig.nav` becomes the `main` list, `themeConfig.sidebar`
 * becomes the `docs` list, and each locale's `themeConfig` becomes `main_<lang>` and `docs_<lang>`. Everything is read
 * as text and never executed: an entry must be an object literal whose `text`, `link`, and `items` values are literals.
 * `text` becomes `title`, `link` becomes `url`, and `items` becomes `children`, in the order written. An internal link
 * to an imported page is rewritten to that page's destination URL; an external URL is copied unchanged.
 *
 * A VitePress sidebar object selects entries by path prefix. Mizzen keeps one sidebar per language, so every prefix's
 * entries become one group, titled by the section's index page when it has one.
 */
import { stringify } from "yaml";
import type { Diagnostic } from "../../contracts/index.ts";
import { permalink } from "../../content/permalink.ts";
import type { ImportedPage } from "../contract.ts";
import { arrayAt, literalObject, skip } from "./literal.ts";

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

/** The `nav` value in the config's `themeConfig`, and whether a `nav` key was written at all. */
function navArray(config: string): { readonly found: boolean; readonly entries?: readonly unknown[] } {
  const theme = /\bthemeConfig\s*:/.exec(config);
  const from = theme?.index ?? 0;
  const match = /\bnav\s*:/.exec(config.slice(from));
  if (match === null) return { found: false };
  const at = skip(config, from + match.index + match[0].length);
  if (config.charAt(at) !== "[") return { found: true };
  const entries = arrayAt(config, at)?.value;
  return { found: true, ...(entries === undefined ? {} : { entries }) };
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
function pageUrl(link: string, prefix: string, urls: ReadonlyMap<string, string>, base: string): string | undefined {
  const at = link.search(/[?#]/);
  const written = at === -1 ? link : link.slice(0, at);
  const tail = at === -1 ? "" : link.slice(at);
  const path = base !== "" && (written === base || written.startsWith(`${base}/`)) ? written.slice(base.length) : written;
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
  base: string,
): NavOut[] {
  const out: NavOut[] = [];
  for (const entry of entries) {
    if (entry.items !== undefined) {
      const children = converted(entry.items, prefix, urls, report, base);
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
    out.push({ title: entry.text, url: EXTERNAL.test(entry.link) ? entry.link : (pageUrl(entry.link, prefix, urls, base) ?? entry.link) });
  }
  return out;
}

/** The `title` front matter value of a page, or `undefined` when it writes none. */
function pageTitle(page: ImportedPage | undefined): string | undefined {
  if (page === undefined) return undefined;
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(page.contents);
  const title = block === null ? null : /^title\s*:\s*(.+?)\s*$/m.exec(block[1] ?? "");
  return title === null ? undefined : (title[1] ?? "").replace(/^(["'])(.*)\1$/, "$2");
}

/** A sidebar section's title: its index page's title, else its last path segment. */
function sectionTitle(section: string, prefix: string, pages: readonly ImportedPage[]): string {
  const key = section.replace(/^\/+|\/+$/g, "");
  const candidates = key === "" ? [`${prefix}index.md`] : [`${prefix}${key}/index.md`, `${prefix}${key}.md`];
  for (const source of candidates) {
    const title = pageTitle(pages.find((page) => page.source === source));
    if (title !== undefined) return title;
  }
  const last = key.split("/").filter((part) => part !== "").at(-1);
  return last === undefined ? "Home" : last.replace(/[-_]+/g, " ");
}

/** A list of literal entries, a VitePress sidebar section by path prefix, or nothing this reader can convert. */
function sidebarOf(
  value: unknown,
  prefix: string,
  pages: readonly ImportedPage[],
  urls: ReadonlyMap<string, string>,
  report: (message: string) => void,
  base: string,
): NavOut[] {
  if (Array.isArray(value)) return converted(entriesOf(value, report), prefix, urls, report, base);
  if (typeof value === "object" && value !== null) {
    const groups: NavOut[] = [];
    for (const [section, entries] of Object.entries(value as Record<string, unknown>)) {
      if (!Array.isArray(entries)) {
        report(`sidebar section \`${section}\` is not an array literal; it is not migrated.`);
        continue;
      }
      const children = converted(entriesOf(entries, report), prefix, urls, report, base)
        .flatMap((entry) => ("children" in entry ? entry.children : [entry]));
      if (children.length > 0) groups.push({ title: sectionTitle(section, prefix, pages), children });
    }
    return groups;
  }
  report("`themeConfig.sidebar` is not a literal this reader can convert; convert it by hand.");
  return [];
}

/** Array entries as navigation entries, reporting how many were not literals. */
function entriesOf(values: readonly unknown[], report: (message: string) => void): Entry[] {
  const entries = values.map(entryOf).filter((entry): entry is Entry => entry !== undefined);
  if (entries.length !== values.length) report("a navigation entry is not an object literal with a `text`; it is not migrated.");
  return entries;
}

/** The `themeConfig` object of a locale, preferring `locales.root` for the default language. */
function themeOf(config: Record<string, unknown>, key: string | undefined): Record<string, unknown> | undefined {
  const locales = config.locales;
  const locale = typeof locales === "object" && locales !== null && key !== undefined ? (locales as Record<string, unknown>)[key] : undefined;
  const fromLocale = typeof locale === "object" && locale !== null ? (locale as Record<string, unknown>).themeConfig : undefined;
  const theme = fromLocale ?? config.themeConfig;
  return typeof theme === "object" && theme !== null && !Array.isArray(theme) ? (theme as Record<string, unknown>) : undefined;
}

/** Every locale the config declares, in the order written, with `root` first. */
function localesOf(config: Record<string, unknown>): { readonly key: string; readonly value: Record<string, unknown> }[] {
  const locales = config.locales;
  if (typeof locales !== "object" || locales === null || Array.isArray(locales)) return [];
  return Object.entries(locales as Record<string, unknown>)
    .filter((entry): entry is [string, Record<string, unknown>] => typeof entry[1] === "object" && entry[1] !== null && !Array.isArray(entry[1]))
    .map(([key, value]) => ({ key, value }));
}

/** The suffix `navFromYaml` accepts for a language list: its two- or three-letter primary subtag. */
function langSuffix(code: string): string | undefined {
  const primary = code.split("-", 1)[0]?.toLowerCase() ?? "";
  return /^[a-z]{2,3}$/.test(primary) ? primary : undefined;
}

/**
 * Converts the navigation of one config file. `prefix` is the source path of the content root, with a trailing `/`,
 * so an internal link names the same file the importer read. `base` is the site base, so a link written with it still
 * names a page. Every problem is a warning at the config file: the rest of the navigation still migrates.
 */
export function convertNav(
  config: string,
  file: string,
  pages: readonly ImportedPage[],
  prefix: string,
  base = "",
): NavConversion {
  const diagnostics: Diagnostic[] = [];
  const report = (message: string): void => {
    diagnostics.push({
      id: "import.nav",
      severity: "warning",
      message,
      pos: { file, line: 1, column: 1, endLine: 1, endColumn: 1 },
    });
  };
  const parsed = literalObject(config);

  const urls = new Map(pages.map((page) => [page.source, permalink(page.destination)]));
  const lists: Record<string, NavOut[]> = {};
  const add = (name: string, values: unknown, sidebar: boolean): void => {
    if (values === undefined) return;
    const items = sidebar
      ? sidebarOf(values, prefix, pages, urls, report, base)
      : Array.isArray(values)
        ? converted(entriesOf(values, report), prefix, urls, report, base)
        : (report("`themeConfig.nav` is not an array literal this reader can convert; convert it by hand."), []);
    if (items.length > 0) lists[name] = items;
  };

  if (parsed === undefined) {
    const nav = navArray(config);
    if (nav.entries === undefined) {
      if (nav.found) report("`themeConfig.nav` is not an array literal this reader can convert; convert it by hand.");
    } else add("main", nav.entries, false);
  } else {
    const root = themeOf(parsed, "root");
    // A key the reader saw but could not read is reported, so a nav of identifiers is not silently dropped.
    const unreadable = (theme: Record<string, unknown> | undefined, key: string): void => {
      if (theme === undefined || !(key in theme) || theme[key] !== undefined) return;
      report(`\`themeConfig.${key}\` is not an array literal this reader can convert; convert it by hand.`);
    };
    unreadable(root, "nav");
    unreadable(root, "sidebar");
    add("main", root?.nav, false);
    add("docs", root?.sidebar, true);
    for (const locale of localesOf(parsed)) {
      if (locale.key === "root") continue;
      const code = typeof locale.value.lang === "string" && locale.value.lang.trim() !== "" ? locale.value.lang : locale.key;
      const suffix = langSuffix(code);
      if (suffix === undefined) {
        report(`locale \`${locale.key}\` has language \`${code}\`, which has no two- or three-letter list suffix; its navigation is not migrated.`);
        continue;
      }
      const theme = themeOf(parsed, locale.key);
      add(`main_${suffix}`, theme?.nav, false);
      add(`docs_${suffix}`, theme?.sidebar, true);
    }
  }

  if (Object.keys(lists).length === 0) return { diagnostics };
  return { contents: stringify(lists), diagnostics };
}
