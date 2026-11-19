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
/** Units a site may replace without editing or forking its theme. Paths are relative to the site root. */
export interface ThemeOverridesConfig {
  /** Layout name → the site module that replaces it. */
  readonly layouts?: Readonly<Record<string, string>>;
  /** Component name → the site module that replaces it. */
  readonly components?: Readonly<Record<string, string>>;
}

export interface ThemeConfig {
  /** Theme package or folder. Default: the theme that ships with the engine. */
  readonly name?: string;
  /** Passed to the theme unread; the theme validates it against its own schema. */
  readonly options?: Readonly<Record<string, unknown>>;
  /** Site modules that replace selected theme units; every other unit stays the theme's. */
  readonly overrides?: ThemeOverridesConfig;
}

/** Search settings. */
export interface SearchConfig {
  /** The most characters of a page's body the index keeps. Default `300`; titles and headings are always indexed. */
  readonly text?: number;
}

/** The `blog` block: where the posts live and how their public routes are named. */
export interface BlogConfig {
  /** Folder that holds the posts, relative to the site root. Required to turn the blog on. */
  readonly posts: string;
  /** Public prefix of every blog URL. Default `blog`. */
  readonly route?: string;
  /** Archive route under the prefix. Default `archive`. */
  readonly archive?: string;
  /** Write one page per author. Default `true`. */
  readonly authors?: boolean;
  /** Write the Atom feed. Default `true`. */
  readonly feed?: boolean;
  /** Posts per index page. Default `10`. */
  readonly pageSize?: number;
}

/** The `apiReference` block: the pinned OpenAPI document and the path its pages live under. */
export interface ApiReferenceConfig {
  /** One YAML or JSON OpenAPI 3.1 or 3.0 file, relative to the site root. */
  readonly source: string;
  /** Path the reference lives under, starting and ending with `/`. Default `/reference/`. */
  readonly path?: string;
}

/** How the `examples-report` output treats a failing example. */
export interface ExamplesConfig {
  /** Report a failed example as an error at its fence, so `mizzen check` exits `1`. Default `false`. */
  readonly failOnFailure?: boolean;
}

/** How a paginated API hands out its next page. */
export type PaginationMode = "page" | "offset" | "cursor" | "next";

/** What ends a page-number or offset walk. */
export type PaginationStop = "empty" | "short";

/** Where a fetched API's credential comes from, and how it is sent. The value lives only in the environment. */
export interface ApiAuthConfig {
  /** Environment variable that holds the credential. Never written to the config, the lock, or an output. */
  readonly env: string;
  /** Header the credential is sent in. Default `Authorization`. */
  readonly header?: string;
  /** Text written before the credential, such as `Bearer `. Default empty. */
  readonly prefix?: string;
}

/**
 * One paginated API source: the record array, how the next page is asked for, and the bounds a fetch may not pass.
 * `docs/api-fetch.md` states every default and the diagnostic of each limit.
 */
export interface PaginationConfig {
  /** `page` sends a page number, `offset` counts records, `cursor` passes a token, `next` follows a URL. */
  readonly mode: PaginationMode;
  /** Query parameter for the page number, offset, or cursor. Default `page`, `offset`, or `cursor`. */
  readonly param?: string;
  /** `page` mode: the first page number. `offset` mode: the first offset. Default 1 for a page, 0 for an offset. */
  readonly start?: number;
  /** Records the service returns per page; `stop: short` compares against it. */
  readonly pageSize?: number;
  /** When a `page` or `offset` walk stops: `empty` on a page with no records, `short` below `pageSize`. */
  readonly stop?: PaginationStop;
  /** `cursor` mode: dot path in the response that holds the next cursor. Absent ends the walk. */
  readonly cursor?: string;
  /** `next` mode: dot path in the response that holds the next page URL. Absent ends the walk. */
  readonly next?: string;
  /** Origins a next-page URL may name. Default: the source URL's own origin. */
  readonly origins?: readonly string[];
  /** Where the credential is read, and how it is sent. Unset: the request carries none. */
  readonly auth?: ApiAuthConfig;
  /** Most pages one fetch may read. Default 50. */
  readonly maxPages?: number;
  /** Most bytes one fetch may read across every page. Default: the collection's `limits.bytes`. */
  readonly maxBytes?: number;
  /** Most times one request is retried after a transient failure. Default 2. */
  readonly retries?: number;
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

/** Which count a derived value is: days to the field's latest day, or days since its earliest day. */
export type DerivedKind = "days-left" | "days-since";

/** A derived value that counts whole days between a record's date field and the build's as-of date. */
export interface DerivedCountConfig {
  /** Record field that holds the date; a record without one has no value. */
  readonly field: string;
  /** `days-left` counts to the field's latest day; `days-since` counts from its earliest day. */
  readonly kind: DerivedKind;
}

/** One band of a derived state: the value a record takes when its day count is below `below`. */
export interface DerivedBandConfig {
  /**
   * Exclusive upper bound of the band, in whole days. The last band leaves it out and takes every count
   * the earlier bands did not.
   */
  readonly below?: number;
  /** The value the derived field has in this band. */
  readonly value: string | number | boolean;
}

/** A derived value that turns a record's day count into one of a few values. */
export interface DerivedBandsConfig {
  /** Record field that holds the date; a record without one has no value. */
  readonly field: string;
  /** Bands in increasing `below` order; the last one has no `below`. */
  readonly bands: readonly DerivedBandConfig[];
}

/** One value a collection derives from a record's date field, against the build's as-of date. */
export type DerivedRuleConfig = DerivedCountConfig | DerivedBandsConfig;

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
  /** Build one list page per snapshot date and a newest-events page, and write the Atom feed. Default `false`. */
  readonly pages?: boolean;
}

/** What a record's disappearance from its collection does. */
export type OnRemovedConfig =
  | "error"
  | "gone"
  | {
      /** A page on the site the removed record's URLs redirect to, such as `/items/`. */
      readonly redirect: string;
    };

/** A record's state in a collection's lifecycle, and what a retired record's URL does. */
export interface CollectionLifecycleConfig {
  /** Field that holds a record's state. Default `state`. */
  readonly field?: string;
  /** States a record may have; a value outside the list is reported. Default `[]`: every state is accepted. */
  readonly states?: readonly string[];
  /** States that mean a record is retired. Default `[]`: no state retires a record. */
  readonly retired?: readonly string[];
  /** Field that holds the id of the record that replaces a retired one. */
  readonly replacement?: string;
  /** What a retired record's URL does: `retain` keeps its page, `redirect` sends readers to the replacement. Default `retain`. */
  readonly url?: "retain" | "redirect";
  /** `true` marks a retired record for machine readers, such as the page JSON. Default `false`. */
  readonly machine?: boolean;
}

/** The target type of a `cast` step. */
export type TransformCastTarget = "string" | "number" | "integer" | "boolean";

/** When a `default` step fills a field: an absent field, a null value, or either. */
export type TransformDefaultWhen = "missing" | "null" | "missing-or-null";

/** What a `map` step does with a value its mapping does not name. */
export type TransformUnknownPolicy = "keep" | "error" | "default";

/** The keys every transformation step shares. */
export interface TransformStepBase {
  /** The rule's id, used by diagnostics and events. Default: `step-<position>`, counting from 1. */
  readonly id?: string;
}

/** Keep only the named field paths; every other field is left out. */
export interface TransformSelectStep extends TransformStepBase {
  readonly op: "select";
  /** Field paths to keep, as dot paths such as `author.name`. */
  readonly fields: readonly string[];
}

/** Remove the named field paths; every other field is left as it is. */
export interface TransformRemoveStep extends TransformStepBase {
  readonly op: "remove";
  /** Field paths to remove, as dot paths such as `author.name`. */
  readonly fields: readonly string[];
}

/** Move a value from one path to another. */
export interface TransformRenameStep extends TransformStepBase {
  readonly op: "rename";
  /** The path the value is read from. */
  readonly from: string;
  /** The path the value is written to. */
  readonly to: string;
  /** What a value already at `to` does: `error` reports it and leaves the record, `overwrite` replaces it. Default `error`. */
  readonly onConflict?: "error" | "overwrite";
}

/** Fill a field that is absent or null. */
export interface TransformDefaultStep extends TransformStepBase {
  readonly op: "default";
  /** The field path to fill. */
  readonly field: string;
  /** The value written when the field matches `when`. */
  readonly value: unknown;
  /** Which values the default replaces: `missing`, `null`, or `missing-or-null`. Default `missing`; zero is never missing. */
  readonly when?: TransformDefaultWhen;
}

/** Convert a value to a primitive type. */
export interface TransformCastStep extends TransformStepBase {
  readonly op: "cast";
  /** The field path to convert. */
  readonly field: string;
  /** The type the value must reach: `string`, `number`, `integer`, or `boolean`. */
  readonly to: TransformCastTarget;
}

/** Trim and change the case of a string value. */
export interface TransformNormalizeStep extends TransformStepBase {
  readonly op: "normalize";
  /** The field path to normalize. */
  readonly field: string;
  /** Trim whitespace from both ends. Default `true`. */
  readonly trim?: boolean;
  /** The case to write: `lower`, `upper`, or `none`. Default `none`. */
  readonly case?: "lower" | "upper" | "none";
}

/** Replace categorical values through a mapping. */
export interface TransformMapStep extends TransformStepBase {
  readonly op: "map";
  /** The field path to read. */
  readonly field: string;
  /** The value a recognized input becomes, keyed by the input written as text. */
  readonly values: Readonly<Record<string, unknown>>;
  /** What an unrecognized value does: `keep`, `error`, or `default`. Default `keep`. */
  readonly unknown?: TransformUnknownPolicy;
  /** The value written for an unrecognized input when `unknown` is `default`. */
  readonly default?: unknown;
}

/** Read a date in a fixed format and time zone, and write it as an instant or a day. */
export interface TransformDateStep extends TransformStepBase {
  readonly op: "date";
  /** The field path to read. */
  readonly field: string;
  /** The input format: `YYYY`, `MM`, `DD`, `HH`, `mm`, and `ss`, with literal separators, such as `DD/MM/YYYY HH:mm`. */
  readonly format: string;
  /** The IANA time zone the input is written in, such as `Asia/Tehran` or `UTC`. */
  readonly timezone: string;
  /** What the value becomes: a UTC ISO 8601 instant (`iso`, the default) or a `YYYY-MM-DD` day (`date`). */
  readonly output?: "iso" | "date";
}

/** Multiply a numeric value by a factor and round it. */
export interface TransformUnitStep extends TransformStepBase {
  readonly op: "unit";
  /** The field path to convert. */
  readonly field: string;
  /** The number the value is multiplied by, such as `1000` from grams to milligrams. */
  readonly factor: number;
  /** Decimal places to round to. Default: no rounding. */
  readonly round?: number;
}

/** Keep only the records that match every condition. */
export interface TransformFilterStep extends TransformStepBase {
  readonly op: "filter";
  /**
   * The conditions a record must match, keyed by field path; every condition must hold. A list value matches any of
   * its items. A field path that is absent does not match.
   */
  readonly where: Readonly<Record<string, unknown>>;
}

/** Keep one record per composite key. */
export interface TransformDedupeStep extends TransformStepBase {
  readonly op: "dedupe";
  /** The field paths that make up the key, as dot paths. */
  readonly by: readonly string[];
  /** Which record survives: the first or the last of its key in source order. Default `first`. */
  readonly keep?: "first" | "last";
}

/** One transformation step: `op` names the operator and decides which other keys it reads. */
export type TransformStepConfig =
  | TransformSelectStep
  | TransformRemoveStep
  | TransformRenameStep
  | TransformDefaultStep
  | TransformCastStep
  | TransformNormalizeStep
  | TransformMapStep
  | TransformDateStep
  | TransformUnitStep
  | TransformFilterStep
  | TransformDedupeStep;

/** Rules that rewrite a collection's records before they are validated and published. */
export interface CollectionTransformConfig {
  /**
   * When each record is checked against the collection's schema: `after` validates the transformed record once,
   * `before-and-after` also reports a raw record that does not match, then still transforms it. Default `after`.
   */
  readonly validate?: "after" | "before-and-after";
  /** The steps, applied in this order; each step reads the record the previous step wrote. */
  readonly steps: readonly TransformStepConfig[];
}

/** How a join treats a primary record with no match in a secondary source. */
export type JoinType = "inner" | "left";

/** What a record whose key is missing or null does. */
export type JoinMissingKey = "error" | "skip";

/** How a destination field that more than one side supplies is chosen. */
export type JoinConflict = "precedence" | "error";

/** Whether a null value is a value of its own (`keep`) or falls through to the next source (`fallthrough`). */
export type JoinNull = "keep" | "fallthrough";

/** What more than one secondary record with the same key does. `error` reports a one-to-one violation. */
export type JoinMany = "error" | "first" | "last" | "list";

/** One collection joined into a collection's records, after its own source was read and transformed. */
export interface JoinSourceConfig {
  /** The collection whose records are joined in. */
  readonly collection: string;
  /** Fields on this collection's records that match the primary key, in the same order. Default: the join's `key`. */
  readonly key?: string | readonly string[];
  /** Output field → field in this collection. Absent: every top-level field. */
  readonly fields?: Readonly<Record<string, string>>;
  /** What more than one match with the same key does. Default: the join's `many`. */
  readonly many?: JoinMany;
  /** Output field that holds the nested records when `many` is `list`. Default: this collection's name. */
  readonly manyField?: string;
}

/**
 * Joins other collections into this collection's records on declared keys. The collection's own source is the primary
 * side; every source in `sources` is one further join step in the order written. The primary record's id, position,
 * and order decide the joined record's identity, so reordering a secondary source moves no id and no URL.
 */
export interface JoinConfig {
  /** `inner` keeps only primary records that matched every source; `left` keeps every primary record. Default `inner`. */
  readonly type?: JoinType;
  /** Fields on the primary record that a source key matches. */
  readonly key: string | readonly string[];
  /** Output field → field on the primary record. Absent: every top-level field. */
  readonly fields?: Readonly<Record<string, string>>;
  /** The collections joined in, in precedence order after the primary. At least one. */
  readonly sources: readonly JoinSourceConfig[];
  /** What a primary or secondary record whose key is absent or null does. Default `error`. */
  readonly onMissingKey?: JoinMissingKey;
  /** How a destination more than one side supplies is chosen. Default `precedence`. */
  readonly onConflict?: JoinConflict;
  /** Whether a null value is kept as a value or falls through to the next source. Default `keep`. */
  readonly onNull?: JoinNull;
  /** What more than one match does when a source does not set `many`. Default `error`. */
  readonly many?: JoinMany;
}

/** How a local SQLite source is read. `docs/db-input.md` states every default and diagnostic. */
export interface SqliteSourceConfig {
  /** A read-only query whose rows become the collection's records. */
  readonly query: string;
  /** Identifier the lock records for the query. Default: the collection name. */
  readonly id?: string;
  /** Fixed values bound to the query's `?` placeholders, in order. */
  readonly params?: readonly (string | number | null)[];
  /** Column that holds each row's id. Default: the collection's `id`, else `id`. */
  readonly key?: string;
  /** Further columns that order the rows, ascending. Ties fall back to the key. Default `[]`. */
  readonly order?: readonly string[];
  /** What to do with a binary (BLOB) value: write base64, or reject it with the column name. Default `base64`. */
  readonly binary?: "base64" | "error";

}

/** One data collection: where its records come from, and how its pages are built. */
/** How an aggregate groups one field: by value, or by the month or year of a date. */
export interface AggregateGroupConfig {
  /** Field to group by; a record without a value follows the aggregate's `missing` policy. */
  readonly field: string;
  /** Bucket a date field by `month` or `year` instead of by its written value. */
  readonly period?: "month" | "year";
  /** IANA zone that decides which month or year an instant belongs to; required with `period`. */
  readonly timezone?: string;
}

/** The operator an aggregate metric applies to its group. */
export type AggregateMetricOp = "count" | "count-distinct" | "sum" | "average" | "min" | "max";

/** One value an aggregate computes for every group. */
export interface AggregateMetricConfig {
  /** What to compute. */
  readonly op: AggregateMetricOp;
  /** Field to read, required except for `count`. */
  readonly field?: string;
  /** Decimal places a `sum` or `average` is rounded to. Default `2`. */
  readonly decimals?: number;
}

/** How an aggregate collection groups its source collection's records and what it computes per group. */
export interface AggregateConfig {
  /** Grouping fields, in order; every distinct combination is one group. */
  readonly by: readonly AggregateGroupConfig[];
  /** Values computed per group, keyed by the field name the summary holds. */
  readonly metrics: Readonly<Record<string, AggregateMetricConfig>>;
  /** Records that must match this filter before they join a group; the same shape as a list's `where`. */
  readonly where?: unknown;
  /** What a record without one of the grouping values does: skip it, or group it separately. Default `skip`. */
  readonly missing?: "skip" | "group";
  /** What a group whose metrics all lack a value does: keep it with null values, or omit it. Default `keep`. */
  readonly empty?: "keep" | "omit";
}

export interface CollectionConfig {
  /** Data file the records are read from, relative to the site root; the source collection's name on an aggregate. */
  readonly source: string;
  /** How a `.sqlite`, `.sqlite3`, or `.db` source is queried. */
  readonly sqlite?: SqliteSourceConfig;
  /**
   * Dot path to the record array inside a JSON API response, such as `data.items`. Setting it marks the source as a
   * JSON API: `mizzen data fetch` stores the records as one list, and a build reads that list. Default: the source is
   * already a list or a mapping of id to record.
   */
  readonly records?: string;
  /** How `mizzen data fetch` walks a paginated API. Unset: one request. See `docs/api-fetch.md`. */
  readonly pagination?: PaginationConfig;
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
  /**
   * Fields an earlier record may still hold under an old name, keyed by the new name: `{ slug: path }` reads `path`
   * as `slug`. A record that holds both keeps the new one and earns a warning naming its line. Default `{}`.
   */
  readonly schemaRenames?: Readonly<Record<string, string>>;
  /**
   * What a schema change that earlier records may not satisfy does: `error` fails the build, `warn` reports a warning.
   * Default `error`.
   */
  readonly onSchemaChange?: "error" | "warn";
  /** Fields whose values must be unique in the collection; a duplicate is an error naming both records. Default `[]`. */
  readonly unique?: readonly string[];
  /** Fields that hold a reference to another collection's record id, keyed by field name. Default `{}`. */
  readonly references?: Readonly<Record<string, string>>;
  /** Fields that hold a date, written `YYYY-MM-DD`, `YYYY-MM`, or `YYYY`, or as a full ISO 8601 instant. Default `[]`. */
  readonly dates?: readonly string[];
  /**
   * Values derived from one of the collection's date fields, computed once per build against the site's as-of date.
   * A real field with the same name wins; nothing is written back to the data file. Default `{}`.
   */
  readonly derived?: Readonly<Record<string, DerivedRuleConfig>>;
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
  /** Top-level record field that maps the record's other fields to the claims that back them; absent keeps evidence off. */
  readonly evidence?: string;
  /** What an invalid record does: `error` fails the build, `skip` leaves it out of the site with a warning. Default `error`. */
  readonly onInvalid?: "error" | "skip";
  /** What a record that was published and is no longer in the collection does. Default `error` once `urls.lock.json` exists. */
  readonly onRemoved?: OnRemovedConfig;
  /** A record's state in the collection's lifecycle, and what a retired record's URL does. Unset: every record is published. */
  readonly lifecycle?: CollectionLifecycleConfig;
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
  /**
   * The record fields every public output may publish, as dot paths such as `author.name`. A field not listed is left
   * out of pages, search, feeds, downloads, and the API; the record keeps it internally. Absent publishes every field,
   * and `id` is always public. Default: every field.
   */
  readonly public?: readonly string[];
  /** The change history of the collection's data, written by `mizzen data changes`. Default: none. */
  readonly changelog?: CollectionChangelogConfig;
  /**
   * Rules that rewrite each record before it is validated and published, applied in order. A collection without
   * `transform` publishes its records exactly as the source writes them. Default: none.
   */
  readonly transform?: CollectionTransformConfig;
  /**
   * Collections joined into this collection's records after its own source is read and transformed. The joined record
   * keeps this collection's record id, position, and order; a source that changes refreshes the dependent output.
   */
  readonly join?: JoinConfig;
  /**
   * Build this collection by grouping another collection's records instead of reading a file. `source` names that
   * collection. The summary is published like any other collection: lists, pages, feeds, the API, and search read it
   * through `collections.<name>`. Default: none.
   */
  readonly aggregate?: AggregateConfig;
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

/** What a data-quality rule measures. */
export type QualityRuleKind = "completeness" | "coverage" | "count" | "threshold" | "outlier" | "freshness";

/** One data-quality rule: what it measures, on which collection, and when it reports. */
export interface QualityRule {
  /** What the rule measures: a missing field, a field's coverage drop, a record-count drop, a value outside a range, or a date older than a limit. */
  readonly kind: QualityRuleKind;
  /** The collection it reads. */
  readonly collection: string;
  /** The fields it checks. Default: every field the collection's records hold. */
  readonly fields?: readonly string[];
  /** For `freshness`: the date field whose age the rule measures. Required for that kind. */
  readonly field?: string;
  /** A record must match to be in scope, written like a list page's `where`. Default: every record. */
  readonly where?: Readonly<Record<string, unknown>>;
  /** How this rule's findings are reported. Default: the policy for its kind, then `warning`. */
  readonly severity?: "warning" | "error";
  /** For `coverage` and `count`: how much the value may drop before the rule reports. Required for those kinds. */
  readonly maxDrop?: number;
  /** For `freshness`: how many days before the as-of date a record's date may be. Required for that kind. */
  readonly maxAgeDays?: number;
  /** For `threshold` and `outlier`: the lowest value the field may hold. At least one of `min` and `max` is required. */
  readonly min?: number;
  /** For `threshold` and `outlier`: the highest value the field may hold. At least one of `min` and `max` is required. */
  readonly max?: number;
}

/** A dated exception: a finding the rules would make, held back until a day. */
export interface QualityException {
  /** The kind of finding it covers. */
  readonly rule: QualityRuleKind;
  /** The record it covers. Default: every record. */
  readonly record?: string;
  /** The field it covers. Default: every field. */
  readonly field?: string;
  /** Why the finding is allowed. */
  readonly reason: string;
  /** The last day it holds, `YYYY-MM-DD`. Default: no end. */
  readonly until?: string;
}

/** The `quality` key: rules that report missing fields and falling coverage or counts, with dated exceptions. */
export interface QualityConfig {
  readonly rules: readonly QualityRule[];
  readonly exceptions: readonly QualityException[];
  /** How a finding of each kind is reported. Default `warning`. */
  readonly policy: Readonly<Partial<Record<QualityRuleKind, "warning" | "error">>>;
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

/** The `drift` key: how the API contract findings `drift.json` writes are reported. */
export interface DriftConfig {
  /** How a contract failure (a mismatch, a removed symbol, or a moved symbol) is reported. Default `warning`. */
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
  /** The blog: posts, archive, author pages, and feed. Default: none, and no `/blog/` route exists. */
  readonly blog?: BlogConfig;
  /** A static reference built from one pinned OpenAPI document. Default: none, and no reference pages exist. */
  readonly apiReference?: ApiReferenceConfig;
  /** Front matter applied by folder; later entries win over earlier ones, and a page always wins. Default `[]`. */
  readonly defaults: readonly DefaultsEntry[];
  /** Where the source lives, for edit links. */
  readonly repository?: RepositoryConfig;
  /** The theme and its options. */
  readonly theme: ThemeConfig;
  /** `false` builds no search index. Default `{}`. */
  readonly search: false | SearchConfig;
  /** How a failed example is reported. Default: a warning that never fails the build. */
  readonly examples?: ExamplesConfig;
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
  /** Data-quality rules and dated exceptions. Default: none, and `mizzen data quality` reports nothing. */
  readonly quality?: QualityConfig;
  /** The versioned static data API. Default: none, and nothing is written under `api/`. */
  readonly api?: ApiConfig;
  /** Stale page detection. Default: none, and `covers` paths are relative to the site root. */
  readonly stale?: StaleConfig;
  /** How the API contract findings `drift.json` writes are reported. Default: none, and a contract failure is a warning. */
  readonly drift?: DriftConfig;
  /** Generated social share images. Default: none, and no image is written. */
  readonly social?: SocialConfig;
  /** Redirect pages: old path under `base` to a path on the site or an `https` URL. Default `{}`. */
  readonly redirects: Readonly<Record<string, string>>;
  /** Turns an output off by its name (`false`). Default: every output on. */
  readonly outputs: Readonly<Record<string, boolean>>;
}
