import type { Page, Site } from "../contracts/content.ts";
import type { MetaTag } from "../contracts/render.ts";
import type { Output, OutputContext, OutputFile } from "../contracts/output.ts";

/**
 * Search engine verification. Each provider the site sets gets its own tag and file, and a provider it did not set
 * gets nothing. The values are checked against the provider's format by `schema/config.schema.json`.
 */

/** The meta tags for the home page: Google's `google-site-verification` and Bing's `msvalidate.01`. */
export function verificationMeta(site: Site, page: Page): MetaTag[] {
  if (page.url !== `${site.config.base}/`) return [];
  const verify = site.config.verify;
  if (verify === undefined) return [];
  const tags: MetaTag[] = [];
  if (verify.google !== undefined) tags.push({ name: "google-site-verification", content: verify.google });
  if (verify.bing !== undefined) tags.push({ name: "msvalidate.01", content: verify.bing });
  return tags;
}

/** Writes the verification files a provider asks for at the root of the output folder, sorted by path. */
export const verification: Output = {
  name: "verification",
  async run(site: Site, _ctx: OutputContext): Promise<readonly OutputFile[]> {
    const verify = site.config.verify;
    if (verify === undefined) return [];
    const files: OutputFile[] = [];
    if (verify.bingFile !== undefined) {
      files.push({
        path: "BingSiteAuth.xml",
        contents: `<?xml version="1.0"?>\n<users>\n  <user>${verify.bingFile}</user>\n</users>\n`,
      });
    }
    if (verify.googleFile !== undefined) {
      files.push({ path: verify.googleFile, contents: `google-site-verification: ${verify.googleFile}\n` });
    }
    return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  },
};
