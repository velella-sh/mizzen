import type { Direction, SiteConfig } from "./config.ts";
import type { Collection, ListProps, PageRecord } from "./data.ts";
import type { NavTree } from "./nav.ts";
import type { SiteNetwork } from "./network.ts";
import type { SourcePos } from "./source.ts";

/** What a page is: Markdown or HTML content (`doc`), a page with its own program (`app`), or a file copied as is (`asset`). */
export type PageKind = "doc" | "app" | "asset";

/** The `status` front matter values the engine checks. */
export type PageStatus = "experimental" | "beta" | "deprecated" | "proposed" | "accepted" | "rejected" | "superseded";

/** Instructions for agents that edit a page. */
export interface AgentInstructions {
  /** `false` for a generated page that must be changed at its source. */
  readonly edit?: boolean;
  /** The file to edit instead of this page. */
  readonly source?: string;
  /** A short instruction for the agent. */
  readonly notes?: string;
}

/** A page's front matter. The keys the engine reads are typed; every other key is kept and passed to the layout. */
export interface FrontMatter {
  /** Page title. */
  readonly title?: string;
  /** Meta description, `llms.txt` entry, and search excerpt. */
  readonly description?: string;
  /** Name of the theme layout that renders the page. */
  readonly layout?: string;
  /** Output URL, a path starting with `/`. */
  readonly permalink?: string;
  /** Old paths that redirect to this page. */
  readonly redirect_from?: string | readonly string[];
  /** A path or URL this page redirects to. */
  readonly redirect_to?: string;
  /** Page language, a BCP 47 tag. */
  readonly lang?: string;
  /** Text direction. */
  readonly dir?: Direction;
  /** Sort order among siblings in navigation built from folders. */
  readonly order?: number;
  /** Lifecycle status, checked by the engine and shown by the theme. */
  readonly status?: PageStatus;
  /** Instructions for agents editing this page. */
  readonly agent?: AgentInstructions;
  /** `false` keeps the page out of the search index. */
  readonly search?: boolean;
  /** `false` keeps the page out of the build. */
  readonly published?: boolean;
  /** The page's social image. */
  readonly image?: string;
  /** Links translations of the same page. */
  readonly translation_key?: string;
  /** Any other key, kept for the layout. */
  readonly [key: string]: unknown;
}

/** A heading in a page, for the table of contents and anchor links. */
export interface Heading {
  /** Level, 1 to 6. */
  readonly depth: 1 | 2 | 3 | 4 | 5 | 6;
  /** The `id` of the heading element, unique within the page. */
  readonly id: string;
  /** The heading's plain text. */
  readonly text: string;
  /** Where the heading starts in the source. */
  readonly pos: SourcePos;
}

/** One covered file that differs from a page's review lock. */
export interface PageStaleFile {
  /** Path relative to `stale.root`, with `/` separators. */
  readonly path: string;
  /** What happened to the file since the last review. */
  readonly change: "changed" | "removed" | "added";
}

/** A page whose covered files changed since it was last marked as reviewed. */
export interface PageStale {
  /** `YYYY-MM-DD` of the last review; absent when the page was never marked. */
  readonly reviewed?: string;
  /** The files that differ, sorted by path. */
  readonly files: readonly PageStaleFile[];
}

/** One page of the site model. */
export interface Page {
  /** Output URL including `base`, such as `/evergreen/guide/install/`. */
  readonly url: string;
  /** Where the page's content starts in its source file. */
  readonly source: SourcePos;
  /** Front matter after `defaults` are applied. */
  readonly frontMatter: FrontMatter;
  /** Page title: from front matter, else the first `h1`, else the file name. */
  readonly title: string;
  /** Page language, a BCP 47 tag. */
  readonly lang: string;
  /** Text direction. */
  readonly dir: Direction;
  /** Headings in document order. */
  readonly headings: readonly Heading[];
  /** The rendered body, with `data-source` on every block. */
  readonly html: string;
  /** The Markdown body without front matter, as the page's Markdown twin is written. */
  readonly markdown: string;
  /** What kind of page this is. */
  readonly kind: PageKind;
  /** The record this page was built from, when it is a record page. */
  readonly record?: PageRecord;
  /** The records, groups, and pagination of a list page; unset on every other page. */
  readonly list?: ListProps;
  /**
   * True when the page reads a date value, a derived value, or a date filter, so the as-of date is part of its render key.
   * A page that sets none keeps its bytes and its hash when the as-of date moves.
   */
  readonly dates?: boolean;
  /**
   * The covered files that changed since the page was last reviewed; unset on a page without `covers` and on one whose
   * files are current. Read from the review lock and the files as they are, never from git.
   */
  readonly stale?: PageStale;
  /**
   * URL of the page this copy repeats, when version routing wrote one source at two URLs; unset on the copy that owns the
   * canonical URL and on every page of a site without version settings.
   */
  readonly aliasOf?: string;
}

/** A record the URL lock published that its collection no longer holds. */
export interface RemovedRecord {
  /** The collection's name. */
  readonly collection: string;
  /** The record's id. */
  readonly id: string;
  /** Every URL the record published: its last one and the earlier ones. */
  readonly urls: readonly string[];
  /** Where readers go instead, from `onRemoved`; absent for the removed notice. */
  readonly target?: string;
}

/** A record its collection's lifecycle retires, whose page is replaced by a redirect to the record that replaced it. */
export interface RetiredRecord {
  /** The collection's name. */
  readonly collection: string;
  /** The record's id. */
  readonly id: string;
  /** Every URL the retired page published, its last one first; each redirects to `target`. */
  readonly urls: readonly string[];
  /** The current URL of the record that replaces it. */
  readonly target: string;
}

/**
 * How a preview build treats search engines: every page is `noindex`, and its canonical points at the preview's URL
 * rather than the production site's. Front matter `canonical_url` still wins.
 */
export interface PreviewPolicy {
  /** The absolute URL a page's canonical starts with: this base followed by the page's own URL. */
  readonly canonicalBase: string;
  /** The commit this preview was built from, from `--commit` or `GITHUB_SHA`; absent when unknown. */
  readonly commit?: string;
}

/** The site model: everything a build knows, assembled once and read by rendering and outputs. */
export interface Site {
  /** The site config. */
  readonly config: SiteConfig;
  /** Every page, sorted by URL. */
  readonly pages: readonly Page[];
  /** The navigation lists. */
  readonly nav: NavTree;
  /** Files from `_data/`, keyed by file name without extension. */
  readonly data: Readonly<Record<string, unknown>>;
  /** Data collections, keyed by name; empty when the config declares none. */
  readonly collections: Readonly<Record<string, Collection>>;
  /** Records the URL lock published that their collections no longer hold, in lock order. */
  readonly removed?: readonly RemovedRecord[];
  /** Records the lifecycle retires whose URLs redirect to their replacement, in model order. */
  readonly retired?: readonly RetiredRecord[];
  /** The shared network, from the locked file; unset for a site that has no `network` key. */
  readonly network?: SiteNetwork;
  /** The preview policy, from `--preview-canonical` and `--commit`; unset for a normal build. */
  readonly preview?: PreviewPolicy;
}
