import type { Page, PageStale, Site } from "../contracts/content.ts";
import type { Output, OutputFile } from "../contracts/output.ts";
import type { FenceExampleResult } from "../contracts/code.ts";
import type { SurfaceCoverage } from "../contracts/surface.ts";
import { publicEvidenceOf } from "../data/evidence/public.ts";
import type { EvidenceClaims } from "../data/evidence/validate.ts";
import { localizeFields } from "../data/record-context.ts";
import { publicFields } from "../data/public.ts";

/** Characters per token the estimator assumes, until a tokenizer is chosen. */
const CHARS_PER_TOKEN = 4;

/** The per-page surface summary, loaded only for a site that declares `surface`, so no other build loads the adapters. */
async function surfaceSummary(root: string, site: Site): Promise<PageJson["surface"]> {
  const { pageSurfaceOf, surfaceReportOf } = await import("../surface/report.ts");
  return pageSurfaceOf((await surfaceReportOf({ root, site })).report);
}

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Strips the site `base` from a page URL, along whole path segments only. Every URL the model carries includes
 * `base`, while the output folder is what deploys under `base` (GitHub Pages project sites), so the file path must
 * not repeat it. A URL that does not start with the base (which the model never makes) passes through untouched.
 */
function underBase(url: string, base: string): string {
  if (base === "") return url;
  if (url === base || url.startsWith(`${base}/`)) return url.slice(base.length) || "/";
  return url;
}

/** The file a page's JSON lands at, under the output folder, or `undefined` for a URL that names no page. */
export function jsonPath(url: string, base = ""): string | undefined {
  const path = jsonUrl(url);
  return path === undefined ? undefined : underBase(path, base).replace(/^\//, "");
}

/** The URL path a page's JSON is served at, including `base`; `undefined` for a URL that names no page. */
export function jsonUrl(url: string): string | undefined {
  const last = url.slice(url.lastIndexOf("/") + 1);
  if (/\.html?$/i.test(last)) return `${url.slice(0, url.length - last.length)}${last.replace(/\.html?$/i, ".json")}`;
  if (last.includes(".")) return undefined;
  return `${url.endsWith("/") ? url : `${url}/`}index.json`;
}

/** The value of a `last_modified_at` that is a string or a `Date` from the front matter parser, as `YYYY-MM-DD`; anything else reads as no date. */
function isoDate(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  return null;
}

/** The record a page was built from, with the fields the collection publishes; `undefined` when the record is gone. */
function recordOf(site: Site, page: Page): PageJsonRecord | undefined {
  const identity = page.record;
  if (identity === undefined) return undefined;
  const record = site.collections[identity.collection]?.records.find((candidate) => candidate.id === identity.id);
  if (record === undefined) return undefined;
  const config = site.config.collections[identity.collection];
  const hidden = config?.evidence;
  const fields = publicFields(localizeFields(record.fields, page.lang, site.config.lang).fields, config?.public);
  const picked: Record<string, unknown> = {};
  for (const field of config?.json?.fields ?? Object.keys(fields)) {
    if (field !== hidden && Object.prototype.hasOwnProperty.call(fields, field)) picked[field] = fields[field];
  }
  const evidence = publicEvidenceOf(record, hidden);
  return {
    collection: identity.collection,
    id: identity.id,
    fields: picked,
    ...(evidence === undefined ? {} : { evidence }),
  };
}

/** The list a page shows, with record ids rather than every field, which its page JSON already carries. */
function listOf(page: Page): PageJsonList | undefined {
  const list = page.list;
  if (list === undefined) return undefined;
  return {
    collection: list.collection,
    records: list.records.map((record) => record.id),
    groups: list.groups.map((group) => ({
      key: group.key,
      ...(group.count === undefined ? {} : { count: group.count }),
      ...(group.url === undefined ? {} : { url: group.url }),
      records: group.records.map((record) => record.id),
    })),
    pagination: {
      page: list.pagination.page,
      total: list.pagination.total,
      ...(list.pagination.previous === undefined ? {} : { previous: list.pagination.previous }),
      ...(list.pagination.next === undefined ? {} : { next: list.pagination.next }),
    },
  };
}

/** The page's description, trimmed; empty or non-string values read as no description. */
function descriptionOf(page: Page): string | null {
  const value = page.frontMatter.description;
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** One heading, as an agent reads it: its level, its anchor, and its plain text. */
interface PageHeading {
  readonly depth: number;
  readonly id: string;
  readonly text: string;
}

/** One record field as the page JSON publishes it. */
interface PageJsonRecord {
  readonly collection: string;
  readonly id: string;
  /** The record's fields in the page's language, in the collection's declared order, or every field. */
  readonly fields: Readonly<Record<string, unknown>>;
  /** Claims keyed by the field they back, in record field order; absent when the record has none. */
  readonly evidence?: EvidenceClaims;
}

/** One list page's records, groups, and place in its pagination. */
interface PageJsonList {
  readonly collection: string;
  /** Ids of the records this page shows, in the list's order. */
  readonly records: readonly string[];
  readonly groups: readonly {
    readonly key: string;
    readonly count?: number;
    readonly url?: string;
    readonly records: readonly string[];
  }[];
  readonly pagination: {
    readonly page: number;
    readonly total: number;
    readonly previous?: string;
    readonly next?: string;
  };
}

/** The JSON body of one page, with a fixed key order so the same model gives the same bytes. */
interface PageJson {
  /** Output URL, including `base`. */
  readonly url: string;
  readonly title: string;
  /** Front matter description, or `null` when the page has none. */
  readonly description: string | null;
  /** Every heading in document order. */
  readonly headings: readonly PageHeading[];
  /** The source file, relative to the site root, with forward slashes. */
  readonly source: string;
  /** Front matter `last_modified_at` as `YYYY-MM-DD`, or `null` when absent or unreadable. */
  readonly lastModified: string | null;
  /** Estimated tokens in the page's Markdown body, rounded up, at {@link CHARS_PER_TOKEN} characters per token. */
  readonly tokens: number;
  /** The record this page was built from; absent on every other page. */
  readonly record?: PageJsonRecord;
  /** The list this page shows; absent on every other page. */
  readonly list?: PageJsonList;
  /** The covered files that changed since the last review; absent on a page without `covers` and on a current page. */
  readonly stale?: PageStale;
  /** The public-surface coverage counts; present only when the site config declares a `surface` key. */
  readonly surface?: {
    readonly coverage: SurfaceCoverage;
    readonly gaps: number;
    readonly exclusions: number;
  };
  /** The page's recorded example results, keyed by fence id; absent when the page has no recorded evidence. */
  readonly examples?: Readonly<Record<string, PageJsonExample>> | undefined;
}

/** One recorded example, as page JSON publishes it: its state, provenance, and a summary of what it checked. */
interface PageJsonExample {
  readonly status: FenceExampleResult["status"];
  readonly file: string;
  readonly line: number;
  readonly language: string;
  /** The recorded run's UTC date, `YYYY-MM-DD`; present for a current or stale result. */
  readonly date?: string;
  /** The commit the run was recorded at. */
  readonly commit?: string;
  /** The evidence hash of the run, when it was recorded. */
  readonly sha256?: string;
  /** The prior state a stale result replaced. */
  readonly recordedStatus?: Exclude<FenceExampleResult["status"], "stale">;
  /** The exit code, when the run reported one. */
  readonly exitCode?: number | null;
  /** The environment hash the run used, when it was locked. */
  readonly environment?: string;
  /** One entry per expected output compared: `stdout`, `stderr`, and whether it matched. */
  readonly outputs?: readonly { readonly stream: "stdout" | "stderr"; readonly ok: boolean }[];
}

/** The page's examples as page JSON writes them: a stable key order, provenance kept, output comparison summarized. */
function examplesOf(page: Page): PageJson["examples"] | undefined {
  const results = page.examples;
  if (results === undefined || Object.keys(results).length === 0) return undefined;
  const out: Record<string, PageJsonExample> = {};
  for (const id of Object.keys(results).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const result = results[id]!;
    const stale = result.status === "stale";
    out[id] = {
      status: result.status,
      file: result.file,
      line: result.line,
      language: result.language,
      ...(stale ? {} : { ...(result.date === "" ? {} : { date: result.date }), ...(result.commit === "" ? {} : { commit: result.commit }), sha256: result.sha256 }),
      ...(stale ? { recordedStatus: result.recordedStatus } : {}),
      ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
      ...(result.environment === undefined ? {} : { environment: result.environment }),
      ...(result.evidence === undefined
        ? {}
        : { outputs: result.evidence.outputs.map((output) => ({ stream: output.stream, ok: output.ok })) }),
    };
  }
  return out;
}

/**
 * Writes one `<url>/index.json` per doc page for MCP and agents: the page's URL, title, description, headings,
 * source file, last change, and token count, so a tool reads the text and structure without parsing HTML.
 *
 * The token count is an estimate, not a tokenizer: the Markdown body's length in characters divided by
 * {@link CHARS_PER_TOKEN} (characters / 4) and rounded up, which is close enough to plan a context window and
 * documented in the output itself by that rule.
 *
 * App pages are skipped, since they are programs rather than documents, and so is a doc page whose URL names a file
 * that is not HTML, because it has no `index.json` address. The site `base` is stripped from the path, as the HTML
 * output strips it, so a project site writes `guide/install/index.json` into the output folder. Files come back
 * sorted by path, whatever order the model had.
 */
export const pageJson: Output = {
  name: "page-json",
  async run(site: Site, ctx): Promise<readonly OutputFile[]> {
    const files: OutputFile[] = [];
    const root = ctx.build?.root;
    const pageSurface =
      site.config.surface !== undefined && root !== undefined
        ? await surfaceSummary(root, site)
        : undefined;
    for (const page of site.pages) {
      if (page.kind !== "doc") continue;
      const path = jsonPath(page.url, site.config.base);
      if (path === undefined) continue;
      const record = recordOf(site, page);
      const list = listOf(page);
      const body: PageJson = {
        url: page.url,
        title: page.title,
        description: descriptionOf(page),
        headings: page.headings.map(({ depth, id, text }) => ({ depth, id, text })),
        source: page.source.file,
        lastModified: isoDate(page.frontMatter.last_modified_at),
        tokens: Math.ceil(page.markdown.length / CHARS_PER_TOKEN),
        ...(record === undefined ? {} : { record }),
        ...(list === undefined ? {} : { list }),
        ...(page.stale === undefined ? {} : { stale: page.stale }),
        ...(pageSurface === undefined ? {} : { surface: pageSurface }),
        ...(examplesOf(page) === undefined ? {} : { examples: examplesOf(page) }),
      };
      files.push({
        path,
        contents: `${JSON.stringify(body, null, 2)}\n`,
      });
    }
    return files.sort((a, b) => byCodePoint(a.path, b.path));
  },
};
