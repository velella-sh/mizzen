/**
 * The `feeds` output: one Atom, RSS 2.0, or JSON Feed file per feed the site config declares.
 *
 * Which records a feed lists is decided in `../feeds/entries.ts`, which the head links share. The feed's `updated` date
 * is its newest entry's date, never the clock, so two builds of the same data write the same bytes.
 *
 * Every link is absolute, because a feed reader has no page to resolve a relative one against: a site with feeds but no
 * valid `url` writes none and reports it once. A feed with no entry writes no file, since Atom has no date to publish.
 */
import type { Site } from "../contracts/index.ts";
import type { Output, OutputContext, OutputFile } from "../contracts/output.ts";
import { atomFeed } from "../feeds/atom.ts";
import { byCodePoint, feedEntries } from "../feeds/entries.ts";
import { feedFile } from "../feeds/files.ts";
import { entryId } from "../feeds/id.ts";
import { jsonFeed } from "../feeds/json-feed.ts";
import { originOf } from "../feeds/model.ts";
import { rssFeed } from "../feeds/rss.ts";

/** Writes the declared feeds, sorted by path. */
export const feeds: Output = {
  name: "feeds",
  async run(site: Site, ctx: OutputContext): Promise<readonly OutputFile[]> {
    const names = Object.keys(site.config.feeds);
    if (names.length === 0) return [];

    const origin = originOf(site.config.url);
    if (origin === undefined) {
      ctx.report({
        id: "feeds.no-url",
        severity: "warning",
        message: "The site declares feeds, but has no valid `url`, so no feed can carry absolute links.",
        help: "Set `url: https://example.com` in the site config.",
      });
      return [];
    }

    const base = site.config.base.replace(/\/+$/, "");
    const home = `${origin}${base}/`;
    const files: OutputFile[] = [];
    for (const name of names) {
      const feed = site.config.feeds[name]!;
      const entries = feedEntries(site, feed, origin, (diagnostic) => ctx.report(diagnostic));
      if (entries.length === 0) continue;

      const title = feed.title ?? site.config.title;
      const id = entryId(origin, "feeds", name);
      for (const format of feed.formats ?? ["atom"]) {
        const self = `${origin}${base}/${feedFile(name, format)}`;
        const model = {
          id,
          title,
          self,
          home,
          language: site.config.lang,
          author: site.config.title,
          ...(site.config.description === undefined ? {} : { description: site.config.description }),
          entries,
        };
        files.push({
          path: feedFile(name, format),
          contents: format === "rss" ? rssFeed(model) : format === "json" ? jsonFeed(model) : atomFeed(model),
        });
      }
    }

    return files.sort((a, b) => byCodePoint(a.path, b.path));
  },
};
