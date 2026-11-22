import { resolve } from "node:path";
import type { Site } from "../contracts/content.ts";
import { socialImageFile } from "./image-path.ts";
import { loadTemplate, templateNameFor } from "./template.ts";

/**
 * The URLs of the pages whose generated social image the `social-images` output will write, so a page's head names an
 * image only when its file exists. A page is in the set when the output is on, the site has `social`, the page is not
 * opted out and names no image of its own, and its template loads. It reads the templates and reports nothing: the
 * output itself reports a template that is missing or invalid.
 *
 * @param site The site model.
 * @param root Absolute site root.
 */
export async function plannedSocialImages(site: Site, root: string): Promise<ReadonlySet<string>> {
  const urls = new Set<string>();
  if (site.config.social === undefined || site.config.outputs["social-images"] === false) return urls;
  const sourceDir = resolve(root, site.config.source);
  const loaded = new Map<string, boolean>();
  for (const page of site.pages) {
    const choice = templateNameFor(site.config, page);
    if (choice.name === undefined || choice.invalid !== undefined || socialImageFile(site, page) === undefined) continue;
    let ok = loaded.get(choice.name);
    if (ok === undefined) {
      ok = (await loadTemplate(root, sourceDir, choice.name)).ok;
      loaded.set(choice.name, ok);
    }
    if (ok) urls.add(page.url);
  }
  return urls;
}
