import type { Page, Site } from "../contracts/content.ts";
import { SOCIAL_HEIGHT, SOCIAL_WIDTH, templateNameFor } from "./template.ts";

/** Folder under the output folder where the images land. */
export const IMAGE_FOLDER = "assets/social";

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Where a page's social image is written, relative to the output folder, or `undefined` for a page with none. The
 * name is a pure function of the page's URL, so the head can point at the file before the file is made, and two pages
 * can never share one.
 */
export function socialImageFile(site: Site, page: Page): string | undefined {
  if (page.kind === "asset" || templateNameFor(site.config, page).name === undefined) return undefined;
  // A page that names its own image keeps it; drawing another would write a file nothing points at.
  const own = page.frontMatter.image;
  if (typeof own === "string" && own.trim() !== "") return undefined;
  const base = site.config.base;
  let path = page.url;
  if (base !== "" && (path === base || path.startsWith(`${base}/`))) path = path.slice(base.length);
  const segments = path
    .split(/[?#]/)[0]!
    .split("/")
    .map(decode)
    .filter((segment) => segment !== "" && segment !== "." && segment !== "..");
  const name = segments.length === 0 ? "index" : segments.join("/");
  return `${IMAGE_FOLDER}/${name}.png`;
}

/** The URL path of the page's social image, including `base`, or `undefined` for a page with none. */
export function socialImagePath(site: Site, page: Page): string | undefined {
  const file = socialImageFile(site, page);
  if (file === undefined) return undefined;
  const encoded = file.split("/").map(encodeURIComponent).join("/");
  return `${site.config.base}/${encoded}`;
}

/** The size the head declares for a generated image. */
export const SOCIAL_IMAGE_SIZE = { width: SOCIAL_WIDTH, height: SOCIAL_HEIGHT } as const;
