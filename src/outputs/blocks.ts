/**
 * `blocks.json`: every stable block id on the site, with the page URL, source file, and source line it names.
 *
 * The ids are the ones `blocks.lock.json` holds, so an external tool can cite a block without knowing the page's URL or
 * reading its source. Canonical JSON with sorted keys and one trailing line feed; a site with no block ids writes no
 * file, exactly as it writes no lock.
 */
import type { Site } from "../contracts/content.ts";
import type { Output, OutputFile } from "../contracts/output.ts";
import { canonicalJson } from "../data/lock.ts";

/** The file's name, relative to the output folder. */
const FILE = "blocks.json";

export const blocks: Output = {
  name: "blocks",
  async run(site: Site): Promise<readonly OutputFile[]> {
    const mapped: Record<string, { url: string; file: string; line: number }> = {};
    for (const page of site.pages) {
      for (const block of page.blocks ?? []) {
        mapped[block.id] = { url: page.url, file: page.source.file, line: block.pos.line };
      }
    }
    if (Object.keys(mapped).length === 0) return [];
    return [{ path: FILE, contents: `${canonicalJson({ version: 1, blocks: mapped })}\n` }];
  },
};
