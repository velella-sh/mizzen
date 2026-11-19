/** `query_records`: filter and sort a collection with the list rules (`where`, `sort`), one page at a time. */
import { referenceDateOf } from "../../data/reference-date.ts";
import { filterRows, parseQuery, sortRows, type Row } from "../../data/query.ts";
import { McpError } from "../limits.ts";
import { json, refusal, type Tool } from "../tool.ts";

interface Input {
  readonly collection: string;
  readonly where?: Record<string, unknown>;
  readonly sort?: string | readonly string[];
  readonly fields?: readonly string[];
  readonly limit?: number;
  readonly cursor?: string;
}

export const tool: Tool<Input> = {
  name: "query_records",
  description:
    "Query a data collection with the list rules: `where` is a mapping (a scalar is equality, a list is one-of, `{exists|before|after: ...}` are tests) and `sort` names fields, each optionally followed by asc or desc. Returns ids, page URLs, and only the named `fields`, one page at a time (`limit`, `nextCursor`).",
  inputSchema: {
    type: "object",
    properties: {
      collection: { type: "string", minLength: 1 },
      where: { type: "object", description: "Conditions, every one must match." },
      sort: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" }, maxItems: 2 }], description: "Up to two sort keys, such as `name` or `released desc`." },
      fields: { type: "array", items: { type: "string" }, maxItems: 30, description: "Fields to return besides the id." },
      limit: { type: "integer", minimum: 1, maximum: 100, description: "Most records per answer (default 20)." },
      cursor: { type: "string" },
    },
    required: ["collection"],
    additionalProperties: false,
  },
  enabled: (setup) => setup.collections.length > 0,
  async handler(input, { site }) {
    const collection = site.site.collections[input.collection];
    if (collection === undefined || !site.readableCollection(input.collection)) {
      const collections = Object.keys(site.site.collections).filter((name) => site.readableCollection(name)).sort();
      return refusal("unknown-collection", `No collection "${input.collection}".`, { collections });
    }
    const reference = referenceDateOf(input.collection, site.site.config.collections[input.collection], site.site.data, site.site.config.asOf);
    const query = parseQuery(input.where, input.sort, {
      file: "query_records",
      collection: input.collection,
      ...(reference.date === undefined ? {} : { reference: reference.date }),
    });
    const errors = query.diagnostics.filter((d) => d.severity === "error");
    if (errors.length > 0) return refusal("bad-query", errors.map((d) => d.message).join(" "));
    if (query.needsReference && reference.date === undefined) {
      return refusal("bad-query", `The query compares against the reference date, but ${input.collection} has no \`referenceDate\` in the config.`);
    }
    const rows = collection.records
      .filter((record) => site.readableRecord(input.collection, record.id, record.fields))
      .map((record) => ({
        id: record.id,
        fields: record.fields,
        ...(record.normalizedDates === undefined ? {} : { dates: record.normalizedDates }),
      })) satisfies Row[];
    const picked = sortRows(filterRows(rows, query.where), query.sort);
    const limit = input.limit ?? 20;
    const offset = input.cursor === undefined ? 0 : Number(input.cursor);
    if (!Number.isInteger(offset) || offset < 0) throw new McpError("bad-cursor", "The cursor is not one this server gave.");
    const urls = new Map(
      site.readablePages.flatMap((p) => (p.page.record !== undefined && p.page.record.collection === input.collection && p.page.record.view === undefined ? [[p.page.record.id, p.page.url] as const] : [])),
    );
    const names = input.fields ?? [];
    const records = picked.slice(offset, offset + limit).map((row) => ({
      id: row.id,
      url: urls.get(row.id) ?? null,
      fields: Object.fromEntries(names.filter((n) => Object.prototype.hasOwnProperty.call(row.fields, n)).map((n) => [n, row.fields[n]])),
    }));
    const next = offset + limit;
    return json({ collection: input.collection, total: picked.length, records, ...(next < picked.length ? { nextCursor: String(next) } : {}) });
  },
};
