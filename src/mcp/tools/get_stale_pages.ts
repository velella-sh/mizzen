/**
 * `get_stale_pages`: the pages whose covered files changed since they were marked as reviewed, with the files and the
 * page's source path. Read-only: it never marks a page as reviewed (that is `mizzen stale mark`, a person's decision).
 * Follow with `get_block_source` to read the page and `propose_edit` to change it.
 */
import { loadCoveredPages } from "../../stale/pages.ts";
import { readReviewLock } from "../../stale/lock.ts";
import { applyMoves, compareToLock } from "../../stale/report.ts";
import { json, type Tool } from "../tool.ts";

interface Input {
  readonly limit?: number;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
/** Most changed files listed for one page; `moreFiles` counts the rest. */
const MAX_FILES = 25;

export const tool: Tool<Input> = {
  name: "get_stale_pages",
  description:
    "List the pages that may be out of date: pages whose `covers` files changed, were removed, or were added since the page was last marked as reviewed. Each entry has the page's `source` path, `reviewed` date (absent if never), the `files` that differ with their `change`, and a `fix` hint. Read the page with `get_block_source`, change it with `propose_edit`. This tool never marks a page as reviewed.",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: `Most pages to return (default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT}).` },
    },
    additionalProperties: false,
  },
  async handler(input, { site }) {
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
    const loaded = await loadCoveredPages(site.root);
    const lock = await readReviewLock(site.root);
    const problems = [...loaded.errors, ...lock.diagnostics.map((d) => d.message)];
    if (loaded.errors.length > 0 || lock.diagnostics.length > 0 || loaded.pages.length === 0) {
      return json({ total: 0, pages: [], ...(problems.length > 0 ? { problems } : {}) });
    }
    const { pages } = await applyMoves(compareToLock(loaded.pages, lock.lock), lock.lock, loaded.coversRoot);
    const covers = new Map(loaded.pages.map((p) => [p.page, p.covers]));
    const listed = pages.slice(0, limit).map((p) => ({
      source: p.page,
      ...(p.reviewed === undefined ? {} : { reviewed: p.reviewed }),
      covers: covers.get(p.page) ?? [],
      files: p.files.slice(0, MAX_FILES),
      ...(p.files.length > MAX_FILES ? { moreFiles: p.files.length - MAX_FILES } : {}),
      fix: p.fix,
    }));
    return json({ total: pages.length, pages: listed, ...(pages.length > limit ? { more: pages.length - limit } : {}) });
  },
};
