import type { Page, Site } from "./content.ts";
import type { ListProps, RecordProps } from "./data.ts";
import type { Pager, Trail } from "./nav.ts";

/** What a theme's component returns; the render host turns it into HTML. The engine does not look inside it. */
export type RenderNode = unknown;

/** A `<meta>` tag. */
export interface MetaTag {
  /** The `name` attribute, or `property` for Open Graph tags. */
  readonly name: string;
  /** The `content` attribute. */
  readonly content: string;
  /** Use `property` instead of `name`. */
  readonly property?: boolean;
}

/** A `<link>` tag. */
export interface LinkTag {
  /** The `rel` attribute. */
  readonly rel: string;
  /** The `href` attribute. */
  readonly href: string;
  /** Any other attributes, such as `hreflang`. */
  readonly attrs?: Readonly<Record<string, string>>;
}

/** A deferred `<script src>` tag. A theme prints it as `<script defer src="…">` with the attributes sorted by name. */
export interface ScriptTag {
  /** The `src` attribute: an absolute `https` URL. */
  readonly src: string;
  /** Any other attributes, such as `data-domain`. */
  readonly attrs?: Readonly<Record<string, string>>;
}

/**
 * What goes in `<head>`: set by the engine (`headMeta`), added to by the layout. The engine owns the description,
 * robots, canonical, Open Graph and Twitter tags, `og:image` (only for a page whose social image is written),
 * JSON-LD, `hreflang`, search, feed and calendar links, and analytics scripts; each appears once, so a layout prints
 * the lists as they are and adds only its own assets.
 */
export interface Head {
  /** The document title: the page's own title; the layout adds the site name if it wants one. */
  readonly title: string;
  /** Meta tags. */
  readonly meta: readonly MetaTag[];
  /** Link tags (canonical, alternates, icons). */
  readonly links: readonly LinkTag[];
  /** JSON-LD objects, written as `application/ld+json` scripts. */
  readonly jsonLd: readonly Readonly<Record<string, unknown>>[];
  /** Deferred scripts, such as the site's analytics tag. Absent or empty when the page loads none. */
  readonly scripts?: readonly ScriptTag[];
}

/** A client script for one component: a plain ES module loaded only on pages that use the component. */
export interface Island {
  /** The island's name, equal to its component's. */
  readonly name: string;
  /** URL of the module including `base`. */
  readonly src: string;
}

/**
 * Requests a layout makes of the engine while it renders one page. They change only what the engine
 * adds around the page's own HTML, never the layout's output.
 */
export interface RenderHints {
  /**
   * Leaves the shipped `font-display: optional` faces of `family` out of this page's preload links.
   * A theme calls it when the page loads its own family in place of a shipped one: the shipped face is
   * still declared in the stylesheet and stays a fallback, but a reader does not download it before
   * the page needs it. The name compares without case, and an empty name is ignored.
   */
  skipFontPreload(family: string): void;
}

/**
 * Renders the component `name` through the site's registry, so `theme.overrides.components` apply, and returns its
 * HTML. The component's `style.css` and `client.ts` island join the page's, exactly as if the content had used it. A
 * unit calls this where it would otherwise import another unit, which would skip the override.
 *
 * @param name The component's folder name under `components/`. An unknown name is a `render.unknown-component`
 *   warning and renders as an empty string.
 * @param props The component's `props`; default none.
 * @param html The component's `html` body, already rendered; default empty.
 */
export type RenderComponent = (name: string, props?: Readonly<Record<string, unknown>>, html?: string) => string;

/** Props of a layout, which renders one whole page. */
export interface LayoutProps {
  /** The whole site model. */
  readonly site: Site;
  /** The page being rendered. */
  readonly page: Page;
  /** The page's breadcrumb. */
  readonly trail: Trail;
  /** The page's previous and next pages. */
  readonly pager: Pager;
  /** The head, to be rendered or extended. */
  readonly head: Head;
  /** Islands the page uses, to be loaded at the end of the body. */
  readonly islands: readonly Island[];
  /** Requests to the engine for this page, such as skipping a replaced font's preload. */
  readonly hints?: RenderHints;
  /** The record of a record page; unset on every other page. */
  readonly record?: RecordProps;
  /** The records, groups, and pagination of a list page; unset on every other page. */
  readonly list?: ListProps;
  /** Renders a component by name; see {@link RenderComponent}. */
  readonly renderComponent: RenderComponent;
}

/** Props of a chrome part (header, sidebar, footer, table of contents), which the layout places. */
export interface ChromeProps {
  /** The whole site model. */
  readonly site: Site;
  /** The page being rendered. */
  readonly page: Page;
  /** The page's breadcrumb. */
  readonly trail: Trail;
  /** The page's previous and next pages. */
  readonly pager: Pager;
}

/** Props of a component used inside page content, with the props the content gave it. */
export interface ComponentProps<P extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>> {
  /** The attributes written on the component in the Markdown. */
  readonly props: P;
  /** The page it appears in. */
  readonly page: Page;
  /** The whole site model. */
  readonly site: Site;
  /** The component's body, already rendered to HTML. */
  readonly html: string;
  /** Renders another component by name through the site's registry; see {@link RenderComponent}. */
  readonly renderComponent: RenderComponent;
}

/** A layout unit: the default export of `layouts/<name>.ts`. */
export type Layout = (props: LayoutProps) => RenderNode;

/** A chrome unit: the default export of `chrome/<name>/index.ts`. */
export type Chrome = (props: ChromeProps) => RenderNode;

/** A component unit: the default export of `components/<name>/index.ts`. */
export type Component<P extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>> = (props: ComponentProps<P>) => RenderNode;
