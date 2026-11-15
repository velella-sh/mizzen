/** Where a record, or one of its fields, sits in a source: 1-based and inclusive, counted in code points. */
export interface RecordPos {
  /** Source path relative to the site root. */
  readonly file: string;
  /** 1-based line the record starts on. */
  readonly startLine: number;
  /** 1-based column the record starts at. */
  readonly startColumn: number;
  /** 1-based line the record ends on. */
  readonly endLine: number;
  /** 1-based column of the record's last character. */
  readonly endColumn: number;
}

/** One record of a collection: its id, its fields, and where each of those sits. */
export interface DataRecord {
  /** The record's id, as the config names it or as the mapping key gives it. */
  readonly id: string;
  /** The record's fields, as the source holds them. */
  readonly fields: Readonly<Record<string, unknown>>;
  /** Where the record starts and ends in its source. */
  readonly position: RecordPos;
  /** Where each top-level field's value sits, keyed by field name. */
  readonly fieldPositions: Readonly<Record<string, RecordPos>>;
  /** Where each top-level field's key sits, keyed by field name: the YAML/JSON key, or the CSV header cell. */
  readonly keyPositions?: Readonly<Record<string, RecordPos>>;
  /** Each date field's normalized form, keyed by field name: `YYYY-MM-DD` as written, an instant as UTC ISO 8601. */
  readonly normalizedDates?: Readonly<Record<string, string>>;
}

/** What a build read from the collections a site declares. */
export interface DataStats {
  /** Collections the config declares. */
  readonly collections: number;
  /** Collections that loaded. */
  readonly loaded: number;
  /** Records the sources read, before validation left any out. */
  readonly read: number;
  /** Records the site keeps, after validation left the invalid ones out. */
  readonly kept: number;
  /** Records left out because they failed validation. */
  readonly skipped: number;
  /** Collection schemas compiled and used. */
  readonly schemas: number;
  /** Collections with no schema, so their records were not checked. */
  readonly unchecked: readonly string[];
}

/** One collection: its name, the records it was read into, and the source file they came from. */
export interface Collection {
  /** Collection name, as the config key writes it. */
  readonly name: string;
  /** Source as the config writes it: a path relative to the site root, an `npm:` address, or an `https:` URL. */
  readonly source: string;
  /** Records in source order. */
  readonly records: readonly DataRecord[];
  /** The installed package a collection was read from, when its source is `npm:`. */
  readonly package?: { readonly name: string; readonly version: string };
}

/** The record a page was built from, as the site model carries it. */
export interface PageRecord {
  /** The collection's name. */
  readonly collection: string;
  /** The record's id. */
  readonly id: string;
  /** Where the record sits in the data file. */
  readonly position: RecordPos;
  /** The template the page was built from, relative to the site root. */
  readonly template: string;
  /** 1-based line of the template where its body starts. */
  readonly templateLine: number;
  /** Fields whose value came from the default language because this language has no translation. */
  readonly fallbacks: readonly string[];
  /** The named view this page renders, when it is a view of the record rather than the record's main page. */
  readonly view?: string;
  /** URL of every view of this record, keyed by view name; present on the main page only. */
  readonly views?: Readonly<Record<string, string>>;
  /** Earlier URLs of this record page, each of which redirects to it; present when `urls.lock.json` holds one or the record names an alias. */
  readonly previousUrls?: readonly string[];
}

/** A record as a layout receives it: its identity, its URL, and the fields the page asked for. */
export interface RecordProps {
  /** The collection's name. */
  readonly collection: string;
  /** The record's id. */
  readonly id: string;
  /** The record page's URL, including `base`. */
  readonly url: string;
  /** The record's fields, or only those the page named. */
  readonly fields: Readonly<Record<string, unknown>>;
  /** Reference fields resolved to the URL of the record page they point at, keyed by field name. */
  readonly links: Readonly<Record<string, string>>;
  /** URL of every view of this record, keyed by view name; present on the main page only. */
  readonly views?: Readonly<Record<string, string>>;
}

/** One group of a list page. */
export interface ListGroup {
  /** The group's key, as the list grouped it. */
  readonly key: string;
  /** The records in this group. */
  readonly records: readonly RecordProps[];
}

/** Where a list page sits in its pagination. */
export interface ListPagination {
  /** 1-based number of this page. */
  readonly page: number;
  /** Total number of pages. */
  readonly total: number;
  /** URL of the previous page, when there is one. */
  readonly previous?: string;
  /** URL of the next page, when there is one. */
  readonly next?: string;
}

/** A list page, as a layout receives it: the records it shows, its groups, and its pagination. */
export interface ListProps {
  /** The collection's name. */
  readonly collection: string;
  /** The records on this page, in the list's order. */
  readonly records: readonly RecordProps[];
  /** The same records, grouped, when the list asked for groups. */
  readonly groups: readonly ListGroup[];
  /** Where this page sits in the list. */
  readonly pagination: ListPagination;
}
