/**
 * Blog listing pages: the archive and one page per author, as ordinary `list`-layout pages whose `blog` front matter
 * carries the posts. The routes come from {@link buildBlogRoutes}, so nothing here reads a file or the clock.
 */
import type { Page, SiteConfig, SourcePos } from "../../contracts/index.ts";
import { directionFromLang } from "../lang.ts";
import type { BlogRoute } from "./routes.ts";

/** A synthetic page's source: the config line a generated page points at. */
const CONFIG_POS: SourcePos = { file: "mizzen.yml", line: 1, column: 1, endLine: 1, endColumn: 1 };

/** Options of {@link buildBlogPages}. */
export interface BlogPagesOptions {
  /** The planned routes, from {@link buildBlogRoutes}. */
  readonly routes: readonly BlogRoute[];
  /** The site config; the pages take their language from it. */
  readonly config: SiteConfig;
}

/** The archive and author pages of the planned routes, in the routes' deterministic order. */
export function buildBlogPages(options: BlogPagesOptions): Page[] {
  const { config } = options;
  const pages: Page[] = [];
  for (const route of options.routes) {
    if (route.kind === "post") continue;
    const title = route.kind === "archive" ? "Archive" : route.author.name;
    const count = route.posts.length;
    const noun = count === 1 ? "post" : "posts";
    const description = route.kind === "archive" ? `All ${count} ${noun}.` : `${count} ${noun} by ${route.author.name}.`;
    pages.push({
      url: route.url,
      source: CONFIG_POS,
      frontMatter: {
        title,
        description,
        layout: "list",
        blog: route.kind === "archive"
          ? { kind: "archive", posts: route.posts }
          : { kind: "author", author: route.author, posts: route.posts },
      },
      title,
      lang: config.lang,
      dir: directionFromLang(config.lang),
      headings: [],
      html: "",
      markdown: "",
      kind: "doc",
    });
  }
  return pages;
}
