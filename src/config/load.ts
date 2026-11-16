import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join, relative, resolve } from "node:path";
import type { ErrorObject } from "ajv";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
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
  AnalyticsConfig,
  AnalyticsProvider,
  VerifyConfig,
  CollectionConfig,
  CollectionIndexConfig,
  CollectionRawConfig,
  CollectionJsonConfig,
  CollectionSearchConfig,
  CollectionSeoConfig,
  CollectionViewConfig,
  DefaultsEntry,
  Diagnostic,
  Direction,
  FeedConfig,
  FeedFormat,
  LanguageConfig,
  NetworkConfig,
  SnapshotConfig,
  StaleConfig,
  RepositoryConfig,
  SearchConfig,
  SiteConfig,
  SocialConfig,
  SourcePos,
  ThemeConfig,
} from "../contracts/index.ts";

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

  const collections = collectionsFrom(raw.collections);
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

  return { config: applyDefaults(raw, folderTitle), diagnostics };
}

function applyDefaults(raw: Record<string, unknown>, folderTitle: string): SiteConfig {
  const lang = typeof raw.lang === "string" && raw.lang.length >= 2 ? raw.lang : "en";
  const dir: Direction =
    raw.dir === "ltr" || raw.dir === "rtl" ? raw.dir : directionFromLang(lang);

  const repository = repositoryFrom(raw.repository);
  const search = searchFrom(raw.search);
  const analytics = analyticsFrom(raw.analytics);
  const verify = verifyFrom(raw.verify);
  const network = networkFrom(raw.network);
  const snapshot = snapshotFrom(raw.snapshot);
  const social = socialFrom(raw.social);
  const stale = staleFrom(raw.stale);
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
    defaults: Array.isArray(raw.defaults) ? (raw.defaults as DefaultsEntry[]) : [],
    ...(repository === undefined ? {} : { repository }),
    theme,
    search,
    ...(analytics === undefined ? {} : { analytics }),
    ...(verify === undefined ? {} : { verify }),
    ...(network === undefined ? {} : { network }),
    ...(snapshot === undefined ? {} : { snapshot }),
    ...(stale === undefined ? {} : { stale }),
    ...(social === undefined ? {} : { social }),
    redirects: isPlainObject(raw.redirects) ? (raw.redirects as Record<string, string>) : {},
    outputs: isPlainObject(raw.outputs) ? (raw.outputs as Record<string, boolean>) : {},
  };
}

const PROVIDERS: readonly string[] = ["goatcounter", "plausible", "umami", "cloudflare", "custom"];

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

/** The stale key, keeping a string `root` and a known `severity`; the schema check reports an invalid one. */
function staleFrom(value: unknown): StaleConfig | undefined {
  if (!isPlainObject(value)) return undefined;
  const severity = value.severity;
  const out: { root?: string; severity?: "info" | "warning" | "error" } = {};
  if (typeof value.root === "string" && value.root !== "") out.root = value.root;
  if (severity === "info" || severity === "warning" || severity === "error") out.severity = severity;
  return Object.keys(out).length === 0 ? undefined : out;
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
    const references = referencesFrom(entry.references);
    const dates = fieldsFrom(entry.dates);
    const views = viewsFrom(entry.views);
    const search = collectionSearchFrom(entry.search);
    const seo = collectionSeoFrom(entry.seo);
    const index = collectionIndexFrom(entry.index);
    const onRemoved = onRemovedFrom(entry.onRemoved);
    const json = collectionJsonFrom(entry.json);
    const raw = collectionRawFrom(entry.raw);
    collections[name] = {
      source: entry.source,
      ...(typeof entry.id === "string" ? { id: entry.id } : {}),
      ...(typeof entry.template === "string" ? { template: entry.template } : {}),
      ...(typeof entry.permalink === "string" ? { permalink: entry.permalink } : {}),
      ...(typeof entry.disambiguate === "string" ? { disambiguate: entry.disambiguate } : {}),
      ...(typeof entry.aliases === "string" ? { aliases: entry.aliases } : {}),
      ...(typeof entry.schema === "string" ? { schema: entry.schema } : {}),
      ...(unique === undefined ? {} : { unique }),
      ...(references === undefined ? {} : { references }),
      ...(dates === undefined ? {} : { dates }),
      ...(typeof entry.referenceDate === "string" ? { referenceDate: entry.referenceDate } : {}),
      ...(isPlainObject(entry) && Array.isArray(entry.markdown)
        ? { markdown: entry.markdown.filter((field): field is string => typeof field === "string") }
        : {}),
      ...(isPlainObject(entry) && typeof entry.llms === "boolean" ? { llms: entry.llms } : {}),
      ...(json === undefined ? {} : { json }),
      ...(entry.onInvalid === "error" || entry.onInvalid === "skip" ? { onInvalid: entry.onInvalid } : {}),
      ...(onRemoved === undefined ? {} : { onRemoved }),
      ...(isPlainObject(entry.limits) ? { limits: limitsFrom(entry.limits) } : {}),
      ...(views === undefined ? {} : { views }),
      ...(search === undefined ? {} : { search }),
      ...(seo === undefined ? {} : { seo }),
      ...(index === undefined ? {} : { index }),
      ...(raw === undefined ? {} : { raw }),
    };
  }
  return collections;
}

/** A collection's page JSON settings, keeping only the fields the schema accepts. `undefined` when it sets none. */
function collectionJsonFrom(value: unknown): CollectionJsonConfig | undefined {
  if (!isPlainObject(value) || !Array.isArray(value.fields)) return undefined;
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
    };
  }
  return feeds;
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

/** A field-to-collection mapping, keeping only string values; `undefined` when the key is not a mapping. */
function referencesFrom(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!isPlainObject(value)) return undefined;
  const references: Record<string, string> = {};
  for (const [field, collection] of Object.entries(value)) {
    if (typeof collection === "string") references[field] = collection;
  }
  return references;
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
