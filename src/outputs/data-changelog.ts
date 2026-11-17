/**
 * The `data-changelog` output: the Atom feed beside the changelog pages a collection's `changelog.pages` builds.
 *
 * The entries are the same events the pages list, identified by the event id, newest first. A collection with no
 * history, or a site without a valid `url`, writes no file.
 */
import type { Site } from "../contracts/content.ts";
import type { Output, OutputContext, OutputFile } from "../contracts/output.ts";
import { changelogFeeds, hasChangelogHistory } from "../data/changes/preset.ts";
import { originOf } from "../feeds/model.ts";

/** The `data-changelog` output: one Atom feed per collection that shows its history. */
export const dataChangelog: Output = {
  name: "data-changelog",
  async run(site: Site, ctx: OutputContext): Promise<readonly OutputFile[]> {
    if (site.config.outputs["data-changelog"] === false) return [];
    if (originOf(site.config.url) === undefined) {
      if (hasChangelogHistory(site)) {
        ctx.report({
          id: "data-changelog.no-url",
          severity: "warning",
          message: "A collection builds changelog pages, but the site has no valid `url`, so the Atom feed carries no absolute links.",
          help: "Set `url: https://example.com` in the site config.",
        });
      }
      return [];
    }
    return changelogFeeds(site);
  },
};
