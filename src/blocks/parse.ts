/**
 * Reads the block identifiers a page declares: `{#id}` on a heading, and `<!-- {#id} -->` on the line before any other
 * block. A declaration that does not match the contract is an error with its file and line, and names no block. A
 * block that declares none gets {@link autoBlockId}, so every top-level block has an id.
 */
import type { Nodes, Root } from "mdast";
import type { Block, Diagnostic, SourcePos } from "../contracts/index.ts";
import { sliceSpan, spanFromPosition } from "../source/spans.ts";
import { autoBlockId, blockFingerprint, isBlockId } from "./id.ts";

/** A trailing `{#id}` on a heading line, mirroring the slug plugin's syntax. */
const HEADING_ID = /\{#([^\s{}]+)\}\s*#*\s*$/;

/** A whole-line comment that declares the identifier of the block after it. */
const MARKER = /^<!--\s*\{#([^\s{}]*)\}\s*-->$/;

/** Options of {@link blocksOf}. */
export interface BlocksOfOptions {
  /** The page's path as a diagnostic names it, relative to the repository root. */
  readonly file: string;
  /** The parsed page, with positions in the full source file. */
  readonly tree: Root;
  /** The Markdown body that was parsed, as {@link tree}'s positions describe it. */
  readonly markdown: string;
  /** The 1-based source line where `markdown` starts, from the front matter. */
  readonly bodyLine: number;
}

/** The blocks of one page, and every declaration that could not name one. */
export interface BlockAssignment {
  readonly blocks: readonly Block[];
  readonly diagnostics: readonly Diagnostic[];
}

/** A declaration waiting for the block it names. */
interface Pending {
  readonly id: string;
  readonly pos: SourcePos;
}

/** The source a node covers, from a body whose first line is `bodyLine` of the file. */
function sourceOf(markdown: string, node: Nodes, bodyLine: number): string | undefined {
  if (node.position === undefined) return undefined;
  const span = spanFromPosition("", node.position);
  return sliceSpan(markdown, { ...span, line: span.line - bodyLine + 1, endLine: span.endLine - bodyLine + 1 });
}

/** The `{#id}` a heading declares on one of its own lines, if any. */
function headingId(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  for (const line of text.split("\n")) {
    const match = HEADING_ID.exec(line);
    if (match) return match[1];
  }
  return undefined;
}

/** Reports a declaration whose id breaks the contract. */
function invalid(file: string, id: string, pos: SourcePos, where: string): Diagnostic {
  return {
    id: "blocks.invalid-id",
    severity: "error",
    message: `The block id ${JSON.stringify(id)} ${where} does not match [a-z0-9][a-z0-9-]{0,63}.`,
    pos: { ...pos, file },
    help: "Use lowercase letters, digits, and hyphens, starting with a letter or digit; at most 64 characters.",
  };
}

/**
 * The blocks a page declares. A heading's `{#id}` wins on that heading; every other block takes the marker comment
 * directly above it. A declaration with an invalid id is reported and dropped, and a marker with no block after it is
 * reported too.
 */
export function blocksOf(options: BlocksOfOptions): BlockAssignment {
  const { file, tree, markdown, bodyLine } = options;
  const blocks: Block[] = [];
  const diagnostics: Diagnostic[] = [];
  let pending: Pending | undefined;

  const reportUnused = (marker: Pending): void => {
    diagnostics.push({
      id: "blocks.marker-unused",
      severity: "error",
      message: "The block id marker names no block: a marker applies to the block on the line after it.",
      pos: { ...marker.pos, file },
      help: "Put the marker directly above a block, or remove it.",
    });
  };

  for (const node of tree.children) {
    if (node.position === undefined) continue;
    const pos = { ...spanFromPosition(file, node.position) };

    if (node.type === "html") {
      const match = MARKER.exec(node.value.trim());
      if (match !== null) {
        if (pending !== undefined) reportUnused(pending);
        const id = match[1] ?? "";
        pending = isBlockId(id) ? { id, pos } : undefined;
        if (!isBlockId(id)) diagnostics.push(invalid(file, id, pos, "in the comment"));
        continue;
      }
    }

    // A link reference definition renders nothing, so it is not a block; every other top-level node is.
    if (node.type === "definition") {
      if (pending !== undefined) reportUnused(pending);
      pending = undefined;
      continue;
    }

    const declared = node.type === "heading" ? headingId(sourceOf(markdown, node, bodyLine)) : undefined;
    if (declared !== undefined && !isBlockId(declared)) {
      diagnostics.push(invalid(file, declared, pos, "on the heading"));
    }
    const id = declared !== undefined && isBlockId(declared) ? declared : pending?.id;
    if (declared !== undefined && pending !== undefined) reportUnused(pending);
    pending = undefined;
    const source = sourceOf(markdown, node, bodyLine) ?? "";
    blocks.push({
      id: id ?? autoBlockId(file, source),
      fingerprint: blockFingerprint(source),
      ...(id === undefined ? {} : { declared: true }),
      pos,
    });
  }
  if (pending !== undefined) reportUnused(pending);

  return { blocks, diagnostics };
}
