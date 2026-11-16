import type { Site } from "../contracts/content.ts";
import { originOf, providerOrigins } from "./providers.ts";

const TAG = /<(script|img|source|link|iframe|video|audio|embed)\b[^>]*>/gi;
const ATTR = /\b(?:src|href|poster|data)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const SRCSET = /\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const CSS_URL = /url\(\s*(["']?)((?:https?:)?\/\/[^)"']+)\1\s*\)/gi;

/** The origin of an address found in a page: absolute, or protocol-relative (taken as `https`); else `undefined`. */
function addressOrigin(address: string): string | undefined {
  const url = address.trim().startsWith("//") ? `https:${address.trim()}` : address.trim();
  return /^https?:\/\//i.test(url) ? originOf(url) : undefined;
}

/** Every outside origin one page body loads scripts, styles, fonts, images or media from, in order of appearance. */
export function pageOrigins(html: string): string[] {
  const found: string[] = [];
  for (const tag of html.matchAll(TAG)) {
    for (const attr of tag[0].matchAll(ATTR)) found.push(attr[1] ?? attr[2] ?? "");
    for (const set of tag[0].matchAll(SRCSET)) {
      for (const candidate of (set[1] ?? set[2] ?? "").split(",")) found.push(candidate.trim().split(/\s+/)[0] ?? "");
    }
  }
  for (const css of html.matchAll(CSS_URL)) found.push(css[2] ?? "");
  return found.flatMap((address) => {
    const origin = addressOrigin(address);
    return origin === undefined ? [] : [origin];
  });
}

/**
 * Every outside origin the site contacts: those its pages load from, and the analytics tool's. The site's own origin
 * (`url`) is not outside. Sorted by code point, without repeats.
 */
export function siteOrigins(site: Site): readonly string[] {
  const own = site.config.url === undefined ? undefined : originOf(site.config.url);
  const all = new Set<string>();
  for (const page of site.pages) for (const origin of pageOrigins(page.html)) all.add(origin);
  if (site.config.analytics !== undefined) for (const origin of providerOrigins(site.config.analytics)) all.add(origin);
  if (own !== undefined) all.delete(own);
  return [...all].sort();
}

/** The origins the site does not allow: outside `analytics.allowedOrigins` and not the analytics tool's own. */
export function unlistedOrigins(site: Site, origins: readonly string[] = siteOrigins(site)): readonly string[] {
  const analytics = site.config.analytics;
  if (analytics === undefined) return [];
  const allowed = new Set<string>([...(analytics.allowedOrigins ?? []).map((o) => originOf(o) ?? o), ...providerOrigins(analytics)]);
  return origins.filter((origin) => !allowed.has(origin));
}
