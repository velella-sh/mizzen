/**
 * `[[project:/path/]]` and `[[project:/path/|text]]`: a link to a page of another project of the network. It is
 * resolved against the locked page list only, so the build stays offline. The text is the page's title unless the
 * author wrote some. A link that does not resolve stays as written, and a diagnostic with its file and line says why,
 * so the link check does not report it a second time.
 */
import type { Root, Nodes, PhrasingContent, Text } from "mdast";
import type { Diagnostic, SourcePos } from "../contracts/index.ts";
import type { NetworkLock } from "../network/lock.ts";
import { checkProjectLink } from "./check.ts";

const PROJECT_LINK = /\[\[([a-z][a-z0-9-]*):([^\]|\s][^\]|]*?)(?:\|([^\]]+))?\]\]/g;

/** What {@link applyProjectLinks} needs. */
export interface ProjectLinkContext {
  readonly lock: NetworkLock;
  /** The id of this site's project. */
  readonly current: string;
  /** The file the link is written in, for diagnostics. */
  readonly file: string;
  readonly report: (diagnostic: Diagnostic) => void;
}

/** The source position of `index` characters into a text node, so a finding names the right line. */
function posAt(node: Text, index: number, length: number, file: string): SourcePos {
  const start = node.position?.start ?? { line: 1, column: 1 };
  const before = node.value.slice(0, index);
  const lines = before.split("\n");
  const line = start.line + lines.length - 1;
  const column = lines.length === 1 ? start.column + index : (lines.at(-1)?.length ?? 0) + 1;
  return { file, line, column, endLine: line, endColumn: column + length };
}

/** Replaces each resolvable `[[project:path]]` in the tree's text with a link node, and reports the rest. */
export function applyProjectLinks(tree: Root, ctx: ProjectLinkContext): void {
  const visit = (node: Nodes): void => {
    // A link cannot hold a link, and code is not prose: both are left as written.
    if (node.type === "link" || node.type === "linkReference" || node.type === "inlineCode" || node.type === "code") return;
    if (!("children" in node)) return;
    const children = node.children as Nodes[];
    const out: Nodes[] = [];
    let changed = false;
    for (const child of children) {
      if (child.type !== "text") {
        visit(child);
        out.push(child);
        continue;
      }
      const parts: Nodes[] = [];
      let last = 0;
      for (const match of child.value.matchAll(PROJECT_LINK)) {
        const [whole, id, rawPath, text] = match as unknown as [string, string, string, string | undefined];
        const hash = rawPath.indexOf("#");
        const path = (hash === -1 ? rawPath : rawPath.slice(0, hash)).trim();
        const anchor = hash === -1 ? "" : rawPath.slice(hash);
        const found = checkProjectLink(ctx.lock, ctx.current, id, path.startsWith("/") ? path : `/${path}`, posAt(child, match.index, whole.length, ctx.file));
        for (const d of found.diagnostics) ctx.report(d);
        if (found.resolved === undefined) continue;
        if (match.index > last) parts.push({ type: "text", value: child.value.slice(last, match.index) });
        const label = text?.trim() ?? found.resolved.page.title;
        parts.push({ type: "link", url: found.resolved.url + anchor, children: [{ type: "text", value: label }] });
        last = match.index + whole.length;
      }
      if (parts.length === 0) {
        out.push(child);
        continue;
      }
      if (last < child.value.length) parts.push({ type: "text", value: child.value.slice(last) });
      out.push(...parts);
      changed = true;
    }
    if (changed) (node as { children: Nodes[] }).children = out as PhrasingContent[];
  };
  visit(tree);
}
