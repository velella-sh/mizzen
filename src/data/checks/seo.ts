/**
 * SEO checks for record pages: a title or description that is too long or empty, and pages that share one.
 *
 * The title and description of a record page come from its template's front matter, filled from the record, so they
 * are checked on the finished pages. Every finding is a warning: text is never shortened or changed here. A finding
 * covers a group of pages and names up to {@link LISTED} URLs and the count of the rest, so a collection of thousands
 * of records gives a handful of findings, not thousands. Pages are compared within one language only.
 */
import type { Diagnostic, Page, SiteConfig } from "../../contracts/index.ts";

/** The longest title Mizzen accepts without a warning, until `collections.<name>.seo.titleMax` says otherwise. */
export const TITLE_MAX = 70;
/** The longest description Mizzen accepts without a warning, until `collections.<name>.seo.descriptionMax` says otherwise. */
export const DESCRIPTION_MAX = 160;
/** How many URLs one finding names before it counts the rest. */
export const LISTED = 5;

/** The text of a front matter value, trimmed, or `""` when it is not text. */
function textOf(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  return "";
}

/** Length in characters (code points), so an emoji or an accented letter written as two units counts once. */
function lengthOf(text: string): number {
  return [...text].length;
}

/** `url1, url2 and 3 more`, with at most {@link LISTED} URLs named. */
function named(pages: readonly Page[]): string {
  const urls = pages.slice(0, LISTED).map((page) => page.url);
  const rest = pages.length - urls.length;
  return rest > 0 ? `${urls.join(", ")} and ${rest} more` : urls.join(", ");
}

function noun(count: number): string {
  return count === 1 ? "record page" : "record pages";
}

/** The record pages a check reads: every main page of a record in every language, not its views. Views share the record's text. */
function recordPages(pages: readonly Page[]): Page[] {
  return pages.filter((page) => page.record !== undefined && page.record.view === undefined);
}

/**
 * Checks the record pages of the site and returns the findings, ordered by collection, language, and kind.
 *
 * - `data.seo-title-long` and `data.seo-description-long`: over `seo.titleMax` (default 70) or `seo.descriptionMax`
 *   (default 160) characters.
 * - `data.seo-title-empty` and `data.seo-description-empty`: no text once the template is filled. A title falls back to
 *   the first heading, so the warning means the page sets none of its own. A collection without a `seo` key is
 *   reported only for a value that is present and blank; one with a `seo` key is reported for a missing value too.
 * - `data.seo-duplicate-title` and `data.seo-duplicate-description`: two or more pages of one language share the text.
 */
export function checkSeo(pages: readonly Page[], collections: SiteConfig["collections"]): Diagnostic[] {
  const found: Diagnostic[] = [];
  const records = recordPages(pages);

  // Limits and empties, one finding per collection, language, and kind.
  const groups = new Map<string, { collection: string; lang: string; pages: Page[] }>();
  for (const page of records) {
    const key = `${page.record!.collection}\u0000${page.lang}`;
    const group = groups.get(key) ?? { collection: page.record!.collection, lang: page.lang, pages: [] };
    group.pages.push(page);
    groups.set(key, group);
  }
  for (const { collection, lang, pages: members } of groups.values()) {
    const seo = collections[collection]?.seo;
    const titleMax = seo?.titleMax ?? TITLE_MAX;
    const descriptionMax = seo?.descriptionMax ?? DESCRIPTION_MAX;
    const where = `of "${collection}" (${lang})`;
    const report = (id: string, subset: readonly Page[], what: string, help: string): void => {
      if (subset.length === 0) return;
      found.push({
        id,
        severity: "warning",
        message: `${subset.length} ${noun(subset.length)} ${where} ${what}: ${named(subset)}.`,
        pos: subset[0]!.source,
        help,
      });
    };
    const titleOf = (page: Page): string => textOf(page.frontMatter.title);
    const descriptionOf = (page: Page): string => textOf(page.frontMatter.description);
    // A collection that sets `seo` cares about its tags, so a missing title or description counts as empty for it; any
    // other collection is reported only for a value that is present and blank.
    const strict = seo !== undefined;
    const emptyIn = (key: "title" | "description") => (page: Page): boolean => {
      const raw = page.frontMatter[key];
      return raw === undefined ? strict : textOf(raw) === "";
    };

    report(
      "data.seo-title-empty",
      members.filter(emptyIn("title")),
      "set no title",
      "Add `title: \"{field}\"` to the template's front matter, naming a field that has text.",
    );
    report(
      "data.seo-title-long",
      members.filter((page) => lengthOf(titleOf(page)) > titleMax),
      `have a title over ${titleMax} characters`,
      "Shorten the field the title is built from, or raise `collections.<name>.seo.titleMax`.",
    );
    report(
      "data.seo-description-empty",
      members.filter(emptyIn("description")),
      "set no description",
      "Add `description: \"{field}\"` to the template's front matter, naming a field that has text.",
    );
    report(
      "data.seo-description-long",
      members.filter((page) => lengthOf(descriptionOf(page)) > descriptionMax),
      `have a description over ${descriptionMax} characters`,
      "Shorten the field the description is built from, or raise `collections.<name>.seo.descriptionMax`.",
    );
  }

  // Duplicates, within one language, across the record pages of every collection.
  const byLang = new Map<string, Page[]>();
  for (const page of records) byLang.set(page.lang, [...(byLang.get(page.lang) ?? []), page]);
  for (const [lang, members] of [...byLang].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    for (const [kind, id, read] of [
      ["title", "data.seo-duplicate-title", (page: Page) => textOf(page.frontMatter.title)],
      ["description", "data.seo-duplicate-description", (page: Page) => textOf(page.frontMatter.description)],
    ] as const) {
      const sharing = new Map<string, Page[]>();
      for (const page of members) {
        const text = read(page);
        if (text !== "") sharing.set(text, [...(sharing.get(text) ?? []), page]);
      }
      for (const [text, same] of sharing) {
        if (same.length < 2) continue;
        found.push({
          id,
          severity: "warning",
          message: `${same.length} record pages (${lang}) share the ${kind} "${text}": ${named(same)}.`,
          pos: same[0]!.source,
          help: `Give each page its own ${kind}: add a field that tells the records apart to the template's \`${kind}\`.`,
        });
      }
    }
  }
  return found;
}
