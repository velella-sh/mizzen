/**
 * `get_block_source`: the file, exact span, source text, and hash of one block, so an edit can name it.
 * Several matches are listed for the agent to choose from; the tool never guesses between them. A block is named by
 * heading id, by quoted text, or by its stable block id from `blocks.lock.json`; a page with block ids reports the
 * matched id beside every span.
 */
import { hashSource, sliceBySpan, type PatchSpan } from "../../edits/patch.ts";
import { bodyBlocks, closestPages } from "../pages.ts";
import { json, refusal, type Tool, type ToolResult } from "../tool.ts";
import type { PageInfo, SiteState } from "../site.ts";

interface Input {
  readonly page: string;
  readonly heading?: string;
  readonly text?: string;
  readonly block?: string;
}

interface Found {
  readonly kind: string;
  readonly file: string;
  readonly span: PatchSpan;
}

const EXCERPT = 120;

/** The stable id of the block whose span starts at `span`, when the page's build recorded block ids. */
function idAt(info: PageInfo, span: PatchSpan): string | undefined {
  return info.page.blocks?.find((block) => block.pos.line === span.line && block.pos.column === span.column)?.id;
}

async function located(site: SiteState, found: Found): Promise<Record<string, unknown> | undefined> {
  const source = await site.readSource(found.file).catch(() => undefined);
  if (source === undefined) return undefined;
  let text: string;
  try {
    text = sliceBySpan(source, found.span);
  } catch {
    return undefined;
  }
  return { kind: found.kind, file: found.file, span: { line: found.span.line, column: found.span.column, endLine: found.span.endLine, endColumn: found.span.endColumn }, text, beforeHash: hashSource(source) };
}

async function byText(site: SiteState, info: PageInfo, quote: string): Promise<Found[]> {
  const out: Found[] = [];
  const record = info.page.record;
  if (record !== undefined) {
    const entry = site.site.collections[record.collection]?.records.find((r) => r.id === record.id);
    for (const [name, value] of Object.entries(entry?.fields ?? {})) {
      const pos = entry?.fieldPositions[name];
      if (typeof value === "string" && value.includes(quote) && pos !== undefined) {
        out.push({ kind: `field:${name}`, file: pos.file, span: { file: pos.file, line: pos.startLine, column: pos.startColumn, endLine: pos.endLine, endColumn: pos.endColumn } });
      }
    }
    return out;
  }
  const normal = quote.replace(/\r\n/g, "\n");
  for (const block of await bodyBlocks(info, info.page.source.line)) {
    const raw = info.page.markdown.slice(block.start, block.end).replace(/\r\n/g, "\n");
    if (raw.includes(normal)) out.push({ kind: block.kind, file: info.source, span: { file: info.source, ...block.pos } });
  }
  return out;
}

export const tool: Tool<Input> = {
  name: "get_block_source",
  description:
    "Find the source of one block of a page: give a heading id, a quoted piece of its text, or its stable block id. Returns the file, the exact span (1-based lines and columns), the block's source text, and `beforeHash`, the hash an edit must carry. A page built with block ids also reports the matched block's id. When the text matches several blocks they are listed and nothing is chosen.",
  inputSchema: {
    type: "object",
    properties: {
      page: { type: "string", minLength: 1, description: "Page URL or source path." },
      heading: { type: "string", description: "A heading id of the page." },
      text: { type: "string", minLength: 1, description: "Text quoted from the block." },
      block: { type: "string", minLength: 1, description: "The block's stable id from blocks.lock.json." },
    },
    required: ["page"],
    additionalProperties: false,
  },
  async handler(input, { site }): Promise<ToolResult> {
    const info = site.find(input.page);
    if (info === undefined) return refusal("unknown-page", `No page matches "${input.page}".`, { closest: closestPages(site, input.page) });
    if ([input.heading, input.text, input.block].filter((value) => value !== undefined).length !== 1) {
      return refusal("bad-request", "Give exactly one of `heading`, `text`, or `block`.");
    }
    let candidates: Found[];
    if (input.heading !== undefined) {
      const section = info.sections.find((s) => s.id === input.heading);
      if (section === undefined) {
        return refusal("unknown-heading", `The page has no heading "${input.heading}".`, { headings: info.sections.map((s) => s.id) });
      }
      candidates = [{ kind: "heading", file: section.file, span: { file: section.file, line: section.line, column: section.column, endLine: section.endLine, endColumn: section.endColumn } }];
    } else if (input.block !== undefined) {
      const found = info.page.blocks?.find((block) => block.id === input.block);
      if (found === undefined) {
        return refusal("unknown-block", `The page has no block "${input.block}".`, { blocks: (info.page.blocks ?? []).map((block) => block.id) });
      }
      const { pos } = found;
      candidates = [{ kind: "block", file: info.source, span: { file: info.source, line: pos.line, column: pos.column, endLine: pos.endLine, endColumn: pos.endColumn } }];
    } else {
      candidates = await byText(site, info, input.text!);
    }
    const resolved: Record<string, unknown>[] = [];
    for (const candidate of candidates) {
      const block = await located(site, candidate);
      // A block whose source text differs from the built text came from an include or a template: it is not editable here.
      if (block !== undefined) {
        const id = idAt(info, candidate.span);
        resolved.push(id === undefined ? block : { ...block, block: id });
      }
    }
    if (resolved.length === 0) {
      return refusal("no-match", "No block of the page matches; quote text as it appears in the page's Markdown.");
    }
    if (resolved.length > 1) {
      return json({
        ok: false,
        status: "ambiguous",
        message: `${resolved.length} blocks match; quote more text to pick one.`,
        matches: resolved.map((m) => ({ ...m, text: String(m.text).slice(0, EXCERPT) })),
      });
    }
    return json({ ok: true, status: "found", page: info.page.url, ...resolved[0]! });
  },
};
