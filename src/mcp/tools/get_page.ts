/** `get_page`: a page's Markdown twin with its title, headings, source file, and trust level; or one section of it. */
import { closestPages, sectionText } from "../pages.ts";
import { json, refusal, type Tool } from "../tool.ts";

interface Input {
  readonly page: string;
  readonly heading?: string;
}

export const tool: Tool<Input> = {
  name: "get_page",
  description:
    "Read one page as Markdown, by URL (such as `/guide/install/`) or source path (such as `guide/install.md`). Pass `heading` (a heading id) to get only that section. Returns title, headings, source file, and trust level.",
  inputSchema: {
    type: "object",
    properties: {
      page: { type: "string", minLength: 1, description: "Page URL or source path." },
      heading: { type: "string", description: "A heading id from `headings`; returns that section only." },
    },
    required: ["page"],
    additionalProperties: false,
  },
  async handler(input, { site }) {
    const info = site.find(input.page);
    if (info === undefined || !site.readable(info.page)) {
      return refusal("unknown-page", `No page matches "${input.page}".`, {
        closest: site.access === undefined ? closestPages(site, input.page) : [],
      });
    }
    const { page } = info;
    const headings = page.headings.map((h) => ({ id: h.id, level: h.depth, text: h.text }));
    const head = { url: page.url, title: page.title, lang: page.lang, source: info.source, trust: info.trust, headings };
    if (input.heading === undefined) return json({ ...head, markdown: page.markdown });
    const section = await sectionText(info, input.heading);
    if (section === undefined) {
      return refusal("unknown-heading", `The page has no section "${input.heading}".`, { headings });
    }
    return json({ ...head, heading: input.heading, markdown: section });
  },
};
