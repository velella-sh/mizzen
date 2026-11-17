/**
 * The blog feed: an Atom 1.0 file beside the archive, built from the routes `buildBlogRoutes` planned.
 *
 * The archive fixes which posts are public and in what order, so the feed copies it instead of sorting again: a draft
 * has no archive entry and cannot reach the feed. Post dates are calendar dates at UTC midnight, never the build clock.
 */
import type { BlogRoute } from "../content/blog/routes.ts";
import type { OutputFile } from "../contracts/output.ts";
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
