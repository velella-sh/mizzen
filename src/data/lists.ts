/**
 * List pages: an ordinary page whose front matter declares `list` shows records of a collection, filtered, sorted,
 * grouped, and paginated. The page itself stays a `doc` page; the engine adds `Page.list` and hands it to the layout.
 *
 * The declaration lives in front matter. `where` and `sort` are read by {@link parseQuery}, `group` by
 * {@link parseGroup}, and `perPage` splits the result with {@link paginateRows}. An `expand` field builds one page per
 * value at a pattern such as `/tags/{value|slug}/`, and the page that declared it keeps an index of the values.
 *
 * Nothing here reads the clock: a date filter compares against `collections.<name>.referenceDate`. Records without a
 * value still appear (in the group named by `group.missing`), an empty list is a warning rather than a failed build,
 * and page two onwards is written at `<url>page/<n>/`. The Markdown twin of each page carries the same records as a
 * table, so a reader of the twin sees what a reader of the HTML sees.
 */
import type {
  Collection,
  CollectionConfig,
  DataRecord,
  Diagnostic,
  ListGroup,
  ListProps,
  Page,
  RecordProps,
  SiteConfig,
  SourcePos,
} from "../contracts/index.ts";
import { slugOf } from "./slug.ts";
import { fillPermalink, recordUrlsOf, urlOfPattern } from "./permalink.ts";
import { localizeFields, prefixOfLang, referenceTargets, resolveIn, scalarText, urlOfRecord } from "./record-context.ts";
import { groupRows, parseGroup, type GroupSpec, type Grouping } from "./group.ts";
import { paginateRows, type Slice } from "./paginate.ts";
import { filterRows, parseQuery, sortRows, type Row } from "./query.ts";
import { referenceDateOf } from "./reference-date.ts";
import { fieldsWithDerived } from "./derived.ts";
import { withoutEvidence } from "./evidence/public.ts";
import { publicFields } from "./public.ts";
import { relatedProps } from "./relations/query.ts";

/** How one page declares its list. */
export interface ListSpec {
  readonly collection: string;
  /** The raw `where`, read by {@link parseQuery}. */
  readonly where: unknown;
  /** The raw `sort`, read by {@link parseQuery}. */
  readonly sort: unknown;
  readonly group?: GroupSpec;
  readonly perPage?: number;
  readonly splitGroups: boolean;
  /** Fields handed to the layout and written to the twin; unset, every field. */
  readonly fields?: readonly string[];
  readonly expand?: { readonly field: string; readonly permalink: string; readonly title?: string };
  /** The `where` as written, for a finding about an empty list. */
  readonly filter?: string;
}

/** What {@link buildListPages} needs: the page that declared the list and the site it lives in. */
export interface ListPagesOptions {
  readonly page: Page;
  /** Where `list` sits in the page's front matter, for findings. */
  readonly position?: SourcePos;
  readonly config: SiteConfig;
  readonly collections: Readonly<Record<string, Collection>>;
  readonly data: Readonly<Record<string, unknown>>;
}

/** The page and its extra pages, in URL order, and every finding made while building them. */
export interface ListPagesResult {
  readonly pages: readonly Page[];
  readonly diagnostics: readonly Diagnostic[];
}

/** One record of a list, with the fields the page reads and the row shape the query works on. */
interface RowRecord extends Row {
  readonly record: DataRecord;
  readonly fallbacks: readonly string[];
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The span of one top-level front matter key, for a finding at the `list` line. */
export function keyPositionOf(text: string, file: string, key: string): SourcePos | undefined {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines[0]?.trim() !== "---") return undefined;
  const at = new RegExp(`^${key}\\s*:`);
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index]!;
    if (/^(---|\.\.\.)\s*$/.test(line)) break;
    if (at.test(line)) return { file, line: index + 1, column: 1, endLine: index + 1, endColumn: line.length };
  }
  return undefined;
}

/** Reads `list` from front matter, reporting what keeps it from being a list. */
export function readList(
  raw: unknown,
  options: { readonly config: SiteConfig; readonly collections: Readonly<Record<string, Collection>>; readonly pos?: SourcePos },
): { readonly spec?: ListSpec; readonly diagnostics: readonly Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const fail = (id: string, message: string, help: string): void => {
    diagnostics.push({ id, severity: "error", message, ...(options.pos === undefined ? {} : { pos: options.pos }), help });
  };
  if (!isMapping(raw)) {
    fail("data.list-shape", "`list` is a mapping of a collection and its query.", "Write `list: { collection: posts }`.");
    return { diagnostics };
  }
  const collection = raw["collection"];
  if (typeof collection !== "string" || collection.trim() === "") {
    fail("data.list-shape", "`list` needs a `collection`.", "Write `list: { collection: posts }`.");
    return { diagnostics };
  }
  if (options.collections[collection] === undefined) {
    fail(
      "data.list-collection",
      `The list names the collection "${collection}", which the site does not have.`,
      "Name a collection the config declares.",
    );
    return { diagnostics };
  }

  let perPage: number | undefined;
  if (raw["perPage"] !== undefined) {
    const value = raw["perPage"];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
      fail("data.list-shape", "`list.perPage` is a whole number of at least 1.", "Write `perPage: 10`, or remove it.");
    } else {
      perPage = value;
    }
  }
  if (raw["splitGroups"] !== undefined && typeof raw["splitGroups"] !== "boolean") {
    fail("data.list-shape", "`list.splitGroups` is `true` or `false`.", "Write `splitGroups: true`, or remove it.");
  }

  let fields: readonly string[] | undefined;
  if (raw["fields"] !== undefined) {
    const value = raw["fields"];
    if (!Array.isArray(value) || value.some((field) => typeof field !== "string" || field.trim() === "")) {
      fail("data.list-shape", "`list.fields` is a list of field names.", "Write `fields: [title, date]`, or remove it.");
    } else {
      fields = value as string[];
    }
  }

  const group = parseGroup(raw["group"], options.pos);
  diagnostics.push(...group.diagnostics);

  let expand: ListSpec["expand"];
  if (raw["expand"] !== undefined) {
    const value = raw["expand"];
    if (
      !isMapping(value) ||
      typeof value["field"] !== "string" ||
      value["field"].trim() === "" ||
      typeof value["permalink"] !== "string" ||
      !value["permalink"].startsWith("/")
    ) {
      fail(
        "data.list-expand",
        "`list.expand` needs a `field` and a `permalink` starting with `/`.",
        "Write `expand: { field: tags, permalink: /tags/{value|slug}/ }`.",
      );
    } else if (!/\{value(?:\||\})/.test(value["permalink"])) {
      fail(
        "data.list-expand",
        `The expand pattern "${value["permalink"]}" does not name \`{value}\`, so every value would get one URL.`,
        "Write a pattern such as `/tags/{value|slug}/`.",
      );
    } else if (value["title"] !== undefined && typeof value["title"] !== "string") {
      fail("data.list-expand", "`list.expand.title` is a pattern written as text.", "Write `title: Tagged {value}`.");
    } else {
      expand = {
        field: value["field"],
        permalink: value["permalink"],
        ...(typeof value["title"] === "string" ? { title: value["title"] } : {}),
      };
    }
  }

  const where = raw["where"];
  const filter =
    isMapping(where) && Object.keys(where).length > 0
      ? Object.entries(where)
          .map(([field, value]) => `${field}=${isMapping(value) ? Object.keys(value).join("/") : Array.isArray(value) ? value.join(",") : String(value)}`)
          .join(" ")
      : undefined;

  return {
    spec: {
      collection,
      where,
      sort: raw["sort"],
      ...(group.spec === undefined ? {} : { group: group.spec }),
      ...(perPage === undefined ? {} : { perPage }),
      splitGroups: raw["splitGroups"] === true,
      ...(fields === undefined ? {} : { fields }),
      ...(expand === undefined ? {} : { expand }),
      ...(filter === undefined ? {} : { filter }),
    },
    diagnostics,
  };
}

/** A field's text for a table cell; a list joins its items, and an object keeps its JSON text. */
function cellText(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => cellText(item)).filter((text) => text !== "").join(", ");
  const text = scalarText(value);
  if (text !== undefined) return text;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/** A Markdown cell: a pipe is escaped and a line break becomes a space. */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r\n|\r|\n/g, " ");
}

/** The columns of one page's table: the named fields, else the fields of the first record. */
function columnsOf(spec: ListSpec, records: readonly RecordProps[]): readonly string[] {
  if (spec.fields !== undefined) return spec.fields;
  const first = records[0];
  return first === undefined ? ["id"] : Object.keys(first.fields);
}

/** One table of records, linking each record's first cell to its page when it has one. */
function tableOf(records: readonly RecordProps[], columns: readonly string[]): string {
  if (records.length === 0) return "";
  const header = `| ${columns.map(cell).join(" | ")} |`;
  const divider = `| ${columns.map(() => "---").join(" | ")} |`;
  const rows = records.map((record) => {
    const cells = columns.map((column, index) => {
      const value = record.fields[column] ?? (column === "id" ? record.id : "");
      const text = cell(cellText(value));
      return index === 0 && record.url !== "" ? `[${text || record.id}](${record.url})` : text;
    });
    return `| ${cells.join(" | ")} |`;
  });
  return [header, divider, ...rows].join("\n");
}

/** The twin of one list page: its groups as sections, or its records as one table, or its index of values. */
function twinOf(spec: ListSpec, props: ListProps): string {
  const index = props.groups.length > 0 && props.groups.every((group) => group.records.length === 0 && group.count !== undefined);
  if (index) {
    const rows = props.groups.map((group) => `| ${group.url === undefined ? cell(group.key) : `[${cell(group.key)}](${group.url})`} | ${group.count ?? 0} |`);
    return ["| value | records |", "| --- | --- |", ...rows].join("\n");
  }
  const columns = columnsOf(spec, props.records);
  if (props.groups.length === 0) return tableOf(props.records, columns);
  const sections = props.groups
    .filter((group) => group.records.length > 0)
    .map((group) => `## ${group.key}\n\n${tableOf(group.records, columns)}`);
  return sections.join("\n\n");
}

/** The page with `list` filled in, its layout defaulted to `list`, and its twin carrying the table. */
function listPage(page: Page, url: string, title: string, props: ListProps, twin: string, dates: boolean): Page {
  const markdown = twin === "" ? page.markdown : `${page.markdown.replace(/\s+$/, "")}\n\n${twin}\n`;
  // A generated page shares the declaring page's source, so its blocks belong only to the page at its own URL.
  const { blocks, ...source } = page;
  return {
    ...source,
    url,
    title,
    frontMatter: { ...page.frontMatter, title, layout: page.frontMatter.layout ?? "list" },
    markdown,
    list: props,
    ...(url === page.url && blocks !== undefined ? { blocks } : {}),
    ...(dates ? { dates: true } : {}),
  };
}

/** The URL of one page of a list, page one being the page's own URL. */
function pageUrl(base: string, index: number): string {
  const root = base.endsWith("/") ? base : `${base}/`;
  return index === 0 ? base : `${root}page/${index + 1}/`;
}

/** Fills an expand title or URL pattern: `{value}` as written, `{value|slug}` URL-safe. */
function fillValue(pattern: string, value: string): string {
  return pattern.replace(/\{value(\|slug)?\}/g, (_match, filter: string | undefined) => (filter === undefined ? value : slugOf(value)));
}

/**
 * Builds the pages of one list. The first page in the result replaces the declaring page; the rest are appended at
 * their own URLs. A declaration the engine cannot read leaves the page exactly as it was and returns its findings.
 */
export function buildListPages(options: ListPagesOptions): ListPagesResult {
  const { page, config, collections, data } = options;
  if (page.frontMatter.list === undefined) return { pages: [page], diagnostics: [] };
  const diagnostics: Diagnostic[] = [];
  const read = readList(page.frontMatter.list, {
    config,
    collections,
    ...(options.position === undefined ? {} : { pos: options.position }),
  });
  diagnostics.push(...read.diagnostics);
  const spec = read.spec;
  const collection = spec === undefined ? undefined : collections[spec.collection];
  if (spec === undefined || collection === undefined) return { pages: [page], diagnostics };

  const entry: CollectionConfig | undefined = config.collections[spec.collection];
  const reference = referenceDateOf(spec.collection, entry, data, config.asOf);
  const query = parseQuery(spec.where, spec.sort, {
    file: page.source.file,
    ...(options.position === undefined ? {} : { pos: options.position }),
    collection: spec.collection,
    ...(reference.date === undefined ? {} : { reference: reference.date }),
  });
  diagnostics.push(...query.diagnostics);
  if (
    query.needsReference &&
    reference.error !== undefined &&
    options.position !== undefined &&
    !diagnostics.some((finding) => finding.id === "data.reference-date")
  ) {
    diagnostics.push({
      id: "data.reference-date",
      severity: "error",
      message: reference.error,
      pos: options.position,
      help: `Set \`collections.${spec.collection}.referenceDate\` to a date, or to the path of a _data value that holds one.`,
    });
  }

  const prefix = prefixOfLang(config, page.lang);
  // A derived value or a date filter that reads the as-of date makes these pages depend on that date.
  const dates =
    (entry?.derived !== undefined && Object.keys(entry.derived).length > 0) ||
    (query.needsReference && entry?.referenceDate === undefined && config.asOf !== undefined);
  const rows: RowRecord[] = collection.records.map((record) => {
    const localized = localizeFields(record.fields, page.lang, config.lang);
    const idFields = localized.fields["id"] === undefined ? { ...localized.fields, id: record.id } : localized.fields;
    const fields = publicFields(
      fieldsWithDerived({ fields: withoutEvidence(idFields, entry?.evidence), derived: record.derived }),
      entry?.public,
    );
    return {
      record,
      fields,
      fallbacks: localized.fallbacks,
      id: record.id,
      ...(record.normalizedDates === undefined ? {} : { dates: record.normalizedDates }),
    };
  });

  const whereFields = isMapping(spec.where) ? Object.keys(spec.where) : [];
  const namedFields = new Set([
    ...whereFields,
    ...query.sort.map((key) => key.field),
    ...(spec.group === undefined ? [] : [spec.group.field]),
    ...(spec.fields ?? []),
    ...(spec.expand === undefined ? [] : [spec.expand.field]),
  ]);
  for (const field of namedFields) {
    if (rows.some((row) => resolveIn(row.fields, field).found)) continue;
    diagnostics.push({
      id: "data.list-field",
      severity: "warning",
      message: `The list names the field "${field}", which no record of ${spec.collection} has.`,
      ...(options.position === undefined ? {} : { pos: options.position }),
      help: "Use a field the records hold, or remove the key.",
    });
  }

  const selected = sortRows(filterRows(rows, query.where), query.sort);
  if (selected.length === 0) {
    diagnostics.push({
      id: "data.list-empty",
      severity: "warning",
      message: `The list of ${spec.collection} matches no record${spec.filter === undefined ? "" : ` (${spec.filter})`}.`,
      ...(options.position === undefined ? {} : { pos: options.position }),
      help: "Change `where`, or leave the list out until the collection has records.",
    });
  }

  const urlMap = recordUrlsOf(
    spec.collection,
    rows.map((row) => ({ id: row.id, fields: row.fields, position: row.record.position })),
    entry ?? {},
    { base: config.base, prefix },
  );
  const referenceLinks = referenceTargets(entry);
  const props = new Map<string, RecordProps>();
  const propsOf = (row: RowRecord): RecordProps => {
    const known = props.get(row.id);
    if (known !== undefined) return known;
    const picked =
      spec.fields === undefined
        ? row.fields
        : Object.fromEntries(
            spec.fields.flatMap((field) => {
              const found = resolveIn(row.fields, field);
              return found.found ? [[field, found.value]] : [];
            }),
          );
    const links: Record<string, string> = {};
    for (const [field, target] of Object.entries(referenceLinks)) {
      const id = row.fields[field];
      if (typeof id !== "string" && typeof id !== "number") continue;
      const url = urlOfRecord(collections, config.collections, config.base, prefix, target, String(id), page.lang, config.lang);
      if (url !== undefined) links[field] = url;
    }
    const record: RecordProps = {
      collection: spec.collection,
      id: row.id,
      url: urlMap.urls.get(row.id)?.url ?? "",
      fields: picked,
      links,
      ...relatedProps(collections, config, spec.collection, row.fields, page.lang),
      ...(row.record.derived === undefined ? {} : { derived: publicFields(row.record.derived, entry?.public) }),
    };
    props.set(row.id, record);
    return record;
  };

  /** One slice of the list as its ListProps, with pagination filled from the page URLs. */
  const propsOfSlice = (slice: Slice<RowRecord>, urls: readonly string[], index: number): ListProps => ({
    collection: spec.collection,
    records: slice.rows.map(propsOf),
    groups: slice.groups.map((group) => ({ key: group.key, records: group.rows.map(propsOf) })),
    pagination: {
      page: index + 1,
      total: urls.length,
      ...(index > 0 ? { previous: urls[index - 1]! } : {}),
      ...(index < urls.length - 1 ? { next: urls[index + 1]! } : {}),
    },
  });

  const grouping: readonly Grouping<RowRecord>[] = spec.group === undefined ? [] : groupRows(selected, spec.group);

  if (spec.expand !== undefined) {
    const values = groupRows(selected, { field: spec.expand.field, by: "value", order: "key", missing: "" }).filter(
      (group) => group.key !== "",
    );
    const index: ListGroup[] = [];
    const expanded: Page[] = [];
    for (const value of values) {
      const filled = fillPermalink(spec.expand.permalink, { value: value.key });
      if (filled.missing.length > 0 || filled.empty.length > 0 || filled.unknown !== undefined) {
        diagnostics.push({
          id: "data.list-expand",
          severity: "error",
          message: `The expand pattern cannot build a URL for the value "${value.key}".`,
          ...(options.position === undefined ? {} : { pos: options.position }),
          help: "Write the pattern as `/tags/{value|slug}/`, and keep a value with a letter or digit.",
        });
        continue;
      }
      const url = urlOfPattern(filled.value, config.base, prefix);
      index.push({ key: value.key, records: [], count: value.rows.length, url });
      const group = spec.group === undefined ? [] : groupRows(value.rows, spec.group);
      const slices = paginateRows(value.rows, group, spec.perPage, spec.splitGroups);
      const urls = slices.map((_slice, position) => pageUrl(url, position));
      const title = spec.expand.title === undefined ? value.key : fillValue(spec.expand.title, value.key);
      slices.forEach((slice, position) => {
        const list = propsOfSlice(slice, urls, position);
        expanded.push(listPage(page, urls[position]!, title, list, twinOf(spec, list), dates));
      });
    }
    const indexProps: ListProps = {
      collection: spec.collection,
      records: [],
      groups: index,
      pagination: { page: 1, total: 1 },
    };
    return {
      pages: [listPage(page, page.url, page.title, indexProps, twinOf(spec, indexProps), dates), ...expanded],
      diagnostics,
    };
  }

  const slices = paginateRows(selected, grouping, spec.perPage, spec.splitGroups);
  const urls = slices.map((_slice, index) => pageUrl(page.url, index));
  const pages = slices.map((slice, index) => {
    const list = propsOfSlice(slice, urls, index);
    return listPage(page, urls[index]!, page.title, list, twinOf(spec, list), dates);
  });
  return { pages, diagnostics };
}
