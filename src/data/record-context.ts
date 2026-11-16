/**
 * Shared pieces for the record directives: what a record page's template reads, how a dotted field path is resolved,
 * where the value sits in the data file, and how one record's fields become the props a layout receives.
 *
 * A field path is resolved against the block's current item first (`:::each`, `:::records`), then against the record.
 * A site with languages reads `<field>.<lang>` from a mapping and falls back to the default language, marking the field
 * so a page or a layout can say the text is a fallback.
 */
import type {
  Collection,
  CollectionConfig,
  DataRecord,
  PageRecord,
  RecordPos,
  RecordProps,
  Site,
  SiteConfig,
  SourcePos,
} from "../contracts/index.ts";
import { recordUrlsOf, type RecordUrlMap } from "./permalink.ts";

/** What one record page's directives read. */
export interface RecordScope {
  /** The collection's name. */
  readonly collection: string;
  /** The record this page was built from. */
  readonly record: DataRecord;
  /** The top-level fields, localized for the page's language. */
  readonly recordFields: Readonly<Record<string, unknown>>;
  /** The current block's fields: the record's, or one item of `each` or `records`. */
  readonly fields: Readonly<Record<string, unknown>>;
  /** Collections by name, for `:::records`. */
  readonly collections: Readonly<Record<string, Collection>>;
  /** Fields the collection's schema declares, when it has one. */
  readonly schemaFields?: ReadonlySet<string>;
  /** Fields the config marks as Markdown. */
  readonly markdownFields: ReadonlySet<string>;
  /** The page's language. */
  readonly lang: string;
  /** The site's default language. */
  readonly defaultLang: string;
  /** Repository-relative prefix for data files, such as `docs`; unset when the site is the repository root. */
  readonly filePrefix?: string;
  /** The template, relative to the site root, for diagnostics. */
  readonly file: string;
}

/** One resolved field: whether it was found and the value at the path. */
export interface FoundField {
  readonly found: boolean;
  readonly value?: unknown;
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads one step of a path with own keys only and numeric list indexes. */
export function step(value: unknown, segment: string): FoundField {
  if (Array.isArray(value)) {
    const index = /^\d+$/.test(segment) ? Number(segment) : -1;
    return index >= 0 && index < value.length ? { found: true, value: value[index] } : { found: false };
  }
  if (!isMapping(value)) return { found: false };
  if (!Object.prototype.hasOwnProperty.call(value, segment)) return { found: false };
  return { found: true, value: value[segment] };
}

/** Resolves a dot-separated path inside one value. */
export function resolveIn(value: unknown, path: string): FoundField {
  let current: unknown = value;
  for (const segment of path.split(".").map((part) => part.trim()).filter((part) => part !== "")) {
    const next = step(current, segment);
    if (!next.found) return { found: false };
    current = next.value;
  }
  return { found: true, value: current };
}

/** The path's first segment, the top-level field whose position names the value. */
export function topField(path: string): string {
  return path.split(".")[0]?.trim() ?? "";
}

/** Resolves a field path against the current item, then the record. */
export function resolveField(scope: RecordScope, path: string): FoundField {
  const inItem = resolveIn(scope.fields, path);
  if (inItem.found) return inItem;
  if (scope.fields !== scope.recordFields) return resolveIn(scope.recordFields, path);
  return inItem;
}

/** True when the collection's schema declares the path's first segment, or the collection has no schema. */
export function declaredField(scope: RecordScope, path: string): boolean {
  // `id` is the record's identity and is always readable, even when the schema does not list it as a property.
  if (topField(path) === "id") return true;
  return scope.schemaFields === undefined || scope.schemaFields.has(topField(path));
}

/** A path with a repository folder in front, `/`-separated, when the site is not the repository root. */
export function prefixed(file: string, prefix: string | undefined): string {
  if (prefix === undefined || prefix === "") return file;
  const path = file.replace(/\\/g, "/").replace(/^\.\//, "");
  return path === prefix || path.startsWith(`${prefix}/`) ? path : `${prefix}/${path}`;
}

/** The URL prefix of a language, such as `/fa`; `""` for the default language or a site without languages. */
export function prefixOfLang(config: Pick<SiteConfig, "lang" | "languages">, lang: string): string {
  return config.languages.find((language) => language.code === lang)?.prefix ?? "";
}

/** The value's position in the data file: the top-level field's span, else the record's. */
export function fieldPosition(scope: RecordScope, path: string): SourcePos {
  const position: RecordPos = scope.record.fieldPositions[topField(path)] ?? scope.record.position;
  return {
    file: prefixed(position.file, scope.filePrefix),
    line: position.startLine,
    column: position.startColumn,
    endLine: position.endLine,
    endColumn: position.endColumn,
  };
}

/** True when a field has a value: not absent, `null`, an empty string, or an empty list or mapping. */
export function hasValue(scope: RecordScope, path: string): boolean {
  const found = resolveField(scope, path);
  if (!found.found) return false;
  const value = found.value;
  if (value === null || value === undefined || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isMapping(value)) return Object.keys(value).length > 0;
  return true;
}

/** The text of a scalar, or `undefined` for a value a page cannot show inline. */
export function scalarText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return undefined;
}

/** One record's fields after the page language is applied, and the fields that fell back. */
export interface LocalizedFields {
  readonly fields: Readonly<Record<string, unknown>>;
  readonly fallbacks: readonly string[];
}

/** True for a mapping that holds translations: it owns the page language or the default language. */
export function isLocalized(value: unknown, lang: string, defaultLang: string): value is Record<string, unknown> {
  if (!isMapping(value)) return false;
  return (
    Object.prototype.hasOwnProperty.call(value, lang) || Object.prototype.hasOwnProperty.call(value, defaultLang)
  );
}

/**
 * Applies a page language to a record's fields: a top-level mapping that holds `<field>.<lang>` becomes that language's
 * value, or the default language's when the translation is missing. The field is reported in `fallbacks` only when it
 * fell back, never when it is untranslated data.
 */
export function localizeFields(
  fields: Readonly<Record<string, unknown>>,
  lang: string,
  defaultLang: string,
): LocalizedFields {
  const out: Record<string, unknown> = {};
  const fallbacks: string[] = [];
  /** Own-key assignment, so a field named `__proto__` stays data and never becomes the prototype. */
  const put = (key: string, value: unknown): void => {
    Object.defineProperty(out, key, { value, writable: true, enumerable: true, configurable: true });
  };
  for (const [key, value] of Object.entries(fields)) {
    if (isLocalized(value, lang, defaultLang)) {
      if (Object.prototype.hasOwnProperty.call(value, lang)) {
        put(key, value[lang]);
      } else {
        put(key, value[defaultLang]);
        if (lang !== defaultLang) fallbacks.push(key);
      }
      continue;
    }
    put(key, value);
  }
  return { fields: out, fallbacks };
}

/** Collection names a field points at, from the collection's `references` config. */
export function referenceTargets(config: CollectionConfig | undefined): Readonly<Record<string, string>> {
  return config?.references ?? {};
}

/**
 * The URL of another record's page, using the collection's pattern and the page language's prefix. `undefined` when the
 * collection has no pattern, the record is absent, or the pattern cannot be filled.
 *
 * With `lang` and `defaultLang`, the target record's fields are localized first, so a pattern such as
 * `/components/{name}/` fills from that language's name and falls back to the default language.
 */
export function urlOfRecord(
  collections: Readonly<Record<string, Collection>>,
  config: Readonly<Record<string, CollectionConfig>>,
  base: string,
  prefix: string,
  collection: string,
  id: string,
  lang?: string,
  defaultLang?: string,
): string | undefined {
  const entry = config[collection];
  if (entry === undefined) return undefined;
  return urlsOfCollection(collections, entry, base, prefix, collection, lang, defaultLang)?.urls.get(id)?.url;
}

/** A collection's URL set and the data it was computed from, so a changed collection or config entry is never reused. */
interface CachedUrls {
  readonly source: Collection;
  readonly entry: CollectionConfig;
  readonly map: RecordUrlMap;
}

/**
 * One URL set per collection and language, kept for the lifetime of the site model. Computing it needs every record of
 * the collection, so a page with many `record:` links would otherwise repeat that work for each link. The cache is
 * keyed by the collections object, which is rebuilt for each build, so a result never outlives the data it describes.
 */
const urlSets = new WeakMap<Readonly<Record<string, Collection>>, Map<string, CachedUrls>>();

function urlsOfCollection(
  collections: Readonly<Record<string, Collection>>,
  entry: CollectionConfig,
  base: string,
  prefix: string,
  collection: string,
  lang: string | undefined,
  defaultLang: string | undefined,
): RecordUrlMap | undefined {
  const source = collections[collection];
  if (source === undefined) return undefined;
  let sets = urlSets.get(collections);
  if (sets === undefined) {
    sets = new Map();
    urlSets.set(collections, sets);
  }
  const key = `${collection}\u0000${base}\u0000${prefix}\u0000${lang ?? ""}\u0000${defaultLang ?? ""}`;
  const cached = sets.get(key);
  if (cached !== undefined && cached.entry === entry && cached.source === source) return cached.map;

  const records = source.records.map((record) => {
    const localized =
      lang === undefined || defaultLang === undefined
        ? record.fields
        : localizeFields(record.fields, lang, defaultLang).fields;
    const fields = localized["id"] === undefined ? { ...localized, id: record.id } : localized;
    return { id: record.id, fields, position: record.position };
  });
  const map = recordUrlsOf(collection, records, entry, { base, prefix });
  sets.set(key, { source, entry, map });
  return map;
}

/**
 * The props a layout receives for a record page: its identity, its URL, its fields in the page's language, and the
 * URLs its reference fields point at. `undefined` on every other page.
 */
export function recordPropsOf(site: Site, page: { readonly record?: PageRecord; readonly lang: string; readonly url: string }): RecordProps | undefined {
  const record = page.record;
  if (record === undefined) return undefined;
  const entry = site.collections[record.collection];
  const source = entry?.records.find((candidate) => candidate.id === record.id);
  if (entry === undefined || source === undefined) return undefined;
  const config = site.config.collections[record.collection];
  const localized = localizeFields(source.fields, page.lang, site.config.lang);
  const fields = localized.fields["id"] === undefined ? { ...localized.fields, id: record.id } : localized.fields;
  const prefix = prefixOfLang(site.config, page.lang);
  const links: Record<string, string> = {};
  for (const [field, collection] of Object.entries(referenceTargets(config))) {
    const id = fields[field];
    if (typeof id !== "string" && typeof id !== "number") continue;
    const url = urlOfRecord(
      site.collections,
      site.config.collections,
      site.config.base,
      prefix,
      collection,
      String(id),
      page.lang,
      site.config.lang,
    );
    if (url !== undefined) links[field] = url;
  }
  return {
    collection: record.collection,
    id: record.id,
    url: page.url,
    fields,
    links,
    ...(record.views === undefined ? {} : { views: record.views }),
  };
}
