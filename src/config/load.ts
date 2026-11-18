import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join, relative, resolve } from "node:path";
import type { ErrorObject } from "ajv";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import { checkAsOf } from "../dates/as-of.ts";
import {
  isMap,
  isScalar,
  isSeq,
  LineCounter,
  parseDocument,
  type Document,
  type Node,
  type Pair,
} from "yaml";
import type {
  ApiCollectionConfig,
  ApiVersionConfig,
  ApiConfig,
  ApiReferenceConfig,
  AnalyticsConfig,
  AnalyticsProvider,
  BlogConfig,
  VerifyConfig,
  CollectionConfig,
  CollectionIndexConfig,
  CollectionChangelogConfig,
  CollectionLifecycleConfig,
  CollectionRawConfig,
  CollectionJsonConfig,
  CollectionSearchConfig,
  CollectionSeoConfig,
  CollectionViewConfig,
  DatesConfig,
  DefaultsEntry,
  DerivedBandConfig,
  DerivedRuleConfig,
  Diagnostic,
  Direction,
  DriftConfig,
  CalendarConfig,
  CalendarEventConfig,
  ExamplesConfig,
  FeedConfig,
  FeedFormat,
  LanguageConfig,
  NetworkConfig,
  QualityConfig,
  QualityException,
  QualityRule,
  QualityRuleKind,
  SnapshotConfig,
  StaleConfig,
  RepositoryConfig,
  SearchConfig,
  SiteConfig,
  SocialConfig,
  SourcePos,
  ThemeConfig,
} from "../contracts/index.ts";
import type { ApiAuthConfig, CollectionTransformConfig, PaginationConfig, PaginationMode, PaginationStop, TransformCastTarget, TransformStepConfig } from "../contracts/config.ts";

/** The site config file name. */
export const CONFIG_FILE = "mizzen.yml";

/** Result of loading a site's config. */
export interface LoadConfigResult {
  /** The config after defaults; always complete even when diagnostics are present. */
  readonly config: SiteConfig;
  /** Problems found in the file; empty when the file is missing or valid. */
  readonly diagnostics: readonly Diagnostic[];
}

/** Options of {@link loadConfig}. */
export interface LoadConfigOptions {
  /** Absolute or site-relative path of the config file. Default: `<siteRoot>/mizzen.yml`. */
  readonly path?: string;
}

/** Primary language subtags that default to right-to-left. */
const RTL = new Set([
  "ar", "arc", "ckb", "dv", "fa", "he", "ks", "ku", "ps", "sd", "syr", "ug", "ur", "yi",
]);

// ajv is CommonJS: its default export is the class at run time, but its types name it.
const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;
const schema = JSON.parse(
  readFileSync(new URL("../../schema/config.schema.json", import.meta.url), "utf8"),
) as object;
const validateConfig = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

/** Default text direction for a BCP 47 tag. */
export function directionFromLang(lang: string): Direction {
  const base = lang.split("-", 1)[0]?.toLowerCase() ?? "";
  return RTL.has(base) ? "rtl" : "ltr";
}

/**
 * Load `mizzen.yml` from `siteRoot` (or `options.path`), validate it, and fill defaults.
 * A missing file yields the defaults and the folder name as `title`, with no diagnostic.
 */
export function loadConfig(siteRoot: string, options: LoadConfigOptions = {}): LoadConfigResult {
  const absPath = options.path === undefined ? join(siteRoot, CONFIG_FILE) : resolve(siteRoot, options.path);
  const file = posixRelative(siteRoot, absPath);
  const folderTitle = basename(siteRoot);

  if (!existsSync(absPath)) {
    return { config: applyDefaults({}, folderTitle), diagnostics: [] };
  }

  const text = readFileSync(absPath, "utf8");
  return loadConfigText(text, file, folderTitle);
}

/** Parse and validate config YAML text. `file` is only used for diagnostic positions. */
export function loadConfigText(source: string, file: string, folderTitle: string): LoadConfigResult {
  const text = source.startsWith("﻿") ? source.slice(1) : source;
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter });
  const diagnostics: Diagnostic[] = [];

  if (doc.errors.length > 0) {
    for (const error of doc.errors) {
      const start = error.linePos?.[0];
      const end = error.linePos?.[1] ?? start;
      diagnostics.push({
        id: "config.invalid-yaml",
        severity: "error",
        message: `Invalid YAML in ${file}: ${error.message.split("\n")[0]}`,
        pos: {
          file,
          line: start?.line ?? 1,
          column: start?.col ?? 1,
          endLine: end?.line ?? start?.line ?? 1,
          endColumn: end?.col ?? start?.col ?? 1,
        },
      });
    }
    return { config: applyDefaults({}, folderTitle), diagnostics };
  }

  const value: unknown = doc.toJS();
  if (value === null || value === undefined) {
    return { config: applyDefaults({}, folderTitle), diagnostics: [] };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return {
      config: applyDefaults({}, folderTitle),
      diagnostics: [{
        id: "config.not-a-mapping",
        severity: "error",
        message: "Site config must be a YAML mapping of keys to values.",
        pos: posFromNode(file, lineCounter, doc.contents),
      }],
    };
  }

  const raw = value as Record<string, unknown>;
  if (!validateConfig(raw) && validateConfig.errors) {
    for (const error of validateConfig.errors) {
      // ajv reports a bad collection name twice: once for the inner keyword and once for the name itself.
      if (isCollectionsName(error) && error.keyword !== "propertyNames") continue;
      diagnostics.push(diagnosticFromAjv(error, file, doc, lineCounter));
    }
  }

  if (typeof raw.asOf === "string") {
    const problem = checkAsOf(raw.asOf);
    if (problem !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(raw.asOf)) {
      const pair = getMapPair(doc, ["asOf"]);
      diagnostics.push({
        id: "config.as-of",
        severity: "error",
        message: `\`asOf\` is not a date: ${problem}`,
        pos: posFromNode(file, lineCounter, isNode(pair?.value) ? pair.value : doc.contents),
        help: "Write a real day as YYYY-MM-DD.",
      });
    }
  }

  const collections = collectionsFrom(raw.collections);
  const apiConfig = apiFrom(raw.api);
  const apiBlocks: [readonly string[], Record<string, unknown>][] = [[["api"], apiConfig?.collections ?? {}]];
  for (const [version, entry] of Object.entries(apiConfig?.versions ?? {})) apiBlocks.push([["api", "versions", version], entry.collections]);
  for (const [path, published] of apiBlocks) {
    for (const name of Object.keys(published)) {
      if (collections[name] !== undefined) continue;
      const pair = getMapPair(doc, [...path, "collections", name]);
      diagnostics.push({
        id: "config.api-collection",
        severity: "error",
        message: `The API publishes the collection "${name}", which the site does not have.`,
        pos: posFromNode(file, lineCounter, isNode(pair?.key) ? pair.key : doc.contents),
        help: "Name a collection the config declares under `collections`.",
      });
    }
  }
  for (const [name, feed] of Object.entries(feedsFrom(raw.feeds))) {
    if (collections[feed.collection] !== undefined) continue;
    const pair = getMapPair(doc, ["feeds", name, "collection"]);
    diagnostics.push({
      id: "config.feeds-collection",
      severity: "error",
      message: `The feed "${name}" lists the collection "${feed.collection}", which the site does not have.`,
      pos: posFromNode(file, lineCounter, isNode(pair?.value) ? pair.value : doc.contents),
      help: "Name a collection the config declares.",
    });
  }

  diagnostics.push(...calendarDiagnostics(raw, collections, file, doc, lineCounter));
  diagnostics.push(...derivedDiagnostics(raw, collections, file, doc, lineCounter));
  diagnostics.push(...apiFetchDiagnostics(raw, collections, file, doc, lineCounter));

  return { config: applyDefaults(raw, folderTitle), diagnostics };
}

/** Findings about calendars the schema cannot see: an unknown collection, a date field the collection does not declare as a date. */
function calendarDiagnostics(
  raw: Record<string, unknown>,
  collections: Readonly<Record<string, CollectionConfig>>,
  file: string,
  doc: Document.Parsed,
  lineCounter: LineCounter,
): Diagnostic[] {
  const found: Diagnostic[] = [];
  const at = (path: (string | number)[]) => {
    const pair = getMapPair(doc, path);
    return posFromNode(file, lineCounter, isNode(pair?.value) ? pair.value : doc.contents);
  };
  for (const [name, calendar] of Object.entries(calendarsFrom(raw.calendars))) {
    const collection = collections[calendar.collection];
    if (collection === undefined) {
      found.push({
        id: "config.calendars-collection",
        severity: "error",
        message: `The calendar "${name}" lists the collection "${calendar.collection}", which the site does not have.`,
        pos: at(["calendars", name, "collection"]),
        help: "Name a collection the config declares.",
      });
      continue;
    }
    const dates = collection.dates ?? [];
    calendar.events.forEach((event, index) => {
      for (const key of ["field", "end"] as const) {
        const field = event[key];
        if (field === undefined || dates.includes(field)) continue;
        found.push({
          id: "config.calendars-date-field",
          severity: "error",
          message: `The calendar "${name}" takes the event "${event.name}" from "${field}", which is not one of the dates of the collection "${calendar.collection}".`,
          pos: eventPos(doc, file, lineCounter, name, index, key),
          help: `List "${field}" under dates in the collection, or name a date field.`,
        });
      }
    });
  }
  return found;
}

function eventPos(doc: Document.Parsed, file: string, lineCounter: LineCounter, name: string, index: number, key: string) {
  const node = doc.getIn(["calendars", name, "events", index, key], true);
  return posFromNode(file, lineCounter, isNode(node) ? node : doc.contents);
}

/**
 * Findings about derived rules the schema cannot see: a rule must read a field the collection declares as a date, and its
 * bands must be in increasing `below` order with only the last one open.
 */
function derivedDiagnostics(
  raw: Record<string, unknown>,
  collections: Readonly<Record<string, CollectionConfig>>,
  file: string,
  doc: Document.Parsed,
  lineCounter: LineCounter,
): Diagnostic[] {
  const found: Diagnostic[] = [];
  const at = (path: (string | number)[]) => {
    const node = doc.getIn(path, true);
    return posFromNode(file, lineCounter, isNode(node) ? node : doc.contents);
  };
  for (const [name, entry] of Object.entries((raw.collections as Record<string, unknown> | undefined) ?? {})) {
    if (!isPlainObject(entry) || !isPlainObject(entry.derived)) continue;
    const collection = collections[name];
    if (collection === undefined) continue;
    const dates = collection.dates ?? [];
    for (const [rule, value] of Object.entries(entry.derived)) {
      if (!isPlainObject(value) || typeof value.field !== "string") continue;
      if (!dates.includes(value.field)) {
        found.push({
          id: "config.derived-date-field",
          severity: "error",
          message: `The derived value "${rule}" of "${name}" reads "${value.field}", which is not one of the dates of the collection.`,
          pos: at(["collections", name, "derived", rule, "field"]),
          help: `List "${value.field}" under dates in the collection, or read a date field.`,
        });
      }
      if (!Array.isArray(value.bands)) continue;
      const bands = value.bands;
      let previous: number | undefined;
      bands.forEach((band, index) => {
        if (!isPlainObject(band)) return;
        const last = index === bands.length - 1;
        const below = typeof band.below === "number" ? band.below : undefined;
        if (last && below !== undefined) {
          found.push({
            id: "config.derived-bands",
            severity: "error",
            message: `The last band of the derived value "${rule}" of "${name}" must leave \`below\` out.`,
            pos: at(["collections", name, "derived", rule, "bands", index, "below"]),
            help: "Remove `below` from the last band so it takes every count the earlier bands did not.",
          });
        } else if (!last && below === undefined) {
          found.push({
            id: "config.derived-bands",
            severity: "error",
            message: `Every band of the derived value "${rule}" of "${name}" but the last needs a \`below\`.`,
            pos: at(["collections", name, "derived", rule, "bands", index]),
            help: "Add `below`, or move this band last and leave its `below` out.",
          });
        }
        if (below !== undefined && previous !== undefined && below <= previous) {
          found.push({
            id: "config.derived-bands",
            severity: "error",
            message: `The bands of the derived value "${rule}" of "${name}" must be in increasing \`below\` order.`,
            pos: at(["collections", name, "derived", rule, "bands", index, "below"]),
            help: "Put the smaller `below` first; the last band has no `below`.",
          });
        }
        previous = below;
      });
    }
  }
  return found;
}

/** Findings about a paginated API the schema cannot see: a mode that lacks what it needs, or a source it cannot read. */
function apiFetchDiagnostics(
  raw: Record<string, unknown>,
  collections: Readonly<Record<string, CollectionConfig>>,
  file: string,
  doc: Document.Parsed,
  lineCounter: LineCounter,
): Diagnostic[] {
  const found: Diagnostic[] = [];
  const at = (path: (string | number)[]) => {
    const pair = getMapPair(doc, path);
    return posFromNode(file, lineCounter, isNode(pair?.value) ? pair.value : doc.contents);
  };
  for (const [name, entry] of Object.entries(raw.collections ?? {})) {
    if (!isPlainObject(entry)) continue;
    const collection = collections[name];
    const pagination = collection?.pagination;
    const isUrl = typeof entry.source === "string" && /^https?:\/\//i.test(entry.source);
    if (typeof entry.records === "string" && entry.records !== "" && !isUrl) {
      found.push({
        id: "config.api-source",
        severity: "error",
        message: `Collection "${name}" names a record array, so its source must be an http or https URL.`,
        pos: at(["collections", name, "source"]),
        help: "Point `source` at the API, or remove `records`.",
      });
    }
    if (pagination === undefined) continue;
    if (!isUrl) {
      found.push({
        id: "config.api-source",
        severity: "error",
        message: `Collection "${name}" sets pagination, so its source must be an https URL.`,
        pos: at(["collections", name, "source"]),
        help: "Point `source` at the API, or remove `pagination`.",
      });
    }
    if (collection?.records === undefined) {
      found.push({
        id: "config.api-records",
        severity: "error",
        message: `Collection "${name}" sets pagination, which needs \`records\`: the dot path of the record array in each response.`,
        pos: at(["collections", name, "pagination"]),
        help: "Add `records: data.items`, or remove `pagination` for a single request.",
      });
    }
    if ((pagination.mode === "page" || pagination.mode === "offset") && pagination.stop === undefined) {
      found.push({
        id: "config.api-stop",
        severity: "error",
        message: `Collection "${name}" uses ${pagination.mode} pagination without a \`stop\` condition.`,
        pos: at(["collections", name, "pagination"]),
        help: "Set `stop: empty` to end on an empty page, or `stop: short` with `pageSize`.",
      });
    }
    if (pagination.stop === "short" && pagination.pageSize === undefined) {
      found.push({
        id: "config.api-page-size",
        severity: "error",
        message: `Collection "${name}" stops on a short page without a \`pageSize\` to compare against.`,
        pos: at(["collections", name, "pagination"]),
        help: "Set `pageSize` to the number of records the service returns per page.",
      });
    }
    if (pagination.mode === "cursor" && pagination.cursor === undefined) {
      found.push({
        id: "config.api-cursor",
        severity: "error",
        message: `Collection "${name}" uses cursor pagination without a \`cursor\` path.`,
        pos: at(["collections", name, "pagination"]),
        help: "Set `cursor` to the dot path that holds the next cursor, such as `meta.next`.",
      });
    }
    if (pagination.mode === "next" && pagination.next === undefined) {
      found.push({
        id: "config.api-next",
        severity: "error",
        message: `Collection "${name}" follows next-page URLs without a \`next\` path.`,
        pos: at(["collections", name, "pagination"]),
        help: "Set `next` to the dot path that holds the next page URL, such as `links.next`.",
      });
    }
  }
  return found;
}

function applyDefaults(raw: Record<string, unknown>, folderTitle: string): SiteConfig {
  const lang = typeof raw.lang === "string" && raw.lang.length >= 2 ? raw.lang : "en";
  const dir: Direction =
    raw.dir === "ltr" || raw.dir === "rtl" ? raw.dir : directionFromLang(lang);

  const repository = repositoryFrom(raw.repository);
  const search = searchFrom(raw.search);
  const examples = examplesFrom(raw.examples);
  const analytics = analyticsFrom(raw.analytics);
  const verify = verifyFrom(raw.verify);
  const network = networkFrom(raw.network);
  const snapshot = snapshotFrom(raw.snapshot);
  const quality = qualityFrom(raw.quality);
  const api = apiFrom(raw.api);
  const apiReference = apiReferenceFrom(raw.apiReference);
  const blog = blogFrom(raw.blog);
  const dates = datesFrom(raw.dates);  const social = socialFrom(raw.social);
  const stale = staleFrom(raw.stale);
  const drift = driftFrom(raw.drift);
  const theme: ThemeConfig = isPlainObject(raw.theme) ? (raw.theme as ThemeConfig) : {};

  return {
    title: typeof raw.title === "string" ? raw.title : folderTitle,
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    ...(typeof raw.url === "string" ? { url: raw.url } : {}),
    base: typeof raw.base === "string" ? raw.base : "",
    lang,
    dir,
    languages: Array.isArray(raw.languages) ? (raw.languages as LanguageConfig[]) : [],
    source: typeof raw.source === "string" && raw.source.length > 0 ? raw.source : ".",
    include: Array.isArray(raw.include) ? (raw.include as string[]) : [],
    exclude: Array.isArray(raw.exclude) ? (raw.exclude as string[]) : [],
    navigation:
      typeof raw.navigation === "string" && raw.navigation.length > 0
        ? raw.navigation
        : "_data/navigation.yml",
    collections: collectionsFrom(raw.collections),
    feeds: feedsFrom(raw.feeds),
    calendars: calendarsFrom(raw.calendars),
    defaults: Array.isArray(raw.defaults) ? (raw.defaults as DefaultsEntry[]) : [],
    ...(repository === undefined ? {} : { repository }),
    theme,
    search,
    ...(examples === undefined ? {} : { examples }),
    ...(analytics === undefined ? {} : { analytics }),
    ...(verify === undefined ? {} : { verify }),
    ...(network === undefined ? {} : { network }),
    ...(typeof raw.asOf === "string" && checkAsOf(raw.asOf) === undefined ? { asOf: raw.asOf } : {}),
    ...(dates === undefined ? {} : { dates }),
    ...(snapshot === undefined ? {} : { snapshot }),
    ...(quality === undefined ? {} : { quality }),
    ...(api === undefined ? {} : { api }),
    ...(apiReference === undefined ? {} : { apiReference }),
    ...(blog === undefined ? {} : { blog }),
    ...(stale === undefined ? {} : { stale }),
    ...(drift === undefined ? {} : { drift }),
    ...(social === undefined ? {} : { social }),
    redirects: isPlainObject(raw.redirects) ? (raw.redirects as Record<string, string>) : {},
    outputs: isPlainObject(raw.outputs) ? (raw.outputs as Record<string, boolean>) : {},
  };
}

/** The `apiReference` block, on when `source` names a file. The schema check reports a bad shape. */
function apiReferenceFrom(value: unknown): ApiReferenceConfig | undefined {
  if (!isPlainObject(value) || typeof value.source !== "string" || value.source.trim() === "") return undefined;
  const path = typeof value.path === "string" && /^\/(?:[^./][^/]*\/)*$/.test(value.path) ? value.path : "/reference/";
  return { source: value.source.trim(), path };
}

const PROVIDERS: readonly string[] = ["goatcounter", "plausible", "umami", "cloudflare", "custom"];

/** The blog key, on when `posts` names a folder; the defaults are filled in here. The schema check reports a bad key. */
function blogFrom(value: unknown): BlogConfig | undefined {
  if (!isPlainObject(value) || typeof value.posts !== "string" || value.posts.trim() === "") return undefined;
  const oneSegment = (key: string, fallback: string): string => {
    const text = value[key];
    return typeof text === "string" && text.trim() !== "" && !/[/\\]/.test(text) ? text.trim() : fallback;
  };
  const size = value.pageSize;
  return {
    posts: value.posts.trim().replace(/^\/+|\/+$/g, ""),
    route: oneSegment("route", "blog"),
    archive: oneSegment("archive", "archive"),
    authors: typeof value.authors === "boolean" ? value.authors : true,
    feed: typeof value.feed === "boolean" ? value.feed : true,
    pageSize: typeof size === "number" && Number.isSafeInteger(size) && size >= 1 ? size : 10,
  };
}

/** The analytics key, kept only when the schema accepts it; an invalid one is reported by the schema check. */
function analyticsFrom(value: unknown): AnalyticsConfig | undefined {
  if (!isPlainObject(value) || typeof value.provider !== "string" || !PROVIDERS.includes(value.provider)) return undefined;
  const attrs = isPlainObject(value.attrs)
    ? Object.fromEntries(Object.entries(value.attrs).filter((pair): pair is [string, string] => typeof pair[1] === "string"))
    : undefined;
  return {
    provider: value.provider as AnalyticsProvider,
    ...(typeof value.site === "string" ? { site: value.site } : {}),
    ...(typeof value.host === "string" ? { host: value.host } : {}),
    ...(typeof value.src === "string" ? { src: value.src } : {}),
    ...(attrs === undefined ? {} : { attrs }),
    allowedOrigins: Array.isArray(value.allowedOrigins)
      ? value.allowedOrigins.filter((origin): origin is string => typeof origin === "string")
      : [],
  };
}

/** The examples key, keeping only a boolean `failOnFailure`; the schema check reports an invalid one. */
function examplesFrom(value: unknown): ExamplesConfig | undefined {
  if (!isPlainObject(value) || typeof value.failOnFailure !== "boolean") return undefined;
  return { failOnFailure: value.failOnFailure };
}

/** The network key, kept only when it names a source and a project; the schema check reports an invalid one. */
function networkFrom(value: unknown): NetworkConfig | undefined {
  if (!isPlainObject(value) || typeof value.source !== "string" || typeof value.project !== "string") return undefined;
  return {
    source: value.source,
    project: value.project,
    ...(typeof value.maxAgeDays === "number" && Number.isSafeInteger(value.maxAgeDays) && value.maxAgeDays > 0
      ? { maxAgeDays: value.maxAgeDays }
      : {}),
  };
}

/** The snapshot key, kept only when it holds a positive whole `maxAgeDays`; the schema check reports an invalid one. */
function snapshotFrom(value: unknown): SnapshotConfig | undefined {
  if (!isPlainObject(value)) return undefined;
  const days = value.maxAgeDays;
  return typeof days === "number" && Number.isSafeInteger(days) && days > 0 ? { maxAgeDays: days } : undefined;
}

const QUALITY_KINDS: readonly QualityRuleKind[] = ["completeness", "coverage", "count", "threshold", "outlier", "freshness"];

function qualityKind(value: unknown): QualityRuleKind | undefined {
  return QUALITY_KINDS.find((kind) => kind === value);
}

/** One quality rule the schema accepts; `undefined` for an entry it rejects. */
function qualityRuleFrom(value: unknown): QualityRule | undefined {
  if (!isPlainObject(value)) return undefined;
  const kind = qualityKind(value.kind);
  if (kind === undefined || typeof value.collection !== "string" || value.collection === "") return undefined;
  const fields = Array.isArray(value.fields)
    ? value.fields.filter((field): field is string => typeof field === "string" && field !== "")
    : undefined;
  const maxDrop = value.maxDrop;
  const maxAgeDays = value.maxAgeDays;
  const bound = (entry: unknown): number | undefined =>
    typeof entry === "number" && Number.isFinite(entry) ? entry : undefined;
  const min = bound(value.min);
  const max = bound(value.max);
  const severity = value.severity === "warning" || value.severity === "error" ? value.severity : undefined;
  return {
    kind,
    collection: value.collection,
    ...(fields === undefined || fields.length === 0 ? {} : { fields }),
    ...(typeof value.field === "string" && value.field !== "" ? { field: value.field } : {}),
    ...(isPlainObject(value.where) ? { where: value.where } : {}),
    ...(severity === undefined ? {} : { severity }),
    ...(typeof maxDrop === "number" && Number.isSafeInteger(maxDrop) && maxDrop >= 0 ? { maxDrop } : {}),
    ...(typeof maxAgeDays === "number" && Number.isSafeInteger(maxAgeDays) && maxAgeDays > 0 ? { maxAgeDays } : {}),
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
  };
}

/** One exception the schema accepts; `undefined` for an entry it rejects. */
function qualityExceptionFrom(value: unknown): QualityException | undefined {
  if (!isPlainObject(value) || typeof value.reason !== "string" || value.reason === "") return undefined;
  const kind = qualityKind(value.rule);
  if (kind === undefined) return undefined;
  return {
    rule: kind,
    ...(typeof value.record === "string" && value.record !== "" ? { record: value.record } : {}),
    ...(typeof value.field === "string" && value.field !== "" ? { field: value.field } : {}),
    reason: value.reason,
    ...(typeof value.until === "string" && checkAsOf(value.until) === undefined ? { until: value.until } : {}),
  };
}

/** The quality key, keeping only the rules, exceptions, and policy the schema accepts. */
function qualityFrom(value: unknown): QualityConfig | undefined {
  if (!isPlainObject(value)) return undefined;
  const rules = Array.isArray(value.rules)
    ? value.rules.map(qualityRuleFrom).filter((rule): rule is QualityRule => rule !== undefined)
    : [];
  const exceptions = Array.isArray(value.exceptions)
    ? value.exceptions.map(qualityExceptionFrom).filter((entry): entry is QualityException => entry !== undefined)
    : [];
  const policy: Partial<Record<QualityRuleKind, "warning" | "error">> = {};
  if (isPlainObject(value.policy)) {
    for (const kind of QUALITY_KINDS) {
      const severity = value.policy[kind];
      if (severity === "warning" || severity === "error") policy[kind] = severity;
    }
  }
  return { rules, exceptions, policy };
}

/** The collections of an api block, keeping only the entries the schema accepts. */
function apiCollectionsFrom(value: unknown): Record<string, ApiCollectionConfig> {
  const collections: Record<string, ApiCollectionConfig> = {};
  if (!isPlainObject(value)) return collections;
  for (const [name, entry] of Object.entries(value)) {
    if (!isPlainObject(entry) || !Array.isArray(entry.fields)) continue;
    const fields = entry.fields.filter((field): field is string => typeof field === "string" && field !== "");
    collections[name] = { fields, ...(typeof entry.id === "string" && entry.id !== "" ? { id: entry.id } : {}) };
  }
  return collections;
}

/** The api key, keeping only the collections the schema accepts; `undefined` when the site sets none. `version` defaults to `v1`. */
export function apiFrom(value: unknown): ApiConfig | undefined {
  if (!isPlainObject(value) || !isPlainObject(value.collections)) return undefined;
  const collections = apiCollectionsFrom(value.collections);
  const version = typeof value.version === "string" && /^v[1-9][0-9]*$/.test(value.version) ? value.version : "v1";
  const versions: Record<string, ApiVersionConfig> = {};
  if (isPlainObject(value.versions)) {
    for (const [name, entry] of Object.entries(value.versions)) {
      if (!/^v[1-9][0-9]*$/.test(name) || !isPlainObject(entry) || !isPlainObject(entry.collections)) continue;
      versions[name] = {
        collections: apiCollectionsFrom(entry.collections),
        ...(entry.deprecated === true ? { deprecated: true } : {}),
        ...(typeof entry.sunset === "string" ? { sunset: entry.sunset } : {}),
        ...(typeof entry.successor === "string" ? { successor: entry.successor } : {}),
      };
    }
  }
  return {
    version,
    collections,
    ...(value.headers === true ? { headers: true } : {}),
    ...(typeof value.maxFileBytes === "number" && Number.isSafeInteger(value.maxFileBytes) && value.maxFileBytes > 0 ? { maxFileBytes: value.maxFileBytes } : {}),
    ...(Object.keys(versions).length === 0 ? {} : { versions }),
  };
}

/** The dates key, kept only with a calendar the schema accepts. */
function datesFrom(value: unknown): DatesConfig | undefined {
  if (!isPlainObject(value)) return undefined;
  return value.calendar === "gregorian" || value.calendar === "jalali" ? { calendar: value.calendar } : undefined;
}

/** The stale key, keeping a string `root` and a known `severity`; the schema check reports an invalid one. */
function staleFrom(value: unknown): StaleConfig | undefined {
  if (!isPlainObject(value)) return undefined;
  const severity = value.severity;
  const out: { root?: string; severity?: "info" | "warning" | "error" } = {};
  if (typeof value.root === "string" && value.root !== "") out.root = value.root;
  if (severity === "info" || severity === "warning" || severity === "error") out.severity = severity;
  return Object.keys(out).length === 0 ? undefined : out;
}

/** The drift key, keeping a known `severity`; the schema check reports an invalid one. */
function driftFrom(value: unknown): DriftConfig | undefined {
  if (!isPlainObject(value)) return undefined;
  const severity = value.severity;
  return severity === "info" || severity === "warning" || severity === "error" ? { severity } : undefined;
}

/** The verify key, keeping only string values; `undefined` when none is set. */
function verifyFrom(value: unknown): VerifyConfig | undefined {
  if (!isPlainObject(value)) return undefined;
  const out: Record<string, string> = {};
  for (const key of ["google", "bing", "googleFile", "bingFile"]) {
    const entry = value[key];
    if (typeof entry === "string") out[key] = entry;
  }
  return Object.keys(out).length === 0 ? undefined : (out as VerifyConfig);
}

/** The social key: an object turns generated images on, with its template and font files when it names them. */
function socialFrom(value: unknown): SocialConfig | undefined {
  if (!isPlainObject(value)) return undefined;
  return {
    ...(typeof value.template === "string" ? { template: value.template } : {}),
    fonts: Array.isArray(value.fonts) ? value.fonts.filter((font): font is string => typeof font === "string") : [],
  };
}

function repositoryFrom(value: unknown): RepositoryConfig | undefined {
  if (!isPlainObject(value) || typeof value.url !== "string") return undefined;
  return {
    url: value.url,
    branch: typeof value.branch === "string" && value.branch.length > 0 ? value.branch : "main",
    dir: typeof value.dir === "string" ? value.dir : "",
  };
}

function searchFrom(value: unknown): false | SearchConfig {
  if (value === false) return false;
  if (!isPlainObject(value)) return {};
  return typeof value.text === "number" ? { text: value.text } : {};
}

function collectionsFrom(value: unknown): Readonly<Record<string, CollectionConfig>> {
  if (!isPlainObject(value)) return {};
  const collections: Record<string, CollectionConfig> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!isPlainObject(entry) || typeof entry.source !== "string") continue;
    const unique = fieldsFrom(entry.unique);
    const references = stringMapFrom(entry.references);
    const renames = stringMapFrom(entry.schemaRenames);
    const dates = fieldsFrom(entry.dates);
    const views = viewsFrom(entry.views);
    const search = collectionSearchFrom(entry.search);
    const seo = collectionSeoFrom(entry.seo);
    const index = collectionIndexFrom(entry.index);
    const onRemoved = onRemovedFrom(entry.onRemoved);
    const lifecycle = lifecycleFrom(entry.lifecycle);
    const json = collectionJsonFrom(entry.json);
    const raw = collectionRawFrom(entry.raw);
    const changelog = collectionChangelogFrom(entry.changelog);
    const transform = collectionTransformFrom(entry.transform);
    const derived = derivedFrom(entry.derived);
    const pagination = paginationFrom(entry.pagination);
    collections[name] = {
      source: entry.source,
      ...(typeof entry.records === "string" && entry.records !== "" ? { records: entry.records } : {}),
      ...(pagination === undefined ? {} : { pagination }),
      ...(typeof entry.id === "string" ? { id: entry.id } : {}),
      ...(typeof entry.template === "string" ? { template: entry.template } : {}),
      ...(typeof entry.permalink === "string" ? { permalink: entry.permalink } : {}),
      ...(typeof entry.disambiguate === "string" ? { disambiguate: entry.disambiguate } : {}),
      ...(typeof entry.aliases === "string" ? { aliases: entry.aliases } : {}),
      ...(typeof entry.schema === "string" ? { schema: entry.schema } : {}),
      ...(renames === undefined ? {} : { schemaRenames: renames }),
      ...(entry.onSchemaChange === "error" || entry.onSchemaChange === "warn" ? { onSchemaChange: entry.onSchemaChange } : {}),
      ...(unique === undefined ? {} : { unique }),
      ...(references === undefined ? {} : { references }),
      ...(dates === undefined ? {} : { dates }),
      ...(derived === undefined ? {} : { derived }),
      ...(typeof entry.referenceDate === "string" ? { referenceDate: entry.referenceDate } : {}),
      ...(isPlainObject(entry) && Array.isArray(entry.markdown)
        ? { markdown: entry.markdown.filter((field): field is string => typeof field === "string") }
        : {}),
      ...(isPlainObject(entry) && typeof entry.llms === "boolean" ? { llms: entry.llms } : {}),
      ...(json === undefined ? {} : { json }),
      ...(typeof entry.evidence === "string" ? { evidence: entry.evidence } : {}),
      ...(entry.onInvalid === "error" || entry.onInvalid === "skip" ? { onInvalid: entry.onInvalid } : {}),
      ...(onRemoved === undefined ? {} : { onRemoved }),
      ...(lifecycle === undefined ? {} : { lifecycle }),
      ...(isPlainObject(entry.limits) ? { limits: limitsFrom(entry.limits) } : {}),
      ...(views === undefined ? {} : { views }),
      ...(search === undefined ? {} : { search }),
      ...(seo === undefined ? {} : { seo }),
      ...(index === undefined ? {} : { index }),
      ...(raw === undefined ? {} : { raw }),
      ...(changelog === undefined ? {} : { changelog }),
      ...(transform === undefined ? {} : { transform }),
    };
  }
  return collections;
}

/** A collection's derived rules, keeping only rules the schema accepts. `undefined` when it declares none. */
function derivedFrom(value: unknown): Readonly<Record<string, DerivedRuleConfig>> | undefined {
  if (!isPlainObject(value)) return undefined;
  const rules: Record<string, DerivedRuleConfig> = {};
  for (const [name, rule] of Object.entries(value)) {
    if (!isPlainObject(rule) || typeof rule.field !== "string" || rule.field === "") continue;
    if (rule.kind === "days-left" || rule.kind === "days-since") {
      rules[name] = { field: rule.field, kind: rule.kind };
      continue;
    }
    if (!Array.isArray(rule.bands)) continue;
    const bands: DerivedBandConfig[] = [];
    for (const band of rule.bands) {
      if (!isPlainObject(band) || band.value === undefined) continue;
      const value = band.value;
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") continue;
      bands.push({
        ...(typeof band.below === "number" && Number.isFinite(band.below) ? { below: band.below } : {}),
        value,
      });
    }
    if (bands.length > 0) rules[name] = { field: rule.field, bands };
  }
  return Object.keys(rules).length === 0 ? undefined : rules;
}

/** A collection's page JSON settings, keeping only the fields the schema accepts. `undefined` when it sets none. */
function collectionJsonFrom(value: unknown): CollectionJsonConfig | undefined {  if (!isPlainObject(value) || !Array.isArray(value.fields)) return undefined;
  return { fields: value.fields.filter((field): field is string => typeof field === "string") };
}

/** The declared feeds, keeping only entries the schema accepts, with their defaults left to the writer. */
function feedsFrom(value: unknown): Readonly<Record<string, FeedConfig>> {
  if (!isPlainObject(value)) return {};
  const feeds: Record<string, FeedConfig> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!isPlainObject(entry) || typeof entry.collection !== "string" || typeof entry.date !== "string") continue;
    const where = isPlainObject(entry.where) ? entry.where : undefined;
    const formats = Array.isArray(entry.formats)
      ? entry.formats.filter((format): format is FeedFormat => format === "atom" || format === "rss" || format === "json")
      : undefined;
    const days = isPlainObject(entry.window) ? entry.window.days : undefined;
    feeds[name] = {
      collection: entry.collection,
      ...(where === undefined ? {} : { where }),
      date: entry.date,
      ...(typeof entry.limit === "number" && Number.isSafeInteger(entry.limit) && entry.limit > 0 ? { limit: entry.limit } : {}),
      ...(typeof entry.title === "string" ? { title: entry.title } : {}),
      ...(formats === undefined ? {} : { formats }),
      ...(typeof entry.idField === "string" ? { idField: entry.idField } : {}),
      ...(Array.isArray(entry.fields)
        ? { fields: entry.fields.filter((field): field is string => typeof field === "string") }
        : {}),
      ...(typeof days === "number" && Number.isSafeInteger(days) && days >= 0 ? { window: { days } } : {}),
    };
  }
  return feeds;
}

/** The declared calendars, keeping only entries the schema accepts. */
function calendarsFrom(value: unknown): Readonly<Record<string, CalendarConfig>> {
  if (!isPlainObject(value)) return {};
  const calendars: Record<string, CalendarConfig> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!isPlainObject(entry) || typeof entry.collection !== "string" || !Array.isArray(entry.events)) continue;
    const events: CalendarEventConfig[] = [];
    for (const item of entry.events) {
      if (!isPlainObject(item) || typeof item.name !== "string" || typeof item.field !== "string") continue;
      events.push({
        name: item.name,
        field: item.field,
        ...(typeof item.end === "string" ? { end: item.end } : {}),
        ...(typeof item.title === "string" ? { title: item.title } : {}),
      });
    }
    if (events.length === 0) continue;
    const where = isPlainObject(entry.where) ? entry.where : undefined;
    calendars[name] = {
      collection: entry.collection,
      ...(where === undefined ? {} : { where }),
      events,
      ...(Array.isArray(entry.reminders)
        ? { reminders: entry.reminders.filter((r): r is string => typeof r === "string") }
        : {}),
      ...(typeof entry.groupBy === "string" ? { groupBy: entry.groupBy } : {}),
      ...(typeof entry.limit === "number" && Number.isSafeInteger(entry.limit) && entry.limit > 0 ? { limit: entry.limit } : {}),
    };
  }
  return calendars;
}

/** A collection's search settings, keeping only the keys the schema accepts. `undefined` when it sets none. */
function collectionSearchFrom(value: unknown): CollectionSearchConfig | undefined {
  if (!isPlainObject(value)) return undefined;
  const meta = fieldsFrom(value.meta);
  const filters = fieldsFrom(value.filters);
  const sort = fieldsFrom(value.sort);
  const search: CollectionSearchConfig = {
    ...(meta === undefined ? {} : { meta }),
    ...(filters === undefined ? {} : { filters }),
    ...(sort === undefined ? {} : { sort }),
    ...(typeof value.aliases === "string" ? { aliases: value.aliases } : {}),
  };
  return Object.keys(search).length === 0 ? undefined : search;
}

/** A collection's SEO settings, keeping only the keys the schema accepts. `undefined` when it sets none. */
function collectionSeoFrom(value: unknown): CollectionSeoConfig | undefined {
  if (!isPlainObject(value)) return undefined;
  const count = (key: string): number | undefined => {
    const n = value[key];
    return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : undefined;
  };
  const text = (key: string): string | undefined => {
    const t = value[key];
    return typeof t === "string" && t !== "" ? t : undefined;
  };
  const titleMax = count("titleMax");
  const descriptionMax = count("descriptionMax");
  const canonical = text("canonical");
  const noindex = text("noindex");
  const lastmod = text("lastmod");
  const seo: CollectionSeoConfig = {
    ...(titleMax === undefined ? {} : { titleMax }),
    ...(descriptionMax === undefined ? {} : { descriptionMax }),
    ...(canonical === undefined ? {} : { canonical }),
    ...(noindex === undefined ? {} : { noindex }),
    ...(lastmod === undefined ? {} : { lastmod }),
    ...(isPlainObject(value.jsonLd) ? { jsonLd: value.jsonLd } : {}),
    ...(typeof value.breadcrumbs === "boolean" ? { breadcrumbs: value.breadcrumbs } : {}),
    ...(typeof value.itemList === "boolean" ? { itemList: value.itemList } : {}),
  };
  return Object.keys(seo).length === 0 ? undefined : seo;
}

/** A collection's compact index settings; `undefined` when it names no fields. */
function collectionIndexFrom(value: unknown): CollectionIndexConfig | undefined {
  if (!isPlainObject(value)) return undefined;
  const fields = fieldsFrom(value.fields);
  if (fields === undefined || fields.length === 0) return undefined;
  return {
    fields,
    ...(typeof value.bytes === "number" && Number.isSafeInteger(value.bytes) && value.bytes > 0
      ? { bytes: value.bytes }
      : {}),
  };
}

/** `raw` as the contract holds it: `false`, or the private fields; `undefined` when unset. */
function collectionRawFrom(value: unknown): false | CollectionRawConfig | undefined {
  if (value === false) return false;
  if (!isPlainObject(value)) return undefined;
  const hidden = fieldsFrom(value.private);
  return hidden === undefined ? {} : { private: hidden };
}

const CHANGELOG_TYPES = ["added", "removed", "changed", "renamed", "imported"] as const;

/** A collection's changelog settings, keeping only what the schema accepts. */
function collectionChangelogFrom(value: unknown): CollectionChangelogConfig | undefined {
  if (!isPlainObject(value)) return undefined;
  const track = fieldsFrom(value.track);
  const ignore = fieldsFrom(value.ignore);
  const labels: Partial<Record<(typeof CHANGELOG_TYPES)[number], string>> = {};
  if (isPlainObject(value.labels)) {
    for (const type of CHANGELOG_TYPES) {
      const text = value.labels[type];
      if (typeof text === "string" && text !== "") labels[type] = text;
    }
  }
  const threshold = value.importThreshold;
  return {
    ...(track === undefined ? {} : { track }),
    ...(ignore === undefined ? {} : { ignore }),
    ...(Object.keys(labels).length === 0 ? {} : { labels }),
    ...(typeof threshold === "number" && Number.isSafeInteger(threshold) && threshold >= 1 ? { importThreshold: threshold } : {}),
    ...(typeof value.pages === "boolean" ? { pages: value.pages } : {}),
  };
}

/** A non-empty list of field paths, or `undefined` when the key is not such a list. */
function pathsFrom(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const paths = value.filter((entry): entry is string => typeof entry === "string" && entry !== "");
  return paths.length === 0 ? undefined : paths;
}

/** A plain own-key copy of a mapping of values, or `undefined` when the key is not a mapping. */
function mappingFrom(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!isPlainObject(value)) return undefined;
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    Object.defineProperty(copy, key, { value: value[key], writable: true, enumerable: true, configurable: true });
  }
  return copy;
}

/** One transformation step, keeping only the keys its operator reads; `undefined` when the step names no usable operator. */
function transformStepFrom(value: unknown): TransformStepConfig | undefined {
  if (!isPlainObject(value) || typeof value.op !== "string") return undefined;
  const id = typeof value.id === "string" && value.id !== "" ? { id: value.id } : {};
  switch (value.op) {
    case "select": {
      const fields = pathsFrom(value.fields);
      return fields === undefined ? undefined : { ...id, op: "select", fields };
    }
    case "remove": {
      const fields = pathsFrom(value.fields);
      return fields === undefined ? undefined : { ...id, op: "remove", fields };
    }
    case "rename": {
      if (typeof value.from !== "string" || value.from === "" || typeof value.to !== "string" || value.to === "") return undefined;
      return {
        ...id,
        op: "rename",
        from: value.from,
        to: value.to,
        ...(value.onConflict === "overwrite" ? { onConflict: "overwrite" as const } : {}),
      };
    }
    case "default": {
      if (typeof value.field !== "string" || value.field === "" || !Object.hasOwn(value, "value")) return undefined;
      const when = value.when;
      return {
        ...id,
        op: "default",
        field: value.field,
        value: value.value,
        ...(when === null || when === "null" || when === "missing-or-null" ? { when: when === null ? ("null" as const) : when } : {}),
      };
    }
    case "cast": {
      const target = value.to;
      const to: TransformCastTarget | undefined =
        target === "string" || target === "number" || target === "integer" || target === "boolean" ? target : undefined;
      if (typeof value.field !== "string" || value.field === "" || to === undefined) return undefined;
      return { ...id, op: "cast", field: value.field, to };
    }
    case "normalize": {
      if (typeof value.field !== "string" || value.field === "") return undefined;
      return {
        ...id,
        op: "normalize",
        field: value.field,
        ...(typeof value.trim === "boolean" ? { trim: value.trim } : {}),
        ...(value.case === "lower" || value.case === "upper" || value.case === "none" ? { case: value.case } : {}),
      };
    }
    case "map": {
      const values = mappingFrom(value.values);
      if (typeof value.field !== "string" || value.field === "" || values === undefined) return undefined;
      return {
        ...id,
        op: "map",
        field: value.field,
        values,
        ...(value.unknown === "error" || value.unknown === "default" || value.unknown === "keep" ? { unknown: value.unknown } : {}),
        ...(Object.hasOwn(value, "default") ? { default: value.default } : {}),
      };
    }
    case "date": {
      if (typeof value.field !== "string" || value.field === "" || typeof value.format !== "string" || typeof value.timezone !== "string") {
        return undefined;
      }
      return {
        ...id,
        op: "date",
        field: value.field,
        format: value.format,
        timezone: value.timezone,
        ...(value.output === "date" ? { output: "date" as const } : {}),
      };
    }
    case "unit": {
      if (typeof value.field !== "string" || value.field === "" || typeof value.factor !== "number" || !Number.isFinite(value.factor)) return undefined;
      const round = value.round;
      return {
        ...id,
        op: "unit",
        field: value.field,
        factor: value.factor,
        ...(typeof round === "number" && Number.isInteger(round) && round >= 0 && round <= 10 ? { round } : {}),
      };
    }
    case "filter": {
      const where = mappingFrom(value.where);
      return where === undefined ? undefined : { ...id, op: "filter", where };
    }
    case "dedupe": {
      const by = pathsFrom(value.by);
      if (by === undefined) return undefined;
      return { ...id, op: "dedupe", by, ...(value.keep === "last" ? { keep: "last" as const } : {}) };
    }
    default:
      return undefined;
  }
}

/** A collection's transformation rules, keeping only steps the schema accepts; `undefined` when it declares none. */
function collectionTransformFrom(value: unknown): CollectionTransformConfig | undefined {
  if (!isPlainObject(value) || !Array.isArray(value.steps)) return undefined;
  const steps: TransformStepConfig[] = [];
  for (const raw of value.steps) {
    const step = transformStepFrom(raw);
    if (step !== undefined) steps.push(step);
  }
  if (steps.length === 0) return undefined;
  return {
    ...(value.validate === "before-and-after" ? { validate: "before-and-after" as const } : {}),
    steps,
  };
}

/** A collection's `lifecycle` block as the contract holds it; absent when it declares none. */
function lifecycleFrom(value: unknown): CollectionLifecycleConfig | undefined {
  if (!isPlainObject(value)) return undefined;
  const strings = (raw: unknown): readonly string[] | undefined =>
    Array.isArray(raw) && raw.every((entry): entry is string => typeof entry === "string") ? raw : undefined;
  const states = strings(value.states);
  const retired = strings(value.retired);
  return {
    ...(typeof value.field === "string" && value.field !== "" ? { field: value.field } : {}),
    ...(states === undefined ? {} : { states }),
    ...(retired === undefined ? {} : { retired }),
    ...(typeof value.replacement === "string" && value.replacement !== ""
      ? { replacement: value.replacement }
      : {}),
    ...(value.url === "retain" || value.url === "redirect" ? { url: value.url } : {}),
    ...(typeof value.machine === "boolean" ? { machine: value.machine } : {}),
  };
}

/** `onRemoved` as the contract holds it: one of the words, or a redirect to a safe site path. */
function onRemovedFrom(value: unknown): CollectionConfig["onRemoved"] | undefined {
  if (value === "error" || value === "gone") return value;
  if (!isPlainObject(value) || typeof value.redirect !== "string") return undefined;
  return value.redirect.startsWith("/") ? { redirect: value.redirect } : undefined;
}

/** The named views of one collection, keeping only those that name a template and a URL pattern. */
function viewsFrom(value: unknown): Readonly<Record<string, CollectionViewConfig>> | undefined {
  if (!isPlainObject(value)) return undefined;
  const views: Record<string, CollectionViewConfig> = {};
  for (const [name, view] of Object.entries(value)) {
    if (!isPlainObject(view) || typeof view.template !== "string" || typeof view.permalink !== "string") continue;
    views[name] = {
      template: view.template,
      permalink: view.permalink,
      ...(typeof view.layout === "string" ? { layout: view.layout } : {}),
    };
  }
  return views;
}

/** A list of field names, keeping only the strings; `undefined` when the key is not a list. */
function fieldsFrom(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((field): field is string => typeof field === "string");
}

/** A mapping of one name to another, keeping only string values; `undefined` when the key is not a mapping. */
function stringMapFrom(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!isPlainObject(value)) return undefined;
  const references: Record<string, string> = {};
  for (const [field, collection] of Object.entries(value)) {
    if (typeof collection === "string") references[field] = collection;
  }
  return references;
}

/** A collection's `pagination` block as the contract holds it; `undefined` when it declares none. */
function paginationFrom(value: unknown): PaginationConfig | undefined {
  if (!isPlainObject(value)) return undefined;
  const mode = value.mode;
  if (mode !== "page" && mode !== "offset" && mode !== "cursor" && mode !== "next") return undefined;
  const auth = authFrom(value.auth);
  const origins = Array.isArray(value.origins)
    ? value.origins.filter((origin): origin is string => typeof origin === "string" && origin !== "")
    : undefined;
  return {
    mode: mode as PaginationMode,
    ...(typeof value.param === "string" && value.param !== "" ? { param: value.param } : {}),
    ...(countFrom(value.start) === undefined ? {} : { start: countFrom(value.start)! }),
    ...(countFrom(value.pageSize) === undefined ? {} : { pageSize: countFrom(value.pageSize)! }),
    ...(value.stop === "empty" || value.stop === "short" ? { stop: value.stop as PaginationStop } : {}),
    ...(typeof value.cursor === "string" && value.cursor !== "" ? { cursor: value.cursor } : {}),
    ...(typeof value.next === "string" && value.next !== "" ? { next: value.next } : {}),
    ...(origins === undefined || origins.length === 0 ? {} : { origins }),
    ...(auth === undefined ? {} : { auth }),
    ...(countFrom(value.maxPages) === undefined ? {} : { maxPages: countFrom(value.maxPages)! }),
    ...(countFrom(value.maxBytes) === undefined ? {} : { maxBytes: countFrom(value.maxBytes)! }),
    ...(countFrom(value.retries) === undefined ? {} : { retries: countFrom(value.retries)! }),
  };
}

/** A non-negative whole number a pagination key may hold; `undefined` for anything else. */
function countFrom(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** The auth block, read from the schema-checked value; `undefined` when it names no environment variable. */
function authFrom(value: unknown): ApiAuthConfig | undefined {
  if (!isPlainObject(value) || typeof value.env !== "string" || value.env === "") return undefined;
  return {
    env: value.env,
    ...(typeof value.header === "string" && value.header !== "" ? { header: value.header } : {}),
    ...(typeof value.prefix === "string" ? { prefix: value.prefix } : {}),
  };
}

/** Reads the three numeric limits a collection may set; a bad value falls back to the default. */
function limitsFrom(value: Record<string, unknown>): NonNullable<CollectionConfig["limits"]> {
  const limit = (key: string): number | undefined => {
    const raw = value[key];
    return typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0 ? raw : undefined;
  };
  const bytes = limit("bytes");
  const records = limit("records");
  const field = limit("field");
  return {
    ...(bytes === undefined ? {} : { bytes }),
    ...(records === undefined ? {} : { records }),
    ...(field === undefined ? {} : { field }),
  };
}

function isCollectionsName(error: ErrorObject): boolean {
  return error.schemaPath.startsWith("#/properties/collections/propertyNames");
}

function diagnosticFromAjv(
  error: ErrorObject,
  file: string,
  doc: Document.Parsed,
  lineCounter: LineCounter,
): Diagnostic {
  if (error.keyword === "propertyNames" && isCollectionsName(error)) {
    const key = String(error.params["propertyName"] ?? "");
    const path = [...instancePath(error.instancePath), key];
    const pair = getMapPair(doc, path);
    return {
      id: "config.invalid",
      severity: "error",
      message: `\`${path.map(String).join(".")}\` must be a name of lowercase letters, digits, and hyphens.`,
      pos: pair?.key ? posFromNode(file, lineCounter, pair.key as Node) : posFromNode(file, lineCounter, doc.contents),
      help: "Rename the key.",
    };
  }

  if (error.keyword === "additionalProperties") {
    const key = String(error.params["additionalProperty"] ?? "");
    const path = [...instancePath(error.instancePath), key];
    const pair = getMapPair(doc, path);
    const pos = pair?.key ? posFromNode(file, lineCounter, pair.key as Node) : posFromNode(file, lineCounter, doc.contents);
    return {
      id: "config.unknown-key",
      severity: "error",
      message: `Unknown key \`${key}\`.`,
      pos,
      help: "Remove it or rename it to a key in the site config schema.",
    };
  }

  const path = instancePath(error.instancePath);
  const node = path.length === 0 ? doc.contents : doc.getIn(path, true);
  const where = path.length === 0 ? "site config" : `\`${path.map(String).join(".")}\``;
  return {
    id: "config.invalid",
    severity: "error",
    message: `${where} ${error.message ?? "is invalid"}.`,
    pos: posFromNode(file, lineCounter, isNode(node) ? node : doc.contents),
  };
}

function instancePath(path: string): Array<string | number> {
  if (!path || path === "") return [];
  return path
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => (/^\d+$/.test(s) ? Number(s) : decodeURIComponent(s)));
}

function getMapPair(doc: Document.Parsed, path: Array<string | number>): Pair | undefined {
  if (path.length === 0) return undefined;
  let node: Node | null | undefined = doc.contents ?? undefined;
  for (let i = 0; i < path.length - 1; i++) {
    if (node == null) return undefined;
    if (isMap(node) || isSeq(node)) {
      node = node.get(path[i]!, true) as Node | null | undefined;
    } else {
      return undefined;
    }
  }
  if (!isMap(node)) return undefined;
  const last = path[path.length - 1]!;
  return node.items.find((item) => isScalar(item.key) && String(item.key.value) === String(last));
}

function posFromNode(file: string, lineCounter: LineCounter, node: Node | null | undefined): SourcePos {
  const range = node?.range;
  if (!range) return { file, line: 1, column: 1, endLine: 1, endColumn: 1 };
  const start = lineCounter.linePos(range[0]);
  const endOffset = Math.max(range[0], (range[2] ?? range[1]) - 1);
  const end = lineCounter.linePos(endOffset);
  return { file, line: start.line, column: start.col, endLine: end.line, endColumn: end.col };
}

function isNode(value: unknown): value is Node {
  return value != null && typeof value === "object" && "range" in value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function posixRelative(from: string, to: string): string {
  const rel = relative(from, to).replace(/\\/g, "/");
  return rel === "" ? CONFIG_FILE : rel;
}
