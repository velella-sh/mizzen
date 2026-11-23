import type { Blockquote, Parent, Paragraph, Root, RootContent, Text } from "mdast";
import remarkDirective from "remark-directive";
import type { Plugin } from "unified";

/**
 * Turns directives and GitHub alerts into one element the render step resolves:
 *
 *   `:::callout{type=warning}` … `:::` and `::badge{label=new}` become `<sl-component name=… data-props=…>`
 *   `> [!NOTE]` (and TIP, IMPORTANT, WARNING, CAUTION) becomes `<sl-component name="callout" …>`
 *
 * `name` is whatever the author wrote; the engine never checks it against the theme, and the render step
 * warns about an unknown one. `data-props` is the directive's attributes as a JSON object. The element keeps
 * the node's position, so the Markdown stage gives it `data-src` like every other block. Nothing here
 * renders HTML: the element is a hast instruction the Markdown-to-HTML stage reads.
 */

/** Alert kinds GitHub recognises, mapped to the `type` the callout receives. */
const ALERTS: Readonly<Record<string, string>> = {
  NOTE: "note",
  TIP: "tip",
  IMPORTANT: "important",
  WARNING: "warning",
  CAUTION: "caution",
};

/** `[!KIND]` alone on the first line of a blockquote's first paragraph. */
const ALERT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\r?\n|$)/;

export const name = "directives";
export const order = 20;

/** The runtime shape common to block and inline directives; remark-directive adds `textDirective` to phrasing nodes. */
interface AnyDirective {
  readonly type: string;
  readonly name: string;
  readonly attributes?: Readonly<Record<string, string | null>>;
  data?: Record<string, unknown>;
}

/** A component name: the theme's folder names, never a number such as the `1` in `4.5:1`. */
const COMPONENT_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;

function isDirective(node: unknown): node is AnyDirective {
  const type = (node as { type?: unknown }).type;
  return type === "containerDirective" || type === "leafDirective" || type === "textDirective";
}

/** The alert kind of a blockquote that opens with `[!KIND]`, or `undefined` for a plain quote. */
function alertKind(quote: Blockquote): string | undefined {
  const first = quote.children[0];
  if (first?.type !== "paragraph") return undefined;
  const text = first.children[0];
  if (text?.type !== "text") return undefined;
  const match = ALERT.exec(text.value);
  return match ? ALERTS[match[1] ?? ""] : undefined;
}

/** The alert's children without its `[!KIND]` marker; a paragraph the marker empties is dropped. */
function bodyOf(quote: Blockquote): Blockquote["children"] {
  const [first, ...rest] = quote.children as [Paragraph, ...Blockquote["children"]];
  const inline = [...first.children];
  const marker = inline[0] as Text;
  marker.value = marker.value.replace(ALERT, "");
  if (marker.value === "") inline.shift();
  if (inline[0]?.type === "break") inline.shift();
  return inline.length > 0 ? [{ ...first, children: inline }, ...rest] : rest;
}

/** Writes the hast element a directive becomes: `sl-component` with its name and attributes. */
function toComponent(node: AnyDirective): void {
  const props: Record<string, string> = {};
  for (const [key, value] of Object.entries(node.attributes ?? {})) props[key] = value ?? "";
  const hProperties: Record<string, string> = { name: node.name, "data-props": JSON.stringify(props) };
  // A text directive sits inside a paragraph; the render step tells the component through `inline`.
  if (node.type === "textDirective") hProperties["data-inline"] = "";
  const data = (node.data ??= {}) as Record<string, unknown>;
  data.hName = "sl-component";
  data.hProperties = hProperties;
}

/** Converts alerts and directives among a parent's children, then descends into them. */
function walk(parent: Parent): void {
  parent.children = parent.children.map((child): RootContent => {
    let node: RootContent = child;
    if (child.type === "blockquote") {
      const kind = alertKind(child);
      if (kind !== undefined) {
        node = {
          type: "containerDirective",
          name: "callout",
          attributes: { type: kind },
          children: bodyOf(child),
          position: child.position,
        };
      }
    }
    if (
      node.type === "textDirective" &&
      !COMPONENT_NAME.test(node.name) &&
      (node.children === undefined || node.children.length === 0)
    ) {
      // `4.5:1` reads as a text directive named `1`. A span keeps the characters the author wrote and
      // leaves the node in place, so the bidi plugin and the drift scanner still see one run.
      const data = (node.data ??= {}) as Record<string, unknown>;
      data.hName = "span";
      data.hProperties = {};
      node.children = [{ type: "text", value: `:${node.name}` }];
    } else if (isDirective(node)) {
      toComponent(node);
    }
    if ("children" in node) walk(node as Parent);
    return node;
  });
}

export const plugin: Plugin<[], Root> = function () {
  remarkDirective.call(this);
  return (tree) => walk(tree);
};
