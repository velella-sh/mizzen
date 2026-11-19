/** `get_record`: one record's fields, its page URL, and where it sits in the data file. Only on a site with collections. */
import { closestNames } from "../records.ts";
import { json, refusal, type Tool } from "../tool.ts";

interface Input {
  readonly collection: string;
  readonly id: string;
}

export const tool: Tool<Input> = {
  name: "get_record",
  description: "Get one data record by collection and id: its fields, the URL of its page, and its position in the data file (file and span).",
  inputSchema: {
    type: "object",
    properties: {
      collection: { type: "string", minLength: 1 },
      id: { type: "string", minLength: 1 },
    },
    required: ["collection", "id"],
    additionalProperties: false,
  },
  enabled: (setup) => setup.collections.length > 0,
  async handler(input, { site }) {
    const collection = site.site.collections[input.collection];
    if (collection === undefined || !site.readableCollection(input.collection)) {
      const collections = Object.keys(site.site.collections).filter((name) => site.readableCollection(name)).sort();
      return refusal("unknown-collection", `No collection "${input.collection}".`, { collections });
    }
    const record = collection.records.find((r) => r.id === input.id);
    if (record === undefined) {
      return refusal("unknown-record", `No record "${input.id}" in ${input.collection}.`, { closest: closestNames(collection.records.map((r) => r.id), input.id) });
    }
    if (!site.readableRecord(input.collection, record.id, record.fields)) {
      return refusal("unknown-record", `No record "${input.id}" in ${input.collection}.`, { closest: [] });
    }
    const page = site.readablePages.find((p) => p.page.record?.collection === input.collection && p.page.record.id === input.id && p.page.record.view === undefined);
    const pos = record.position;
    return json({
      collection: input.collection,
      id: record.id,
      fields: record.fields as Record<string, unknown>,
      url: page?.page.url ?? null,
      position: { file: pos.file, line: pos.startLine, column: pos.startColumn, endLine: pos.endLine, endColumn: pos.endColumn },
    });
  },
};
