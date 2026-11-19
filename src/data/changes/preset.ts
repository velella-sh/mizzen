/**
 * The ready-made changelog: for a collection whose `changelog.pages` is `true`, one list page per snapshot date, a
 * newest-events page, and an Atom feed of the events.
 *
 * The pages are ordinary list pages over `<name>.changes`, so a theme renders them with the `list` layout and their
 * Markdown twins carry the same events. The feed goes through the shared feed model, one entry per event, and the
 * event id is the entry id. A collection with no history builds no page and writes no file.
 */
import type {
  Collection,
  Diagnostic,
  Page,
  RecordProps,
  Site,
  SiteConfig,
  SourcePos,
} from "../../contracts/index.ts";
import type { OutputFile } from "../../contracts/output.ts";
import { directionFromLang } from "../../content/lang.ts";
import { atomFeed } from "../../feeds/atom.ts";
import { entryId } from "../../feeds/id.ts";
import { originOf, type FeedEntry } from "../../feeds/model.ts";
import { buildListPages } from "../lists.ts";
import { publicChangeEvent, publicFields } from "../public.ts";
import { instantOf } from "../query.ts";
import { slugOf } from "../slug.ts";
import { changesName } from "./collection.ts";
import { eventsOf } from "./record.ts";
import { summaryOf } from "./track.ts";

/** A synthetic page's source: the config line a generated page points at. */
const CONFIG_POS: SourcePos = { file: "mizzen.yml", line: 1, column: 1, endLine: 1, endColumn: 1 };

/** The page URL of a collection's changelog, including `base`. */
export function changelogUrl(config: SiteConfig, collection: string): string {
  const base = config.base.replace(/\/+$/, "");
  return `${base}/changes/${collection}/`;
}

/** The page URL of one snapshot date, including `base`; a date and time is made URL-safe with the slug rule. */
export function changelogDateUrl(config: SiteConfig, collection: string, date: string): string {
  return `${changelogUrl(config, collection)}${slugOf(date)}/`;
}

/** The Atom feed's file, relative to the output folder. */
export function changelogFeedFile(collection: string): string {
  return `feeds/${collection}-changes.xml`;
}

/** The collections whose history has at least one event and whose config asks for the pages. */
function covered(config: SiteConfig, collections: Readonly<Record<string, Collection>>): readonly string[] {
  return Object.keys(config.collections).filter((name) => {
    const history = collections[changesName(name)];
    return config.collections[name]?.changelog?.pages === true && history !== undefined && history.records.length > 0;
  });
}

/** One generated page, before its list is filled. */
function pageOf(config: SiteConfig, url: string, title: string, list: Readonly<Record<string, unknown>>): Page {
  return {
    url,
    source: CONFIG_POS,
    frontMatter: { title, layout: "list", list },
    title,
    lang: config.lang,
    dir: directionFromLang(config.lang),
    headings: [],
    html: "",
    markdown: "",
    kind: "doc",
  };
}

/** What {@link buildChangelogPages} made. */
export interface ChangelogPagesResult {
  readonly pages: readonly Page[];
  readonly diagnostics: readonly Diagnostic[];
}

/** Options of {@link buildChangelogPages}. */
export interface ChangelogPagesOptions {
  readonly config: SiteConfig;
  readonly collections: Readonly<Record<string, Collection>>;
  readonly data: Readonly<Record<string, unknown>>;
  readonly pages: readonly Page[];
}

/** Builds the newest-events page and one list page per snapshot date for every collection that asks for them. */
export function buildChangelogPages(options: ChangelogPagesOptions): ChangelogPagesResult {
  const { config, collections, data } = options;
  const pages: Page[] = [];
  const diagnostics: Diagnostic[] = [];
  if (config.outputs["data-changelog"] === false) return { pages, diagnostics };

  const origin = originOf(config.url);
  for (const name of covered(config, collections)) {
    const collection = changesName(name);
    const history = collections[collection]!;
    const root = changelogUrl(config, name);
    const urls = recordUrls(options.pages, config.lang, name);
    const feed = origin === undefined ? undefined : `${origin}${config.base.replace(/\/+$/, "")}/${changelogFeedFile(name)}`;
    const append = (built: ReturnType<typeof buildListPages>) => {
      diagnostics.push(...built.diagnostics);
      for (const page of built.pages) {
        const list = page.list;
        if (list === undefined) {
          pages.push(page);
          continue;
        }
        const rowWithLink = (row: RecordProps): RecordProps => {
          const { record, type } = row.fields;
          const url = typeof record === "string" && type !== "removed" && type !== "imported" ? urls.get(record) : undefined;
          return url === undefined ? row : { ...row, links: { ...row.links, record: url } };
        };
        const records = list.records.map(rowWithLink);
        const rows = new Map(records.map((row) => [row.id, row]));
        pages.push({
          ...page,
          list: {
            ...list,
            records,
            groups: list.groups.map((group) => ({ ...group, records: group.records.map((row) => rows.get(row.id)!) })),
            ...(feed === undefined ? {} : { feed }),
          },
        });
      }
    };

    append(buildListPages({
      page: pageOf(config, root, `${name} changes`, {
        collection,
        sort: "date desc",
        group: "date",
        fields: ["date", "type", "record", "field"],
      }),
      config,
      collections,
      data,
    }));

    const dates = [...new Set(eventsOf(history).map((event) => event.date))].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    for (const date of dates) {
      append(buildListPages({
        page: pageOf(config, changelogDateUrl(config, name, date), `${name} changes on ${date}`, {
          collection,
          where: { date },
          sort: "record",
          fields: ["id", "date", "type", "record", "field"],
        }),
        config,
        collections,
        data,
      }));
    }
  }

  return { pages, diagnostics };
}

/** The instant of an event's date, or `undefined` when the schema-valid text is not a real date. */
function dateOf(text: string): Date | undefined {
  const instant = instantOf(text);
  return instant === undefined ? undefined : new Date(instant);
}

/** The current fields of a record, for a summary template that names one; `{}` when the record is gone. */
function recordFieldsOf(
  collections: Readonly<Record<string, Collection>>,
  name: string,
  id: string,
  policy: readonly string[] | undefined,
): Readonly<Record<string, unknown>> {
  const fields = collections[name]?.records.find((record) => record.id === id)?.fields ?? {};
  return publicFields(fields, policy);
}

/** The page URL of each record of a collection, for a feed entry that can link to it. */
function recordUrls(pages: readonly Page[], lang: string, name: string): ReadonlyMap<string, string> {
  const urls = new Map<string, string>();
  const main = new Map<string, string>();
  for (const page of pages) {
    const record = page.record;
    if (record === undefined || record.collection !== name || record.view !== undefined) continue;
    if (page.lang === lang) main.set(record.id, page.url);
    else if (!urls.has(record.id)) urls.set(record.id, page.url);
  }
  for (const [id, url] of main) urls.set(id, url);
  return urls;
}

/** The Atom feed files for the collections that ask for the changelog pages, sorted by path. */
export function changelogFeeds(site: Site): readonly OutputFile[] {
  if (site.config.outputs["data-changelog"] === false) return [];
  const origin = originOf(site.config.url);
  if (origin === undefined) return [];
  const base = site.config.base.replace(/\/+$/, "");
  const files: OutputFile[] = [];

  for (const name of covered(site.config, site.collections)) {
    const changelog = site.config.collections[name]!.changelog!;
    const entries: FeedEntry[] = [];
    const urls = recordUrls(site.pages, site.config.lang, name);
    const events = [...eventsOf(site.collections[changesName(name)])].sort((a, b) =>
      a.date < b.date ? 1 : a.date > b.date ? -1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    for (const raw of events.slice(0, 50)) {
      const event = publicChangeEvent(raw, site.config.collections[name]?.public);
      const date = dateOf(event.date);
      if (date === undefined) continue;
      const page = urls.get(event.record);
      const link = page === undefined
        ? `${origin}${changelogDateUrl(site.config, name, event.date)}#${event.id}`
        : `${origin}${page}`;
      entries.push({
        id: event.id,
        title: summaryOf(changelog, event.type, {
          id: event.record,
          ...(event.field === undefined ? {} : { field: event.field }),
          ...("old" in event ? { old: event.old } : {}),
          ...("new" in event ? { new: event.new } : {}),
          ...(event.from === undefined ? {} : { from: event.from }),
          ...(event.count === undefined ? {} : { count: event.count }),
          record: recordFieldsOf(site.collections, name, event.record, site.config.collections[name]?.public),
        }),
        link,
        date,
      });
    }
    if (entries.length === 0) continue;

    const self = `${origin}${base}/${changelogFeedFile(name)}`;
    files.push({
      path: changelogFeedFile(name),
      contents: atomFeed({
        id: entryId(origin, "changes", name),
        title: `${name} changes`,
        self,
        home: `${origin}${changelogUrl(site.config, name)}`,
        language: site.config.lang,
        author: site.config.title,
        entries,
      }),
    });
  }

  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** True when a site has a collection whose changelog pages are on and whose history holds at least one event. */
export function hasChangelogHistory(site: Site): boolean {
  return covered(site.config, site.collections).length > 0;
}
