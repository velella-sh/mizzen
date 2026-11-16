/**
 * `:snapshot[field]`: shows one field of the snapshot the lock holds for the collection a record page was built from:
 * `source`, `ref`, `capturedAt`, `tool`, or `toolVersion`. `capturedAt` is formatted in the page's language and
 * calendar. A collection with no snapshot, or a snapshot without the field, renders nothing; a name that is not a
 * snapshot field is an error at the directive. The `plugin` export exists because every file in this folder is
 * discovered as a Markdown plugin; record pages apply the directive themselves.
 */
import type { Root } from "mdast";
import type { Plugin } from "unified";
import type { Diagnostic } from "../../contracts/index.ts";
import { directivePath, directivePos } from "../../data/directive-context.ts";
import type { RecordScope } from "../../data/record-context.ts";
import { SNAPSHOT_TEMPLATE_FIELDS, snapshotText } from "../../data/snapshot.ts";

export const name = "snapshot";
export const order = 62;

/** Discovery reads this file; record pages apply the value after their template is parsed. */
export const plugin: Plugin<[], Root> = () => () => {};

/** What one `:snapshot[…]` became. */
export interface SnapshotResult {
  /** The node that replaces the directive; `undefined` removes it. */
  readonly replacement?: unknown;
  /** The text the Markdown twin carries. */
  readonly twin: string;
  readonly diagnostics: readonly Diagnostic[];
}

/** Applies one `:snapshot[…]` node. */
export function applySnapshot(
  node: {
    readonly position?: {
      readonly start: { readonly line: number; readonly column: number };
      readonly end: { readonly line: number; readonly column: number };
    } | undefined;
    readonly children?: readonly unknown[] | undefined;
  },
  scope: RecordScope,
): SnapshotResult {
  const field = directivePath(node.children);
  if (!(SNAPSHOT_TEMPLATE_FIELDS as readonly string[]).includes(field)) {
    const pos = directivePos(node.position, scope.file);
    return {
      replacement: { type: "text", value: `:snapshot[${field}]`, position: node.position },
      twin: `:snapshot[${field}]`,
      diagnostics: [{
        id: "data.snapshot-field",
        severity: "error",
        message: `"${field}" is not a snapshot field.`,
        ...(pos === undefined ? {} : { pos }),
        help: `Use one of ${SNAPSHOT_TEMPLATE_FIELDS.map((f) => `\`:snapshot[${f}]\``).join(", ")}.`,
      }],
    };
  }
  const text = snapshotText(scope.collections[scope.collection]?.snapshot, field, scope.lang);
  if (text === undefined) return { twin: "", diagnostics: [] };
  return { replacement: { type: "text", value: text }, twin: text, diagnostics: [] };
}
