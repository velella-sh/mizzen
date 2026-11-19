import type { ChangelogEventType } from "./config.ts";

/** One line of a collection's history, `data-changes/<collection>.jsonl`, as a record of its `<collection>.changes`. */
export interface ChangeEvent {
  /** The stable event id: 16 lowercase hex characters of the SHA-256 of what makes the event unique. */
  readonly id: string;
  /** What happened to the record. */
  readonly type: ChangelogEventType;
  /** The record's id; for `imported`, the collection's name. */
  readonly record: string;
  /** The changed field, for `changed`. */
  readonly field?: string;
  /** The earlier value, for `changed`; absent when the field did not exist. */
  readonly old?: unknown;
  /** The current value, for `changed`; absent when the field was removed. */
  readonly new?: unknown;
  /** The earlier id, for `renamed`. */
  readonly from?: string;
  /** The tracked fields' values, for `added`. */
  readonly fields?: Readonly<Record<string, unknown>>;
  /** How many records were loaded, for `imported`. */
  readonly count?: number;
  /** The snapshot ref the import summarizes, for `imported`. */
  readonly ref?: string;
  /** The collection snapshot's `capturedAt`, never the build clock. */
  readonly date: string;
}

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

/** Why one joined output field holds the value it holds, and which inputs could have supplied it. */
export interface JoinedField {
  /** The output field's name. */
  readonly field: string;
  /** The collection whose value was selected. */
  readonly source: string;
  /** The field in that collection the value came from. */
  readonly input: string;
  /** Every `<collection>.<field>` that could supply this destination, in precedence order. */
  readonly inputs: readonly string[];
  /** `only` for one input, `precedence` for the first present one, `null-fallthrough` when a null was passed over. */
  readonly reason: "only" | "precedence" | "null-fallthrough";
}

/** For a joined record: its key values, and why each output field holds its value. */
export interface JoinedOutput {
  /** The key fields and their values, as text, in the join's order. */
  readonly key: Readonly<Record<string, string>>;
  /** One entry per output field the join wrote. */
  readonly fields: Readonly<Record<string, JoinedField>>;
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
  /**
   * Ids of the source records this summary record was computed from, for an aggregate collection. Additive and
   * internal: no page or output publishes it.
   */
  readonly inputs?: readonly string[];
  /**
   * Values the collection's `derived` rules computed for this record, keyed by the rule's name. Computed once per
   * build against the as-of date and never written back to the data file.
   */
  readonly derived?: Readonly<Record<string, unknown>>;
  /** For a joined record: its key values, and why each output field holds its value. */
  readonly joined?: JoinedOutput;
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

/** One top-level field of a recorded schema, as `mizzen.lock.json` keeps it for comparison. */
export interface SchemaFieldSnapshot {
  /** The field's declared JSON type, when the schema names one. */
  readonly type?: string;
  /** True when the schema lists the field as required. */
  readonly required: boolean;
  /** The values the schema accepts, when it declares an `enum`. */
  readonly enum?: readonly unknown[];
}

/** A collection's schema when its data was recorded, so a later schema can be compared with it. */
export interface SchemaSnapshot {
  /** SHA-256 of the schema file's bytes; two recordings of the same schema carry the same version. */
  readonly version: string;
  /** The schema file, relative to the site root, with `/` separators. */
  readonly file: string;
  /** Each top-level field the schema declares, keyed by name. */
  readonly fields: Readonly<Record<string, SchemaFieldSnapshot>>;
}

/** Where a collection's data was recorded from, as `mizzen.lock.json` holds it. Nothing in it is the build clock. */
export interface CollectionSnapshot {
  /** The source the data was recorded from: a path, a URL, or an `npm:` address. */
  readonly source: string;
  /** The commit, or the package and exact version, the data was recorded at. */
  readonly ref?: string;
  /** When the data was recorded, as a date or a UTC instant to the second, taken from the data. */
  readonly capturedAt?: string;
  /** The tool that recorded it, such as `git` or `npm`. */
  readonly tool?: string;
  /** That tool's version. */
  readonly toolVersion?: string;
  /** The collection's schema at recording time; absent when the data was recorded without one. */
  readonly schema?: SchemaSnapshot;
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
  /** Where the lock says the data was recorded from; absent when the lock holds none. */
  readonly snapshot?: CollectionSnapshot;
  /** `true` for a derived, read-only collection such as `<name>.changes`, which no template or page is built from. */
  readonly readonly?: boolean;
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
  /** URL of the record that replaces this one, when the collection's lifecycle retires it and names a replacement. */
  readonly replacementUrl?: string;
  /** The record's history events, newest first; present only when the template shows them with `:::changes`. */
  readonly changes?: readonly ChangeEvent[];
}

/** One record a configured relation points at, as the page reads it. */
export interface RelatedRecord {
  /** The target collection's name. */
  readonly collection: string;
  /** The target record's id. */
  readonly id: string;
  /** The target record page's URL, including `base` and the page language's prefix. */
  readonly url: string;
  /** The target record's fields in the page's language, with `id` filled in when the source omits it. */
  readonly fields: Readonly<Record<string, unknown>>;
}

/** A record's relations by field name; a field that resolves to nothing is absent. */
export type RecordRelations = Readonly<Record<string, readonly RelatedRecord[]>>;

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
  /** Each configured relation's records in the record's own order; absent when it resolves to nothing. */
  readonly related?: RecordRelations;
  /**
   * Values the collection's `derived` rules computed for this record, keyed by the derived name; absent when the
   * collection declares none or the record has no date to derive from.
   */
  readonly derived?: Readonly<Record<string, unknown>>;
  /** URL of every view of this record, keyed by view name; present on the main page only. */
  readonly views?: Readonly<Record<string, string>>;
  /**
   * URL of this record's add-to-calendar `.ics` file, including `base`; present on the main page of a record that has
   * events in a declared calendar, and absent for a collection with no calendar.
   */
  readonly calendar?: string;
  /** The calendars this record has events in, in config order; absent when it has none. */
  readonly calendars?: readonly CalendarLink[];
  /** The record's history events, newest first; absent when the page's template does not show them. */
  readonly changes?: readonly ChangeEvent[];
}

/** One calendar file available for subscription. */
export interface CalendarLink {
  /** The calendar's name in the config. */
  readonly name: string;
  /** The calendar's title, as a calendar app shows it. */
  readonly title: string;
  /** Absolute `https` address of the file. */
  readonly url: string;
  /** The same address with the `webcal` scheme, which opens the subscribe dialog of a calendar app. */
  readonly webcal: string;
}

/** One group of a list page. */
export interface ListGroup {
  /** The group's key, as the list grouped it. */
  readonly key: string;
  /** The records in this group; empty on the index page of an expanded list. */
  readonly records: readonly RecordProps[];
  /** URL of this group's own page, when the list expands one page per group value. */
  readonly url?: string;
  /** How many records the group holds, including on the index page where `records` is empty. */
  readonly count?: number;
  /** Subscription links for this group's value in calendars grouped by the same field. */
  readonly calendars?: readonly CalendarLink[];
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
  /** Subscription links for the collection's published calendars, in config order. */
  readonly calendars?: readonly CalendarLink[];
  /** Absolute URL of the generated collection changelog's Atom feed, when written. */
  readonly feed?: string;
}
