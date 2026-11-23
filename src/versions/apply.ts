/**
 * Applies the version dispositions to the model's pages: a release that owns the canonical URL is written at both the
 * canonical and its versioned URL, an old release keeps its versioned URL, and current docs are dropped while a release
 * is default. The versioned copy, when it is not the canonical one, carries `canonical_url`.
 */
import type { Diagnostic, Page } from "../contracts/index.ts";
import { resolveVersionRouting } from "./routing.ts";

/** The routed page list, with each canonical alias marked in front matter. */
export interface AppliedVersionRouting {
  readonly pages: readonly Page[];
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * True for a page written at a URL that only repeats another page's content: version routing set {@link Page.aliasOf}.
 * The sitemap lists one URL per page, so it skips these copies.
 */
export function isVersionAlias(page: Page): boolean {
  return page.aliasOf !== undefined;
}

/** Routes `pages` with the parsed `_data/versions.yml` value. A missing value changes nothing, so a site without the
 * file keeps every page at its own URL. */
export function applyVersionRouting(pages: readonly Page[], versions: unknown, base: string): AppliedVersionRouting {
  if (versions === undefined) return { pages, diagnostics: [] };
  // A check report is a site-wide archive with fixed URLs outside the docs version tree.
  const routing = resolveVersionRouting(pages.filter(({ reportView }) => reportView === undefined), versions, { base });
  const routed = pages.filter(({ reportView }) => reportView !== undefined);
  for (const route of routing.routes) {
    for (const url of route.urls) {
      const alias = route.canonical !== null && url !== route.canonical;
      routed.push(
        alias
          ? {
              ...route.page,
              url,
              aliasOf: route.canonical,
              frontMatter: { ...route.page.frontMatter, canonical_url: route.canonical },
            }
          : { ...route.page, url },
      );
    }
  }
  routed.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  return { pages: routed, diagnostics: [...routing.diagnostics] };
}
