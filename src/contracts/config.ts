/** Text direction of a page or site. */
export type Direction = "ltr" | "rtl";

/** One language of a multi-language site, in switcher order. */
export interface LanguageConfig {
  /** BCP 47 tag, such as `fa`. */
  readonly code: string;
  /** Name shown in the language switcher, in that language. */
  readonly name: string;
  /** URL prefix of this language's pages, such as `/fa`; empty for the default language. */
  readonly prefix: string;
}

/** Front matter applied to every page under a folder, unless the page sets the key itself. */
export interface DefaultsEntry {
  /** Folder relative to `source`; `""` for every page. */
  readonly path: string;
  /** Front matter keys and values to apply. */
  readonly values: Readonly<Record<string, unknown>>;
}

/** Where the source lives, for "Edit this page" links and the "Edit with your agent" prompt. */
export interface RepositoryConfig {
  /** The repository's web URL, such as `https://github.com/arminazimi/evergreen`. */
  readonly url: string;
  /** Branch that edit links point to. Default `main`. */
  readonly branch?: string;
  /** The site root's folder inside the repository, such as `docs`. Default `""`. */
  readonly dir?: string;
}

/** Which theme builds the site and the options handed to it. */
export interface ThemeConfig {
  /** Theme package or folder. Default: the theme that ships with the engine. */
  readonly name?: string;
  /** Passed to the theme unread; the theme validates it against its own schema. */
  readonly options?: Readonly<Record<string, unknown>>;
}

/** Search settings. */
export interface SearchConfig {
  /** The most characters of a page's body the index keeps. Default `300`; titles and headings are always indexed. */
  readonly text?: number;
}

/** Limits on one collection's source. Each key falls back to the default stated in `docs/data-sites.md`. */
export interface DataLimitsConfig {
  /** Largest source file, in bytes. Default 2097152 (2 MiB). */
  readonly bytes?: number;
  /** Largest number of records. Default 10000. */
  readonly records?: number;
  /** Largest value of one field, in characters. Default 100000. */
  readonly field?: number;
}

/** One extra rendering of every record page of a collection. */
export interface CollectionViewConfig {
  /** Markdown template under `_templates/`, relative to the source folder. */
  readonly template: string;
  /** URL pattern of a view page, such as `/items/{id}/print/`. */
  readonly permalink: string;
  /** Layout of a view page. Default: the view template's `layout`, else `record`. */
  readonly layout?: string;
}

/** How a collection's record pages take part in search. Every key is optional; unset means the default below. */
export interface CollectionSearchConfig {
  /** Fields written as result metadata under the field's own name. Default `[]`. */
  readonly meta?: readonly string[];
  /** Fields a reader can filter by; a list field gives one filter value per item. Default `[]`. */
  readonly filters?: readonly string[];
  /** Fields results can be ordered by: dates, numbers, or short text. Default `[]`. */
  readonly sort?: readonly string[];
  /** Field that holds other names of a record, indexed so a search for one finds the page. */
  readonly aliases?: string;
}

/** How a collection's record and list pages are described to search engines. Every key is optional. */
export interface CollectionSeoConfig {
  /** Longest title a record page may have before a warning. Default 70. */
  readonly titleMax?: number;
  /** Longest description a record page may have before a warning. Default 160. */
  readonly descriptionMax?: number;
  /** Field that holds a record's own canonical URL; front matter `canonical_url` still wins. */
  readonly canonical?: string;
  /** Field that marks a record as not to be indexed: a true value writes `noindex` and leaves the page out of the sitemap. */
  readonly noindex?: string;
  /** Field that holds the date of a record's last change, written as the sitemap's `lastmod`. */
  readonly lastmod?: string;
  /** Structured data of each record page: a mapping with an `@type`, whose string values may name fields as `{field}`. */
  readonly jsonLd?: Readonly<Record<string, unknown>>;
  /** `false` leaves the `BreadcrumbList` off record and list pages. Default `true`. */
  readonly breadcrumbs?: boolean;
  /** `false` leaves the `ItemList` off list pages. Default `true`. */
  readonly itemList?: boolean;
}

/** Which record fields a collection's page JSON publishes. */
export interface CollectionJsonConfig {
  /** Fields the page JSON publishes, in the order given; `[]` publishes none. */
  readonly fields: readonly string[];
}

/** One feed of a collection's records, declared in the site config. */
export interface FeedConfig {
  /** Collection whose records the feed lists. */
  readonly collection: string;
  /** Which records it lists, written like a list page's `where`. Default: every record. */
  readonly where?: Readonly<Record<string, unknown>>;
  /** Record field that holds the entry date; a record without a valid date is left out. */
  readonly date: string;
  /** Largest number of entries. Default `50`. */
  readonly limit?: number;
  /** Feed title. Default: the site title. */
  readonly title?: string;
  /** Formats to write. Default `["atom"]`. */
  readonly formats?: readonly FeedFormat[];
  /** Record field whose value extends the entry id, so a new event of the same record is a new entry. */
  readonly idField?: string;
  /** Record fields written under the JSON Feed extension key. Default `[]`. */
  readonly fields?: readonly string[];
  /** Keeps only entries dated from the as-of date to that date plus `days`, both included. */
  readonly window?: FeedWindowConfig;
}

/** The date range a feed lists, starting at the as-of date and never at the build's clock. */
export interface FeedWindowConfig {
  /** Last day of the window, counted from the as-of date; both ends are included, so `0` is the as-of date alone. */
  readonly days: number;
}

/** One event a calendar builds from each record: a date field, with an optional end field and a title. */
export interface CalendarEventConfig {
  /** Event name, kept in the event id, such as `eol`. Lowercase words joined by hyphens or camel case is fine; unique per calendar. */
  readonly name: string;
  /** Record field that holds the event's date; it must be one of the collection's `dates`. */
  readonly field: string;
  /** Record field that holds the last day of a multi-day event; it must be one of the collection's `dates`. */
  readonly end?: string;
  /** Title template; `{field}` names a record field. Default `{title}`. */
  readonly title?: string;
}

/** One calendar of a collection's records, declared in the site config and written under `calendars/`. */
export interface CalendarConfig {
  /** Collection whose records the calendar lists. */
  readonly collection: string;
  /** Which records it lists, written like a list page's `where`. Default: every record. */
  readonly where?: Readonly<Record<string, unknown>>;
  /** Events built from each record. At least one. */
  readonly events: readonly CalendarEventConfig[];
  /** Reminders before each event as whole days, such as `30d`. Default: none. */
  readonly reminders?: readonly string[];
  /** Record field whose values each get a calendar of their own under `calendars/<name>/`. */
  readonly groupBy?: string;
  /** Largest number of events in one file. Default: no limit. */
  readonly limit?: number;
}

/** A feed file's format. */
export type FeedFormat = "atom" | "rss" | "json";

/** One compact JSON index of a collection's records for the theme's data explorer. */
export interface CollectionIndexConfig {
  /** Fields each row carries, in this order, before the record's URL. */
  readonly fields: readonly string[];
  /** Largest chunk, in bytes of the written JSON. Default `100000`. */
  readonly bytes?: number;
}

/** The raw data a collection publishes beside its pages. */
export interface CollectionRawConfig {
  /** Fields left out of the published JSON and CSV. Default `[]`. */
  readonly private?: readonly string[];
}

/** The event types whose summary text a collection can write. */
export type ChangelogEventType = "added" | "removed" | "changed" | "renamed" | "imported";

/** How a collection's change history is recorded: which fields it follows and how an event reads. */
export interface CollectionChangelogConfig {
  /** Fields whose changes are recorded. Default `[]`: no field is tracked unless it is named. */
  readonly track?: readonly string[];
  /** Fields never recorded, even when `track` names them. Default `[]`. */
  readonly ignore?: readonly string[];
  /** A summary template per event type; `{field}` is replaced by the record's field, plus `{id}`, `{old}`, `{new}`, `{from}`, `{count}`. */
  readonly labels?: Readonly<Partial<Record<ChangelogEventType, string>>>;
  /** A run that finds more events than this is written as one `imported` event. A first load is always one. Default: no limit. */
  readonly importThreshold?: number;
}

/** What a record's disappearance from its collection does. */
export type OnRemovedConfig =
  | "error"
  | "gone"
  | {
      /** A page on the site the removed record's URLs redirect to, such as `/items/`. */
      readonly redirect: string;
    };

/** One data collection: where its records come from, and how its pages are built. */
export interface CollectionConfig {
  /** Data file the records are read from, relative to the site root. */
  readonly source: string;
  /** Field that holds a record's id; the mapping key when absent. */
  readonly id?: string;
  /** Markdown template under `_templates/`, relative to the source folder. */
  readonly template?: string;
  /** URL pattern of a record page, such as `/items/{id}/`. */
  readonly permalink?: string;
  /** Field appended to a record URL when another record's pattern gives the same one, such as `id`. */
  readonly disambiguate?: string;
  /** Field that holds earlier ids or paths of a record, each of which redirects to the record's page. */
  readonly aliases?: string;
  /** JSON Schema file that validates every record, relative to the site root. */
  readonly schema?: string;
  /** Fields whose values must be unique in the collection; a duplicate is an error naming both records. Default `[]`. */
  readonly unique?: readonly string[];
  /** Fields that hold a reference to another collection's record id, keyed by field name. Default `{}`. */
  readonly references?: Readonly<Record<string, string>>;
  /** Fields that hold a date, written `YYYY-MM-DD` or as a full ISO 8601 instant. Default `[]`. */
  readonly dates?: readonly string[];
  /**
   * The date a list compares "before" or "after" against, so no query reads the clock: `YYYY-MM-DD`, or the dot path of
   * a `_data` value that holds one. Unset, a list cannot filter on a relative date.
   */
  readonly referenceDate?: string;
  /** Fields that hold Markdown, rendered through the page pipeline with their positions in the data file. Default `[]`. */
  readonly markdown?: readonly string[];
  /** `false` keeps the collection's record pages out of `llms-full.txt`. Default `true`. */
  readonly llms?: boolean;
  /** Which record fields the page JSON publishes. Default: every field. */
  readonly json?: CollectionJsonConfig;
  /** What an invalid record does: `error` fails the build, `skip` leaves it out of the site with a warning. Default `error`. */
  readonly onInvalid?: "error" | "skip";
  /** What a record that was published and is no longer in the collection does. Default `error` once `urls.lock.json` exists. */
  readonly onRemoved?: OnRemovedConfig;
  /** Limits on this collection's source. */
  readonly limits?: DataLimitsConfig;
  /** Extra named pages built from every record, each with its own template, URL pattern, and layout. Default `{}`. */
  readonly views?: Readonly<Record<string, CollectionViewConfig>>;
  /** How the collection's record pages take part in search. */
  readonly search?: CollectionSearchConfig;
  /** How the collection's record and list pages are described to search engines. */
  readonly seo?: CollectionSeoConfig;
  /** A compact JSON index of the collection's records for the theme, written under `data/`. */
  readonly index?: CollectionIndexConfig;
  /** The raw data published as JSON and CSV with a checksum file; `false` writes none. Default: written, every field. */
  readonly raw?: false | CollectionRawConfig;
  /** The change history of the collection's data, written by `mizzen data changes`. Default: none. */
  readonly changelog?: CollectionChangelogConfig;
}

/** A cookieless analytics tool the site attaches with one script tag. */
export type AnalyticsProvider = "goatcounter" | "plausible" | "umami" | "cloudflare" | "custom";

/** The `analytics` key: which tool, and the one value it needs to tell this site from others. */
export interface AnalyticsConfig {
  /** The tool. There is no default: a site without the key gets no script. */
  readonly provider: AnalyticsProvider;
  /** GoatCounter code, Plausible domain, Umami website id, or Cloudflare beacon token. Required except for `custom`. */
  readonly site?: string;
  /** Origin that serves the script and receives the hits, such as `https://stats.example.com`, for a self-hosted tool. */
  readonly host?: string;
  /** `custom` only: the script's URL, starting `https://`. */
  readonly src?: string;
  /** `custom` only: attributes written on the script tag. */
  readonly attrs?: Readonly<Record<string, string>>;
  /** Outside origins the site may contact; a built page that reaches any other origin earns a warning. Default `[]`. */
  readonly allowedOrigins?: readonly string[];
}

/** The `verify` key: tokens that prove to a search engine that the site is the owner's. A provider not set gets nothing. */
export interface VerifyConfig {
  /** Google Search Console token, written as the `google-site-verification` meta tag on the home page. */
  readonly google?: string;
  /** Bing Webmaster token, written as the `msvalidate.01` meta tag on the home page. */
  readonly bing?: string;
  /** Google's HTML verification file name, such as `google0123456789abcdef.html`, written at the site root. */
  readonly googleFile?: string;
  /** Bing's user id, written as `BingSiteAuth.xml` at the site root. */
  readonly bingFile?: string;
}

/** The `network` key: the shared file of projects this site belongs to, and which project in it this site is. */
export interface NetworkConfig {
  /** The network file's URL or path. Only `mizzen network update` reads it; no default. */
  readonly source: string;
  /** The id of this project in the network file. */
  readonly project: string;
  /** A build warns when the lock is older than this many days. Default `30`. */
  readonly maxAgeDays?: number;
}

/** The `snapshot` key: how old a collection's recorded snapshot may be before `mizzen doctor` reports it. */
/** How dates are written. */
export interface DatesConfig {
  /** The calendar dates are written in: `gregorian` or `jalali`. Default `gregorian`. */
  readonly calendar?: "gregorian" | "jalali";
}

export interface SnapshotConfig {
  /** Report a collection whose snapshot `capturedAt` is more than this many days before the date doctor is given. Default: never. */
  readonly maxAgeDays?: number;
}

/** One collection of the data API: which of its fields are published, and under which key its id is written. */
export interface ApiCollectionConfig {
  /** The record fields the API publishes. A field not listed is never written. */
  readonly fields: readonly string[];
  /** The key the record id is published under in every file. Default `id`. */
  readonly id?: string;
}

/** One further version of the data API, published beside the current one. */
export interface ApiVersionConfig {
  /** The published collections of this version by name, each with its own field list. */
  readonly collections: Readonly<Record<string, ApiCollectionConfig>>;
  /** `true` marks the version deprecated in its index; it needs `sunset` and `successor`. Default `false`. */
  readonly deprecated?: boolean;
  /** The date (`YYYY-MM-DD`) after which the version may be removed, for a deprecated version. */
  readonly sunset?: string;
  /** The version consumers should move to, for a deprecated version. */
  readonly successor?: string;
}

/** The `api` key: the collections published as a versioned static API under `/api/<version>/`. Without the key nothing is written. */
export interface ApiConfig {
  /** The version path segment, such as `v1`. Default `v1`. */
  readonly version: string;
  /** The published collections by name; a collection not named here is never published. */
  readonly collections: Readonly<Record<string, ApiCollectionConfig>>;
  /** `true` writes a `_headers` file with CORS and cache rules for `/api/*`, for hosts that read one. Default `false`. */
  readonly headers?: boolean;
  /** Warn when an API file is larger than this many bytes. A file is never truncated. Default: no limit. */
  readonly maxFileBytes?: number;
  /** Further versions by name (`v1`, `v2`), published beside the current one in `version`. */
  readonly versions?: Readonly<Record<string, ApiVersionConfig>>;
}

/** The `stale` key: how pages that name the files they describe are checked against the review lock. */
export interface StaleConfig {
  /** Folder that a page's `covers` paths are relative to, relative to the site root. Default `.`. */
  readonly root?: string;
  /** How `mizzen check` and `mizzen doctor` report a stale page. Default `warning`; never `error` unless set. */
  readonly severity?: "info" | "warning" | "error";
}

/** The `social` key: generated share images. Without the key no image is written. */
export interface SocialConfig {
  /** Template used by every page that does not name its own: `_templates/social/<template>.svg` in the source folder. */
  readonly template?: string;
  /** Font files the images are drawn with, relative to the site root: `.ttf`, `.otf`, or `.woff`. Default `[]`. */
  readonly fonts: readonly string[];
}

/**
 * The site config: exactly the keys of the site config file, after the loader has checked them.
 * Every key is optional in the file; the loader fills the defaults, so the keys marked required here are always present.
 */
export interface SiteConfig {
  /** Site name for the header, page titles, `llms.txt`, and JSON-LD. Default: the folder name. */
  readonly title: string;
  /** One-sentence summary of the site, for the home page's meta description and `llms.txt`. */
  readonly description?: string;
  /** Scheme and host of the published site, without a trailing slash. Without it canonical links, the sitemap, and social images are relative or left out, with a warning. */
  readonly url?: string;
  /** Path the site lives under, starting with `/` and without a trailing slash; `""` at a domain root. Every URL the engine writes carries it. */
  readonly base: string;
  /** Default language of every page, as a BCP 47 tag. Default `en`. */
  readonly lang: string;
  /** Default text direction. Default: from `lang`. */
  readonly dir: Direction;
  /** The site's languages in switcher order. Default `[]`. */
  readonly languages: readonly LanguageConfig[];
  /** Folder that holds the content, relative to the site root. Default `.`. */
  readonly source: string;
  /** Paths under `source` that discovery would skip but should be copied or built, such as `.well-known`. Default `[]`. */
  readonly include: readonly string[];
  /** Paths under `source` that are neither pages nor copied. Default `[]`. */
  readonly exclude: readonly string[];
  /** Navigation file, relative to the site root. Default `_data/navigation.yml`. */
  readonly navigation: string;
  /** Data collections by name: where their records come from and how their pages are built. Default `{}`. */
  readonly collections: Readonly<Record<string, CollectionConfig>>;
  /** Feeds of collections' records by name: which records, how many, and which formats. Default `{}`. */
  readonly feeds: Readonly<Record<string, FeedConfig>>;
  /** Calendars of collections' dated records by name, written as `.ics` files. Default `{}`. */
  readonly calendars?: Readonly<Record<string, CalendarConfig>>;
  /** Front matter applied by folder; later entries win over earlier ones, and a page always wins. Default `[]`. */
  readonly defaults: readonly DefaultsEntry[];
  /** Where the source lives, for edit links. */
  readonly repository?: RepositoryConfig;
  /** The theme and its options. */
  readonly theme: ThemeConfig;
  /** `false` builds no search index. Default `{}`. */
  readonly search: false | SearchConfig;
  /** A cookieless analytics tool. Default: none, and no script is written. */
  readonly analytics?: AnalyticsConfig;
  /** Search engine verification tokens. Default: none. */
  readonly verify?: VerifyConfig;
  /** The shared network of projects. Default: none, and the site builds on its own. */
  readonly network?: NetworkConfig;
  /** The day the build pretends it is, `YYYY-MM-DD`; `--as-of` wins. Default: none, and a feature that needs a date reports it. */
  readonly asOf?: string;
  /** How dates are written. Default: Gregorian. */
  readonly dates?: DatesConfig;
  /** Snapshot freshness. Default: none, and no snapshot is ever reported as stale. */
  readonly snapshot?: SnapshotConfig;
  /** The versioned static data API. Default: none, and nothing is written under `api/`. */
  readonly api?: ApiConfig;
  /** Stale page detection. Default: none, and `covers` paths are relative to the site root. */
  readonly stale?: StaleConfig;
  /** Generated social share images. Default: none, and no image is written. */
  readonly social?: SocialConfig;
  /** Redirect pages: old path under `base` to a path on the site or an `https` URL. Default `{}`. */
  readonly redirects: Readonly<Record<string, string>>;
  /** Turns an output off by its name (`false`). Default: every output on. */
  readonly outputs: Readonly<Record<string, boolean>>;
}
