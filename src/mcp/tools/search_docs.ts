/** `search_docs`: ranked search over the built site's page text; returns pointers, never whole pages. */
import { decodeCursor, encodeCursor } from "../runtime/cursors.ts";
import { words } from "../pages.ts";
import { json, type Tool } from "../tool.ts";

interface Input {
  readonly query: string;
  readonly limit?: number;
  readonly language?: string;
  readonly version?: string;
  readonly cursor?: string;
}

const EXCERPT = 200;

/** Markdown with its markup reduced to the words a reader sees. */
function plain(markdown: string): string {
  return markdown
    .replace(/```[^\n]*\n/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_>#|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function excerptOf(text: string, terms: readonly string[]): string {
  const lower = text.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const found = lower.indexOf(term);
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  const start = Math.max(0, (at < 0 ? 0 : at) - 60);
  const slice = text.slice(start, start + EXCERPT).trim();
  return `${start > 0 ? "…" : ""}${slice}${start + EXCERPT < text.length ? "…" : ""}`;
}

export const tool: Tool<Input> = {
  name: "search_docs",
  description:
    "Search the docs. Returns up to `limit` results with title, URL, an excerpt, and the source path; an empty list when nothing matches. Use get_page to read a result. A bounded answer carries `nextCursor`; the cursor is only valid in the snapshot it was made in.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1, maxLength: 500, description: "Words to look for." },
      limit: { type: "integer", minimum: 1, maximum: 50, description: "Most results to return (default 10)." },
      language: { type: "string", description: "Only pages in this language, such as `en` or `fa`." },
      version: { type: "string", description: "Only pages of this version folder, such as `v2`." },
      cursor: { type: "string", description: "The `nextCursor` of the previous answer; it names the snapshot it was made in." },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async handler(input, { site, session }) {
    const terms = [...new Set(words(input.query))];
    const limit = input.limit ?? 10;
    const key = [input.query, limit, input.language ?? "", input.version ?? ""];
    const offset = input.cursor === undefined ? 0 : decodeCursor(input.cursor, session.snapshot, key);
    const base = site.site.config.base;
    const hits: { score: number; url: string; title: string; excerpt: string; source: string; lang: string }[] = [];
    if (terms.length > 0) {
      for (const info of site.readablePages) {
        const { page } = info;
        if (input.language !== undefined && page.lang.toLowerCase() !== input.language.toLowerCase()) continue;
        if (input.version !== undefined) {
          const rest = page.url.startsWith(base) ? page.url.slice(base.length) : page.url;
          if (rest.split("/").filter(Boolean)[0] !== input.version) continue;
        }
        const title = words(page.title);
        const heads = words(page.headings.map((h) => h.text).join(" "));
        const body = plain(page.markdown);
        const bodyWords = words(body);
        let score = 0;
        let matched = 0;
        for (const term of terms) {
          const inBody = bodyWords.filter((w) => w === term || w.startsWith(term)).length;
          const s =
            (title.some((w) => w.startsWith(term)) ? 8 : 0) + (heads.some((w) => w.startsWith(term)) ? 4 : 0) + Math.min(inBody, 5);
          if (s > 0) matched += 1;
          score += s;
        }
        if (matched === 0) continue;
        score += matched * 10; // pages that hold more of the query's words come first
        hits.push({ score, url: page.url, title: page.title, excerpt: excerptOf(body, terms), source: info.source, lang: page.lang });
      }
    }
    hits.sort((a, b) => b.score - a.score || (a.url < b.url ? -1 : 1));
    const slice = hits.slice(offset, offset + limit);
    const results = slice.map(({ score: _score, ...rest }) => rest);
    const next = offset + limit;
    return json({
      query: input.query,
      total: hits.length,
      results,
      ...(next < hits.length ? { nextCursor: encodeCursor(session.snapshot, next, key) } : {}),
    });
  },
};
