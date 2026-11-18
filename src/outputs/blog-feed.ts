/**
 * The blog feed: an Atom 1.0 file beside the archive, built from the routes `buildBlogRoutes` planned.
 *
 * The archive fixes which posts are public and in what order, so the feed copies it instead of sorting again: a draft
 * has no archive entry and cannot reach the feed. Post dates are calendar dates at UTC midnight, never the build clock.
 */
import type { BlogPost, BlogRoute } from "../content/blog/routes.ts";
import type { Site } from "../contracts/content.ts";
import type { Output, OutputFile } from "../contracts/output.ts";
import { atomFeed } from "../feeds/atom.ts";
import { originOf } from "../feeds/model.ts";

/** What the feed needs: the planned routes and the site's identity. */
export interface BlogFeedOptions {
  /** The routes `buildBlogRoutes` planned; the archive supplies the public posts and their order. */
  readonly routes: readonly BlogRoute[];
  /** Site `url`; without a valid one the feed has no absolute links and is not written. */
  readonly url?: string;
  /** Site `base`, which public URLs carry and the output path does not. */
  readonly base?: string;
  /** Site title. */
  readonly title: string;
  /** Site language tag. Default `en`. */
  readonly language?: string;
}

/**
 * Writes `<route>/feed.xml`: one entry per public post, newest first as the archive lists them, each with an absolute
 * link. A site without a valid `url`, or a blog with no public post, writes no file, since Atom has no date to publish.
 */
export function blogFeed(options: BlogFeedOptions): readonly OutputFile[] {
  const origin = originOf(options.url);
  if (origin === undefined) return [];
  const archive = options.routes.find((route): route is Extract<BlogRoute, { kind: "archive" }> => route.kind === "archive");
  if (archive === undefined || archive.posts.length === 0) return [];

  const folder = archive.url.replace(/[^/]+\/$/, "");
  const base = (options.base ?? "").replace(/\/+$/, "");
  const path = (base !== "" && folder.startsWith(`${base}/`) ? folder.slice(base.length) : folder).replace(/^\/+/, "");
  const self = new URL(`${folder}feed.xml`, origin).href;

  const xml = atomFeed({
    id: self,
    title: options.title,
    self,
    home: new URL(folder, origin).href,
    language: options.language ?? "en",
    author: options.title,
    entries: archive.posts.map((post) => ({
      id: new URL(post.url, origin).href,
      title: post.title,
      link: new URL(post.url, origin).href,
      date: new Date(`${post.date}T00:00:00.000Z`),
      ...(post.description === undefined ? {} : { summary: post.description }),
    })),
  });

  return [{ path: `${path}feed.xml`, contents: xml }];
}

/** True for a complete post as the archive carries it; the front matter value is unknown, so every field is checked. */
function isPost(value: unknown): value is BlogPost {
  if (typeof value !== "object" || value === null) return false;
  const post = value as Record<string, unknown>;
  return typeof post.file === "string" && typeof post.title === "string" && typeof post.date === "string" &&
    typeof post.author === "string" && typeof post.slug === "string" && typeof post.url === "string";
}

/** The archive page `buildBlogPages` made, with the posts it lists, or `undefined` when the site has none. */
function archiveOf(site: Site): { readonly url: string; readonly posts: readonly BlogPost[] } | undefined {
  for (const page of site.pages) {
    const blog: unknown = page.frontMatter.blog;
    if (typeof blog !== "object" || blog === null || Array.isArray(blog)) continue;
    const value = blog as Record<string, unknown>;
    if (value.kind !== "archive" || !Array.isArray(value.posts)) continue;
    return { url: page.url, posts: value.posts.filter(isPost) };
  }
  return undefined;
}

/** Writes the blog's Atom feed beside the archive, when the config turns the blog on and asks for it. */
export const blogFeedOutput: Output = {
  name: "blog-feed",
  async run(site: Site): Promise<readonly OutputFile[]> {
    if (site.config.blog === undefined || site.config.blog.feed === false) return [];
    const archive = archiveOf(site);
    if (archive === undefined) return [];
    return blogFeed({
      routes: [{ kind: "archive", url: archive.url, posts: archive.posts }],
      ...(site.config.url === undefined ? {} : { url: site.config.url }),
      base: site.config.base,
      title: site.config.title,
      language: site.config.lang,
    });
  },
};
