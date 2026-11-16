import { resolve } from "node:path";
import type { Page, Site } from "../contracts/content.ts";
import type { Output, OutputContext, OutputFile } from "../contracts/output.ts";
import { loadFonts, missingCharacters } from "../social/fonts.ts";
import { socialImageFile } from "../social/image-path.ts";
import { drawImages, type ImageResult } from "../social/batch.ts";
import { ImageCache, imageKey } from "../social/cache.ts";
import { loadTemplate, templateNameFor, type SocialTemplate } from "../social/template.ts";

/**
 * Writes one 1200 by 630 PNG per page under `assets/social/`, drawn from the SVG template the site names in
 * `social.template` (or the page in its `social` front matter) with the page's title, description, and site name. The
 * head points at these files (`src/outputs/head-meta.ts`), so a shared link shows a picture that belongs to the page.
 *
 * The output draws nothing without `social` in the config. It reads only the template and the fonts the site declares,
 * so the bytes do not depend on the machine (`docs/adr/social-images.md`).
 */
export const name = "social-images";

/** A page's description as the head prints it: its own, else the site's on the home page. */
function descriptionOf(site: Site, page: Page): string {
  const own = page.frontMatter.description;
  if (typeof own === "string" && own.trim() !== "") return own.trim();
  const home = page.url === `${site.config.base}/`;
  return home ? (site.config.description ?? "") : "";
}

/** The text of each slot field for one page. */
function valuesOf(site: Site, page: Page, fields: readonly string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of fields) {
    const own = page.frontMatter[field];
    if (field === "site") values[field] = site.config.title;
    else if (field === "title") values[field] = page.title;
    else if (field === "description") values[field] = descriptionOf(site, page);
    else if (typeof own === "string") values[field] = own;
  }
  return values;
}

export const socialImages: Output = {
  name,
  async run(site: Site, ctx: OutputContext): Promise<readonly OutputFile[]> {
    const config = site.config.social;
    const build = ctx.build;
    if (config === undefined || build === undefined) return [];
    const sourceDir = resolve(build.root, site.config.source);

    const fonts = await loadFonts(build.root, config.fonts);
    for (const diagnostic of fonts.diagnostics) ctx.report(diagnostic);

    const templates = new Map<string, SocialTemplate | undefined>();
    const jobs: { page: Page; file: string; template: SocialTemplate }[] = [];
    for (const page of site.pages) {
      const choice = templateNameFor(site.config, page);
      if (choice.invalid !== undefined) {
        ctx.report({
          id: "social.template-invalid",
          severity: "error",
          message: choice.invalid,
          pos: page.source,
          help: "Name a template that is a file in `_templates/social/`, or set `social: false` to draw no image.",
        });
        continue;
      }
      const file = socialImageFile(site, page);
      if (choice.name === undefined || file === undefined) continue;
      if (!templates.has(choice.name)) {
        const loaded = await loadTemplate(build.root, sourceDir, choice.name);
        if (loaded.ok) templates.set(choice.name, loaded.template);
        else {
          templates.set(choice.name, undefined);
          for (const diagnostic of loaded.diagnostics) ctx.report(diagnostic);
        }
      }
      const template = templates.get(choice.name);
      if (template !== undefined) jobs.push({ page, file, template });
    }
    if (jobs.length === 0) return [];

    const cache = build.cacheDir === undefined ? undefined : new ImageCache(build.cacheDir);
    const prepared = jobs.map(({ page, file, template }) => {
      const values = valuesOf(site, page, template.slots.map((slot) => slot.field));
      return { page, file, template, values, key: imageKey(template.hash, fonts.key, values) };
    });

    // Reuse what an earlier build drew from the same template, fonts, and text; draw only the rest.
    const results = new Map<string, ImageResult>();
    const todo: typeof prepared = [];
    for (const item of prepared) {
      if (results.has(item.key) || todo.some((t) => t.key === item.key)) continue;
      const hit = await cache?.get(item.key);
      if (hit === undefined) todo.push(item);
      else results.set(item.key, hit);
    }
    const reused = results.size;
    const drawn = await drawImages(
      {
        fonts: fonts.fonts.map((font) => ({ bytes: font.bytes, family: font.family })),
        templates: Object.fromEntries([...templates].filter((entry): entry is [string, SocialTemplate] => entry[1] !== undefined)),
      },
      todo.map((item) => ({ template: item.template.name, values: item.values })),
      build.workers,
    );
    for (const [index, item] of todo.entries()) {
      const result = drawn.results[index]!;
      results.set(item.key, result);
      await cache?.set(item.key, result);
    }
    if (drawn.fellBack > 0) {
      ctx.report({
        id: "social.worker-failed",
        severity: "warning",
        message: `A worker thread failed, so ${String(drawn.fellBack)} social image${drawn.fellBack === 1 ? " was" : "s were"} drawn in the main thread instead. The images are the same.`,
      });
    }
    ctx.report({
      id: "social.images",
      severity: "info",
      message: `Social images: ${String(todo.length)} drawn, ${String(reused)} reused from the cache${prepared.length > todo.length + reused ? `, ${String(prepared.length - todo.length - reused)} shared by pages with the same text` : ""}.`,
    });

    const files: OutputFile[] = [];
    for (const { page, file, values, key } of prepared) {
      const missing = missingCharacters(fonts.fonts, Object.values(values).join(" "));
      if (missing.length > 0) {
        ctx.report({
          id: "social.missing-glyph",
          severity: "warning",
          message: `The social image of ${page.url} needs ${missing.length === 1 ? "a character" : "characters"} that no declared font draws: ${missing.map((c) => `"${c}"`).join(", ")}.`,
          pos: page.source,
          help: "Add a font that covers them to `social.fonts`; the image shows a blank box until you do.",
        });
      }
      const { png, outcomes } = results.get(key)!;
      for (const outcome of outcomes.filter((o) => o.truncated)) {
        ctx.report({
          id: "social.truncated",
          severity: "info",
          message: `The ${outcome.field} of the social image of ${page.url} was too long and ends with an ellipsis.`,
          pos: page.source,
          help: "Shorten the text, or give the template slot more room or more lines.",
        });
      }
      files.push({ path: file, contents: png });
    }
    return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  },
};
