/** `list_pages`: the page list or the navigation order, with a prefix, a language, and a limit with a cursor. */
import type { NavItem } from "../../contracts/index.ts";
import { McpError } from "../limits.ts";
import { json, type Tool } from "../tool.ts";

interface Input {
  readonly view?: "flat" | "nav";
  readonly prefix?: string;
  readonly language?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

interface Entry {
  readonly url: string;
  readonly title: string;
  readonly source: string;
  readonly depth?: number;
}

export const tool: Tool<Input> = {
  name: "list_pages",
  description:
    "List pages in the site model's order, flat (default) or in navigation order (`view: nav`, with the nesting depth). Filter by URL `prefix` or `language`; page with `limit` and the `nextCursor` of the last answer.",
  inputSchema: {
    type: "object",
    properties: {
      view: { enum: ["flat", "nav"], description: "`flat` (default) lists every page; `nav` follows the navigation." },
      prefix: { type: "string", description: "Only URLs that start with this, such as `/guide/`." },
      language: { type: "string", description: "Only pages in this language." },
      limit: { type: "integer", minimum: 1, maximum: 200, description: "Most pages per answer (default 50)." },
      cursor: { type: "string", description: "The `nextCursor` of the previous answer." },
    },
    additionalProperties: false,
  },
  async handler(input, { site, client }) {
    const limit = input.limit ?? 50;
    const offset = input.cursor === undefined ? 0 : Number(input.cursor);
    if (!Number.isInteger(offset) || offset < 0) throw new McpError("bad-cursor", "The cursor is not one this server gave.");
    const byUrl = new Map(site.readablePages.map((info) => [info.page.url, info] as const));
    let entries: Entry[];
    if (input.view === "nav") {
      entries = [];
      const seen = new Set<string>();
      const walk = (items: readonly NavItem[], depth: number): void => {
        for (const item of items) {
          if ("children" in item) walk(item.children, depth + 1);
          else {
            const info = byUrl.get(item.url);
            if (info !== undefined && !seen.has(item.url)) {
              seen.add(item.url);
              entries.push({ url: item.url, title: item.title, source: info.source, depth });
            }
          }
        }
      };
      for (const name of Object.keys(site.site.nav).sort()) walk(site.site.nav[name]!, 0);
    } else {
      entries = site.readablePages.map((info) => ({ url: info.page.url, title: info.page.title, source: info.source }));
    }
    if (input.prefix !== undefined) entries = entries.filter((e) => e.url.startsWith(input.prefix!));
    if (input.language !== undefined) {
      const wanted = input.language.toLowerCase();
      entries = entries.filter((e) => byUrl.get(e.url)!.page.lang.toLowerCase() === wanted);
    }
    const slice = entries.slice(offset, offset + limit);
    const next = offset + limit;
    const more = next < entries.length;
    return json({ total: entries.length, pages: slice, ...(more && client?.capabilities.cursors === false ? { nextOffset: next } : more ? { nextCursor: String(next) } : {}) });
  },
};
