/**
 * The links that point at a page anchor, so a block the lock recorded but this build no longer has can name the
 * references that depended on it.
 */
import type { Nodes, Root } from "mdast";
import type { SourcePos } from "../contracts/index.ts";
import { parseMarkdown } from "../markdown/parse.ts";
import { spanFromPosition } from "../source/spans.ts";

/** The anchor part of a link target, or `undefined` when it names none. */
function fragmentOf(url: string): string | undefined {
  const at = url.indexOf("#");
  const fragment = at < 0 ? "" : url.slice(at + 1);
  return fragment === "" ? undefined : fragment;
}

/** Every `#anchor` the Markdown links in `markdown` target, with each link's span in `file`, at `firstLine`. */
export async function anchorReferencesIn(
  markdown: string,
  file: string,
  firstLine: number,
): Promise<Map<string, SourcePos[]>> {
  const tree: Root = await parseMarkdown(markdown, firstLine);
  const references = new Map<string, SourcePos[]>();
  const walk = (node: Nodes): void => {
    if (node.type === "link" && node.position !== undefined) {
      const anchor = fragmentOf(node.url);
      if (anchor !== undefined) references.set(anchor, [...(references.get(anchor) ?? []), spanFromPosition(file, node.position)]);
    }
    if ("children" in node) for (const child of node.children) walk(child);
  };
  walk(tree);
  return references;
}
