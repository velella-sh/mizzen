import type { Page } from "../contracts/content.ts";

/** The layout name that builds a view for embedding in another page; it never carries a script. */
export const EMBEDDED_LAYOUT = "embedded";

/** What decides whether a page is public in a network; a site outside a network is public. */
export interface SkipContext {
  /** `false` for a page of a project that is not public in the network. Default `true`. */
  readonly projectPublic?: boolean;
}

/**
 * True when a page carries no analytics script: its front matter says `analytics: false`, it is built with the
 * embedded layout, or its project is not public in a network. The decision reads front matter and the layout name,
 * never the page's URL.
 */
export function skipsAnalytics(page: Page, context: SkipContext = {}): boolean {
  if (page.frontMatter.analytics === false) return true;
  if (page.frontMatter.layout === EMBEDDED_LAYOUT) return true;
  return context.projectPublic === false;
}
