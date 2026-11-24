/**
 * Propose a stable URL, block id, and navigation placement for one gap, and reject URL or identifier conflicts
 * before anything is written (#1413).
 *
 * The rules are fixed so a reviewer can predict them: a page type names the URL root, the surface item's name becomes
 * one lowercase kebab segment, the block id is the same segment, and the page goes under the same group in the `docs`
 * list. A conflict is a URL a page already publishes, a block id the site already records, a navigation URL that is
 * already present, or a missing parent group in a non-empty list. Every conflict is named, never silently replaced.
 */
import type { NavGroup, NavItem, NavLink, Site } from "../contracts/index.ts";
import type { Page } from "../contracts/content.ts";
import type {
  AuthoringConflict,
  AuthoringLocation,
  AuthoringPageType,
  AuthoringSurfaceItem,
} from "../contracts/authoring.ts";

/** The URL root each page type uses. */
export const PAGE_TYPE_ROOT: Readonly<Record<AuthoringPageType, string>> = {
  reference: "reference",
  guide: "guide",
  example: "examples",
  runbook: "runbooks",
};

/** The navigation group each page type proposes. */
export const PAGE_TYPE_GROUP: Readonly<Record<AuthoringPageType, string>> = {
  reference: "Reference",
  guide: "Guides",
  example: "Examples",
  runbook: "Runbooks",
};

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A lowercase kebab segment: camelCase splits, non-alphanumerics become one dash, at most 64 characters. */
export function slugSegment(name: string): string {
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, "$1-$2");
  const slug = spaced
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  const bounded = slug.length === 0 ? "page" : slug.slice(0, 64).replace(/-+$/g, "");
  return bounded === "" ? "page" : bounded;
}

/** The site base without a trailing slash, or `""`. */
function baseOf(site: Site): string {
  const base = site.config.base.replace(/\/+$/g, "");
  return base === "/" ? "" : base;
}

/** A URL without the site base, with one trailing slash. */
export function urlWithoutBase(url: string, site: Site): string {
  const base = baseOf(site);
  let value = url;
  if (base !== "" && (value === base || value.startsWith(`${base}/`))) value = value.slice(base.length);
  if (value === "") value = "/";
  if (!value.startsWith("/")) value = `/${value}`;
  return value.endsWith("/") ? value : `${value}/`;
}

/** The source folder documentation pages live in, without `./` or a trailing slash. */
function docsFolder(site: Site): string {
  const folder = site.config.surface?.docs?.[0] ?? ".";
  const clean = folder.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/g, "");
  return clean === "." ? "" : clean;
}

/** The source path a URL root and segment would use. */
function sourceOf(site: Site, root: string, segment: string): string {
  const docs = docsFolder(site);
  return [docs, root, `${segment}.md`].filter((part) => part !== "").join("/");
}

/** Every link of a navigation tree, flattened in document order. */
export function navLinks(items: readonly NavItem[], parent?: string): { readonly link: NavLink; readonly parent?: string }[] {
  const out: { readonly link: NavLink; readonly parent?: string }[] = [];
  for (const item of items) {
    if ("children" in item) {
      const group = item as NavGroup;
      out.push(...navLinks(group.children, group.title));
    } else {
      out.push({ link: item as NavLink, ...(parent === undefined ? {} : { parent }) });
    }
  }
  return out;
}

/** The last link under one parent group, so a proposal follows its siblings. */
function lastSibling(site: Site, group: string): string | undefined {
  const links = navLinks(site.nav.docs ?? []).filter((entry) => entry.parent === group);
  return links.length === 0 ? undefined : links[links.length - 1]!.link.title;
}

/** The proposed location for one gap. */
export function proposeLocation(item: AuthoringSurfaceItem, pageType: AuthoringPageType, site: Site): AuthoringLocation {
  const segment = slugSegment(item.name);
  const root = PAGE_TYPE_ROOT[pageType];
  const group = PAGE_TYPE_GROUP[pageType];
  const after = lastSibling(site, group);
  return {
    url: `/${root}/${segment}/`,
    source: sourceOf(site, root, segment),
    block: segment,
    nav: {
      list: "docs",
      title: item.name,
      parent: group,
      ...(after === undefined ? {} : { after }),
    },
  };
}

/** Every page URL without the site base. */
function pageUrls(site: Site): Set<string> {
  return new Set(site.pages.map((page) => urlWithoutBase(page.url, site)));
}

/** The block ids a page model records, whether declared by a block or a heading anchor. */
function pageBlockIds(page: Page): string[] {
  const ids = new Set<string>();
  for (const block of page.blocks ?? []) ids.add(block.id);
  for (const heading of page.headings) if (heading.id !== "") ids.add(heading.id);
  return [...ids];
}

/** A map of the locations already proposed in one run, keyed `kind\0value`. */
export type TakenLocations = Map<string, string>;

/** A fresh set of locations already proposed. */
export function takenLocations(): TakenLocations {
  return new Map();
}

/** True when the navigation list is present and holds at least one entry. */
function listExists(site: Site, list: string): boolean {
  const items = site.nav[list];
  return Array.isArray(items) && items.length > 0;
}

/** True when a group title exists at the top level of a list. */
function groupExists(site: Site, list: string, group: string): boolean {
  return (site.nav[list] ?? []).some((item) => "children" in item && item.title === group);
}

/**
 * Every conflict the proposed location has with the site and with earlier proposals in the same run. A conflict is
 * reported once per kind and value, and a location without conflicts is safe to write.
 */
export function locationConflicts(
  location: AuthoringLocation,
  site: Site,
  taken: TakenLocations = takenLocations(),
): readonly AuthoringConflict[] {
  const conflicts: AuthoringConflict[] = [];
  const add = (kind: AuthoringConflict["kind"], value: string, message: string): void => {
    if (conflicts.some((entry) => entry.kind === kind && entry.value === value)) return;
    conflicts.push({ kind, value, message });
  };

  const url = urlWithoutBase(location.url, site);
  if (pageUrls(site).has(url)) {
    add("slug", location.url, `The URL \`${location.url}\` already belongs to a page.`);
  }
  const slugKey = `slug\0${url}`;
  const slugOwner = taken.get(slugKey);
  if (slugOwner !== undefined) {
    add("slug", location.url, `The URL \`${location.url}\` is also proposed for \`${slugOwner}\`.`);
  }

  const blockIds = new Set(site.pages.flatMap((page) => pageBlockIds(page)));
  if (blockIds.has(location.block)) {
    add("block", location.block, `The block id \`${location.block}\` is already recorded by a page.`);
  }
  const blockKey = `block\0${location.block}`;
  const blockOwner = taken.get(blockKey);
  if (blockOwner !== undefined) {
    add("block", location.block, `The block id \`${location.block}\` is also proposed for \`${blockOwner}\`.`);
  }

  const links = navLinks(site.nav[location.nav.list] ?? []);
  if (links.some((entry) => urlWithoutBase(entry.link.url, site) === url)) {
    add("nav", location.nav.title, `The navigation already links \`${location.nav.title}\` to \`${location.url}\`.`);
  }
  if (
    location.nav.parent !== undefined &&
    listExists(site, location.nav.list) &&
    !groupExists(site, location.nav.list, location.nav.parent)
  ) {
    add("nav", location.nav.title, `The navigation has no group \`${location.nav.parent}\` in \`${location.nav.list}\`.`);
  }
  const sibling = links.find(
    (entry) =>
      entry.parent === location.nav.parent &&
      entry.link.title === location.nav.title &&
      urlWithoutBase(entry.link.url, site) !== url,
  );
  if (sibling !== undefined) {
    add("nav", location.nav.title, `The group \`${location.nav.parent ?? location.nav.list}\` already has an entry titled \`${location.nav.title}\`.`);
  }
  const navKey = `nav\0${location.nav.list}\0${location.nav.parent ?? ""}\0${location.nav.title}`;
  const navOwner = taken.get(navKey);
  if (navOwner !== undefined) {
    add("nav", location.nav.title, `The navigation placement is also proposed for \`${navOwner}\`.`);
  }

  return conflicts.sort((a, b) => byCodePoint(a.kind, b.kind) || byCodePoint(a.value, b.value));
}

/** Record one accepted location, so a later proposal in the same run sees it. */
export function takeLocation(location: AuthoringLocation, item: string, taken: TakenLocations): void {
  const url = location.url.endsWith("/") ? location.url : `${location.url}/`;
  taken.set(`slug\0${url}`, item);
  taken.set(`block\0${location.block}`, item);
  taken.set(`nav\0${location.nav.list}\0${location.nav.parent ?? ""}\0${location.nav.title}`, item);
}
