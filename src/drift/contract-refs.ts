import type { Nodes, Root } from "mdast";
import type { Diagnostic, Page, SourcePos } from "../contracts/index.ts";
import { parseMarkdown } from "../markdown/parse.ts";
import { spanFromPosition, type NodePosition } from "../source/spans.ts";
import { codeRefsIn, type CodeRef } from "./code-refs.ts";
import { documentedClaim, type DocumentedClaim, type ExportedSymbol, type SignatureParam } from "./symbols.ts";

/**
 * Documentation claims attached to the code API (`api-contract-check`): the inline code a page writes
 * in a reference's paragraph, recorded against the code path and line it cites.
 *
 * - A claim names a symbol and may state its parameters (`createWidget(name: string)`) or its
 *   members (`interface WidgetOptions { readonly id: string }`). One {@link ContractRef} is recorded
 *   per stated parameter or member, at the span of the inline code that made the claim.
 * - A claim with no readable signature still records the symbol, so a call with no arguments and a
 *   bare name are attached without invented parameters.
 * - A member the target declaration does not have is a typo. {@link contractTypos} reports it at the
 *   documentation claim, never at the code, and leaves a parameter name alone: parameter names may
 *   be spelled differently by the page.
 * - A reference with no inline code stays a plain path/line reference, unchanged and unclaimed.
 */

/** One documentation claim attached to the symbol, member, or parameter it names. */
export interface ContractRef {
  /** The documentation file, relative to the repository root. */
  readonly file: string;
  /** The span of the inline code that makes the claim, which is where a typo is reported. */
  readonly pos: SourcePos;
  /** The cited code file, relative to the repository root. */
  readonly path: string;
  /** The first cited line, 1-based. */
  readonly line: number;
  /** The last cited line, when the reference names a range. */
  readonly endLine?: number;
  /** The symbol the claim names. */
  readonly symbol: string;
  /** The member or parameter the claim states, when it states one. */
  readonly member?: string;
  /** What {@link member} is: a class or interface member, or a function parameter. */
  readonly memberKind?: "member" | "parameter";
  /** The inline code exactly as the page wrote it. */
  readonly text: string;
}

/** One inline-code claim inside a paragraph. */
interface Claim {
  readonly documented: DocumentedClaim;
  readonly text: string;
  readonly line: number;
  readonly column: number;
  readonly pos: SourcePos;
}

/** A paragraph's source box, with the claims inside it. */
interface Paragraph {
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
  readonly claims: readonly Claim[];
}

/** Markdown pages only: an HTML page's body is not Markdown, so it has no Markdown claims. */
const MARKDOWN_FILE = /\.(?:md|markdown)$/i;

/** Every paragraph in a parsed page, in document order. */
function paragraphsOf(tree: Nodes, file: string | undefined): Paragraph[] {
  const out: Paragraph[] = [];
  walkParagraphs(tree, file, out);
  return out;
}

/** Walks a parsed page, adding each positioned paragraph with the inline code it holds. */
function walkParagraphs(node: Nodes, file: string | undefined, out: Paragraph[]): void {
  if (node.type === "paragraph" && node.position) {
    out.push({
      startLine: node.position.start.line,
      startColumn: node.position.start.column,
      endLine: node.position.end.line,
      endColumn: node.position.end.column,
      claims: claimsIn(node, file),
    });
  }
  if ("children" in node) for (const child of node.children) walkParagraphs(child, file, out);
}

/** Every inline code in one paragraph that reads as a claim, in document order. */
function claimsIn(node: Nodes, file: string | undefined): Claim[] {
  const out: Claim[] = [];
  collectClaims(node, file, out);
  return out;
}

/** Reads inline code as a claim; other inline nodes are walked for code nested in them. */
function collectClaims(node: Nodes, file: string | undefined, out: Claim[]): void {
  if (node.type === "inlineCode") {
    const claim = claimOf(node.value, node.position, file);
    if (claim !== null) out.push(claim);
    return;
  }
  if ("children" in node) for (const child of node.children) collectClaims(child, file, out);
}

/** Reads one inline code's text as a claim, or null when it names no symbol. */
function claimOf(value: string, position: NodePosition | undefined, file: string | undefined): Claim | null {
  if (position === undefined) return null;
  const documented = documentedClaim(value);
  if (documented === null) return null;
  return {
    documented,
    text: value.trim(),
    line: position.start.line,
    column: position.start.column,
    pos: spanFromPosition(file ?? "", position),
  };
}

/** The paragraph whose span holds `pos`, if any. */
function paragraphFor(pos: SourcePos, paragraphs: readonly Paragraph[]): Paragraph | undefined {
  for (const paragraph of paragraphs) {
    if (atOrAfter(pos, paragraph) && atOrBefore({ line: pos.endLine, column: pos.endColumn }, paragraph)) {
      return paragraph;
    }
  }
  return undefined;
}

/** True when the start of `pos` is at or after the paragraph's start. */
function atOrAfter(pos: SourcePos, box: Paragraph): boolean {
  return pos.line > box.startLine || (pos.line === box.startLine && pos.column >= box.startColumn);
}

/** True when a point is at or before the paragraph's end. */
function atOrBefore(point: { readonly line: number; readonly column: number }, box: Paragraph): boolean {
  return point.line < box.endLine || (point.line === box.endLine && point.column <= box.endColumn);
}

/** The claim nearest the reference, by line and column, then name. */
function nearestClaim(claims: readonly Claim[], ref: CodeRef): Claim {
  let best = claims[0] as Claim;
  let bestDistance = claimDistance(best, ref);
  for (const claim of claims) {
    const distance = claimDistance(claim, ref);
    if (distance < bestDistance || (distance === bestDistance && claim.documented.name < best.documented.name)) {
      best = claim;
      bestDistance = distance;
    }
  }
  return best;
}

/** A rough distance from a claim to the reference: lines first, then columns. */
function claimDistance(claim: Claim, ref: CodeRef): number {
  return Math.abs(claim.line - ref.pos.line) * 1_000_000 + Math.abs(claim.column - ref.pos.column);
}

/** One stated member or parameter; absent for a claim that states no name. */
interface Target {
  readonly member?: string;
  readonly memberKind?: "member" | "parameter";
}

/** The members or parameters a claim states, in the order it states them. */
function targetsOf(claim: Claim): readonly Target[] {
  const signature = claim.documented.signature;
  if (signature === undefined) return [{}];

  if (claim.documented.kind === "class" || claim.documented.kind === "interface") {
    const members = (signature.members ?? []).flatMap((member) => {
      const name = memberName(member);
      return name === undefined ? [] : [{ member: name, memberKind: "member" as const }];
    });
    return members.length === 0 ? [{}] : members;
  }

  const parameters = (signature.params ?? []).flatMap((param) => {
    const name = parameterName(param);
    return name === undefined ? [] : [{ member: name, memberKind: "parameter" as const }];
  });
  return parameters.length === 0 ? [{}] : parameters;
}

/** A parameter's plain name; `this` and destructured parameters state no attachable name. */
function parameterName(param: SignatureParam): string | undefined {
  return param.name === undefined || param.name === "this" ? undefined : param.name;
}

/** Modifiers a canonical member may keep before its name. */
const MEMBER_PREFIX = /^(?:readonly|static|abstract|async|get|set)\s+/;

/** A member's plain name from its canonical signature, or undefined for a constructor or index signature. */
function memberName(member: string): string | undefined {
  let text = member.trim();
  for (;;) {
    const prefix = MEMBER_PREFIX.exec(text);
    if (prefix === null) break;
    text = text.slice(prefix[0].length);
  }
  const name = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(text)?.[0];
  return name === undefined || name === "constructor" ? undefined : name;
}

/**
 * Every documentation claim in a parsed page, in document order, each attached to the nearest code
 * reference in its paragraph. A paragraph without a reference makes no claim.
 *
 * `file` is the page's source path relative to the repository root; it is both the folder references
 * resolve from and the `file` on every returned span.
 */
export function contractRefsIn(tree: Root, file?: string): ContractRef[] {
  const paragraphs = paragraphsOf(tree, file);
  const out: ContractRef[] = [];
  for (const ref of codeRefsIn(tree, file)) {
    const paragraph = paragraphFor(ref.pos, paragraphs);
    if (paragraph === undefined || paragraph.claims.length === 0) continue;
    const claim = nearestClaim(paragraph.claims, ref);
    for (const target of targetsOf(claim)) {
      out.push({
        file: claim.pos.file,
        pos: claim.pos,
        path: ref.path,
        line: ref.line,
        ...(ref.endLine === undefined ? {} : { endLine: ref.endLine }),
        symbol: claim.documented.name,
        ...(target.member === undefined ? {} : { member: target.member }),
        ...(target.memberKind === undefined ? {} : { memberKind: target.memberKind }),
        text: claim.text,
      });
    }
  }
  return out;
}

/**
 * Every documentation claim in a page, parsed from `page.markdown` at `page.source.line`, with paths
 * resolved from the page's source folder. HTML pages hold no Markdown, so they return no claims.
 */
export async function contractRefsOf(page: Page): Promise<ContractRef[]> {
  if (page.kind !== "doc" || !MARKDOWN_FILE.test(page.source.file)) return [];
  const tree = await parseMarkdown(page.markdown, page.source.line);
  return contractRefsIn(tree, page.source.file);
}

/**
 * Reports a stated member the cited declaration does not have, as a typo at the documentation claim.
 *
 * Only class and interface members are judged; a parameter name may differ from the declaration's.
 * A symbol that is missing or whose members the scanner could not read is left to the later checks,
 * so this function never guesses.
 */
export function contractTypos(
  refs: readonly ContractRef[],
  symbols: readonly ExportedSymbol[],
): Diagnostic[] {
  const exported = new Map(symbols.map((symbol) => [symbol.name, symbol]));
  const out: Diagnostic[] = [];
  for (const ref of refs) {
    if (ref.memberKind !== "member" || ref.member === undefined) continue;
    const symbol = exported.get(ref.symbol);
    if (symbol === undefined || (symbol.kind !== "class" && symbol.kind !== "interface")) continue;
    const signatures = symbol.signatures ?? [];
    if (signatures.length === 0) continue;

    const declared = new Set<string>();
    for (const signature of signatures) {
      for (const member of signature.members ?? []) {
        const name = memberName(member);
        if (name !== undefined) declared.add(name);
      }
    }
    if (!declared.has(ref.member)) out.push(typo(ref, ref.member, symbol.name));
  }
  return out;
}

/** The page states a member the declaration does not have. */
function typo(ref: ContractRef, member: string, symbol: string): Diagnostic {
  return {
    id: "drift.signature-mismatch",
    severity: "warning",
    message: `"${ref.path}" declares "${symbol}" without the member "${member}", which this page documents at line ${ref.pos.line}.`,
    pos: ref.pos,
    help: "Fix the member name in this documentation, or change the code.",
  };
}
