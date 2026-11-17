import type { Element, ElementContent, Properties } from "hast";
import type { Data, Nodes, Parent, Root, RootContent, Text } from "mdast";
import type { Plugin } from "unified";
import type { Position } from "unist";
import type { Diagnostic, Severity } from "../../contracts/index.ts";
import { spanFromPosition } from "../../source/spans.ts";

/**
 * Inline (`$a^2$`) and block (`$$`-fenced lines) math, rendered to fixed MathML.
 *
 * The TeX source is never parsed as Markdown: a code span, a fenced block, raw HTML, and
 * front matter are not math. Every `<math>` carries `dir="ltr"`, an `alttext` with the TeX
 * source, and an `<annotation encoding="application/x-tex">`; the Markdown twin is the page's
 * source, so it keeps the original delimiters. `mathDiagnostics` reports broken formulas with
 * the source position of the formula; the build reports them after parsing.
 */

type ProblemId = "math.unclosed-block" | "math.empty" | "math.syntax" | "math.unsupported";

const SEVERITY: Readonly<Record<ProblemId, Severity>> = {
  "math.unclosed-block": "error",
  "math.empty": "warning",
  "math.syntax": "warning",
  "math.unsupported": "info",
};

interface MathProblem {
  readonly id: ProblemId;
  readonly severity: Severity;
  readonly message: string;
  readonly help?: string;
  /** The finding names only the opening line, not the node's whole span. */
  readonly point?: boolean;
}

/** Data this plugin puts on a node: MathML for the renderer, or the finding for the collector. */
interface MathData extends Data {
  readonly mathProblem?: MathProblem;
}

function problem(id: ProblemId, message: string, help?: string, point?: boolean): MathProblem {
  return {
    id,
    severity: SEVERITY[id],
    message,
    ...(help === undefined ? {} : { help }),
    ...(point === true ? { point: true } : {}),
  };
}

function withProblem(data: Data | undefined, finding: MathProblem): MathData {
  return { ...(data ?? {}), mathProblem: finding };
}

function text(value: string): ElementContent {
  return { type: "text", value };
}

function element(tagName: string, children: ElementContent[], properties: Properties = {}): Element {
  return { type: "element", tagName, properties, children };
}

/** The fixed serialization: the same TeX writes the same bytes on every machine. */
function mathData(tex: string, display: "inline" | "block", body: ElementContent[]): MathData {
  return {
    hName: "math",
    hProperties: {
      display,
      dir: "ltr",
      alttext: tex,
      xmlns: "http://www.w3.org/1998/Math/MathML",
    },
    hChildren: [
      element("semantics", [
        element("mrow", body),
        element("annotation", [text(tex)], { encoding: "application/x-tex" }),
      ]),
    ],
  };
}

/** The TeX subset of docs/math.md. Everything else keeps the formula as literal `<code>`. */
const GREEK: Readonly<Record<string, string>> = {
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ϵ",
  varepsilon: "ε",
  zeta: "ζ",
  eta: "η",
  theta: "θ",
  iota: "ι",
  kappa: "κ",
  lambda: "λ",
  mu: "μ",
  nu: "ν",
  xi: "ξ",
  omicron: "ο",
  pi: "π",
  rho: "ρ",
  sigma: "σ",
  tau: "τ",
  upsilon: "υ",
  phi: "ϕ",
  varphi: "φ",
  chi: "χ",
  psi: "ψ",
  omega: "ω",
  Gamma: "Γ",
  Delta: "Δ",
  Theta: "Θ",
  Lambda: "Λ",
  Xi: "Ξ",
  Pi: "Π",
  Sigma: "Σ",
  Upsilon: "Υ",
  Phi: "Φ",
  Psi: "Ψ",
  Omega: "Ω",
};

const OPERATORS = new Set(Array.from("+-*/=<>()[]|,.;:!?"));

const ESCAPES: Readonly<Record<string, string>> = {
  "{": "{",
  "}": "}",
  $: "$",
  "|": "‖",
  "\\": "\\",
};

interface Cursor {
  index: number;
}

type ParseResult =
  | { readonly ok: true; readonly nodes: ElementContent[] }
  | { readonly ok: false; readonly id: "math.syntax" | "math.unsupported"; readonly message: string };

function parsed(nodes: ElementContent[]): ParseResult {
  return { ok: true, nodes };
}

function failed(id: "math.syntax" | "math.unsupported", message: string): ParseResult {
  return { ok: false, id, message };
}

function skipSpace(source: string, at: Cursor): void {
  while (at.index < source.length && /\s/.test(source[at.index] ?? "")) at.index += 1;
}

function parseArgument(source: string, at: Cursor): ParseResult {
  skipSpace(source, at);
  if (at.index >= source.length) return failed("math.syntax", "A TeX command is missing its argument.");
  const ch = source[at.index] ?? "";
  if (ch === "{") {
    at.index += 1;
    const inner = parseSequence(source, at, true);
    if (!inner.ok) return inner;
    if (source[at.index] !== "}") return failed("math.syntax", "A group is missing its closing brace.");
    at.index += 1;
    return parsed([inner.nodes.length === 1 ? inner.nodes[0]! : element("mrow", inner.nodes)]);
  }
  if (ch === "\\") {
    const command = parseCommand(source, at);
    if (!command.ok) return command;
    return parsed(command.nodes.length === 1 ? command.nodes : [element("mrow", command.nodes)]);
  }
  return parseAtom(source, at);
}

function parseDelimiter(source: string, at: Cursor): ParseResult {
  skipSpace(source, at);
  if (at.index >= source.length) return failed("math.syntax", "\\left or \\right is missing its delimiter.");
  const ch = source[at.index] ?? "";
  if (ch === "\\") {
    at.index += 1;
    const name = source[at.index] ?? "";
    at.index += 1;
    const delimiter = ESCAPES[name];
    if (delimiter === undefined) return failed("math.unsupported", `The delimiter \\${name} is not supported in math.`);
    return parsed([element("mo", [text(delimiter)])]);
  }
  at.index += 1;
  if (ch === ".") return parsed([]);
  if ("()[]|{}".includes(ch)) return parsed([element("mo", [text(ch)])]);
  return failed("math.unsupported", `The delimiter "${ch}" is not supported in math.`);
}

function parseCommand(source: string, at: Cursor): ParseResult {
  at.index += 1;
  if (at.index >= source.length) return failed("math.syntax", "A backslash has no command.");
  const first = source[at.index] ?? "";
  if (!/[A-Za-z]/.test(first)) {
    at.index += 1;
    if (first === " " || first === "," || first === ";" || first === ":") return parsed([]);
    const symbol = ESCAPES[first];
    if (symbol === undefined) return failed("math.unsupported", `The TeX escape \\${first} is not supported in math.`);
    return parsed([element("mo", [text(symbol)])]);
  }
  let end = at.index;
  while (end < source.length && /[A-Za-z]/.test(source[end] ?? "")) end += 1;
  const word = source.slice(at.index, end);
  at.index = end;
  if (word === "frac" || word === "sqrt") {
    const firstArgument = parseArgument(source, at);
    if (!firstArgument.ok) return firstArgument;
    if (word === "sqrt") return parsed([element("msqrt", [firstArgument.nodes[0]!])]);
    const secondArgument = parseArgument(source, at);
    if (!secondArgument.ok) return secondArgument;
    return parsed([element("mfrac", [firstArgument.nodes[0]!, secondArgument.nodes[0]!])]);
  }
  if (word === "sum") return parsed([element("mo", [text("∑")])]);
  if (word === "int") return parsed([element("mo", [text("∫")])]);
  if (word === "left" || word === "right") return parseDelimiter(source, at);
  const greek = GREEK[word];
  if (greek !== undefined) return parsed([element("mi", [text(greek)])]);
  return failed("math.unsupported", `The TeX command \\${word} is not supported in math.`);
}

function parseAtom(source: string, at: Cursor): ParseResult {
  const ch = source[at.index] ?? "";
  if (/[0-9]/.test(ch)) {
    let end = at.index + 1;
    while (end < source.length && /[0-9]/.test(source[end] ?? "")) end += 1;
    if (source[end] === "." && /[0-9]/.test(source[end + 1] ?? "")) {
      end += 1;
      while (end < source.length && /[0-9]/.test(source[end] ?? "")) end += 1;
    }
    const value = source.slice(at.index, end);
    at.index = end;
    return parsed([element("mn", [text(value)])]);
  }
  if (/\p{L}/u.test(ch)) {
    at.index += 1;
    return parsed([element("mi", [text(ch)])]);
  }
  if (OPERATORS.has(ch)) {
    at.index += 1;
    return parsed([element("mo", [text(ch)])]);
  }
  return failed("math.unsupported", `The character "${ch}" is not supported in math.`);
}

function attachScript(nodes: ElementContent[], marker: "^" | "_", argument: ElementContent): ParseResult {
  const base = nodes.pop();
  if (base === undefined) return failed("math.syntax", "A TeX script has no base.");
  if (base.type !== "element") return failed("math.syntax", "A TeX script has no base.");
  if (base.tagName === "msubsup") return failed("math.syntax", "A TeX base has too many subscripts or superscripts.");
  if (marker === "_" && base.tagName === "msub") return failed("math.syntax", "A TeX base has two subscripts.");
  if (marker === "^" && base.tagName === "msup") return failed("math.syntax", "A TeX base has two superscripts.");
  if (base.tagName === "msup" || base.tagName === "msub") {
    const body = base.children[0]!;
    const script = base.children[1]!;
    nodes.push(
      marker === "^"
        ? element("msubsup", [body, argument, script])
        : element("msubsup", [body, script, argument]),
    );
    return parsed(nodes);
  }
  nodes.push(element(marker === "^" ? "msup" : "msub", [base, argument]));
  return parsed(nodes);
}

function parseSequence(source: string, at: Cursor, inGroup: boolean): ParseResult {
  const nodes: ElementContent[] = [];
  while (at.index < source.length) {
    const ch = source[at.index] ?? "";
    if (ch === "}") {
      if (inGroup) return parsed(nodes);
      return failed("math.syntax", "A closing brace has no opening brace.");
    }
    if (/\s/.test(ch)) {
      at.index += 1;
      continue;
    }
    if (ch === "{") {
      at.index += 1;
      const inner = parseSequence(source, at, true);
      if (!inner.ok) return inner;
      if (source[at.index] !== "}") return failed("math.syntax", "A group is missing its closing brace.");
      at.index += 1;
      nodes.push(element("mrow", inner.nodes));
      continue;
    }
    if (ch === "^" || ch === "_") {
      at.index += 1;
      const argument = parseArgument(source, at);
      if (!argument.ok) return argument;
      const scripted = attachScript(nodes, ch, argument.nodes[0]!);
      if (!scripted.ok) return scripted;
      continue;
    }
    if (ch === "\\") {
      const command = parseCommand(source, at);
      if (!command.ok) return command;
      nodes.push(...command.nodes);
      continue;
    }
    const atom = parseAtom(source, at);
    if (!atom.ok) return atom;
    nodes.push(...atom.nodes);
  }
  if (inGroup) return failed("math.syntax", "A group is missing its closing brace.");
  return parsed(nodes);
}

/** The MathML tree of one TeX formula, or why it cannot be rendered. */
function parseMath(tex: string): ParseResult {
  return parseSequence(tex, { index: 0 }, false);
}

interface Context {
  readonly source: string;
  readonly starts: readonly number[];
  readonly lines: readonly string[];
}

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function point(starts: readonly number[], offset: number): { line: number; column: number; offset: number } {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((starts[middle] ?? 0) <= offset) low = middle;
    else high = middle - 1;
  }
  return { line: low + 1, column: offset - (starts[low] ?? 0) + 1, offset };
}

function positionOf(context: Context, start: number, end: number): Position {
  return { start: point(context.starts, start), end: point(context.starts, end) };
}

function escapedAt(source: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

// shortcut: an inline formula split by parsed emphasis (`$a*b*c$`) stays literal; upgrade to a
// micromark extension when inline math must win over emphasis.
function inlineNodes(textNode: Text, context: Context): RootContent[] | undefined {
  const position = textNode.position;
  const start = position?.start.offset;
  const end = position?.end.offset;
  if (position === undefined || start === undefined || end === undefined) return undefined;

  const dollars: number[] = [];
  for (let index = 0; index < textNode.value.length; index += 1) {
    if (textNode.value[index] === "$") dollars.push(index);
  }
  if (dollars.length === 0) return undefined;

  const raw = context.source.slice(start, end);
  const rawDollars: number[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] === "$") rawDollars.push(start + index);
  }
  const mapped = rawDollars.length === dollars.length;
  const escaped = dollars.map((_, index) => (mapped ? escapedAt(context.source, rawDollars[index]!) : false));

  const out: RootContent[] = [];
  let cursor = 0;
  let index = 0;
  while (index < dollars.length) {
    const open = dollars[index]!;
    if (open < cursor || escaped[index] === true) {
      index += 1;
      continue;
    }
    if (open > cursor) out.push({ type: "text", value: textNode.value.slice(cursor, open) });

    if (textNode.value[open + 1] === "$" && escaped[index + 1] !== true) {
      const from = rawDollars[index] ?? open;
      const to = (rawDollars[index + 1] ?? open + 1) + 1;
      out.push({
        type: "text",
        value: "$$",
        position: positionOf(context, from, to),
        data: withProblem(undefined, problem("math.empty", "The math pair has no TeX source.")),
      });
      cursor = open + 2;
      index += 2;
      continue;
    }

    let close = -1;
    for (let candidate = index + 1; candidate < dollars.length; candidate += 1) {
      const at = dollars[candidate]!;
      if (escaped[candidate] === true) continue;
      if (textNode.value.slice(open + 1, at).includes("\n")) break;
      if (at === open + 1 || /\s/.test(textNode.value[at - 1] ?? "")) continue;
      close = candidate;
      break;
    }
    if (close === -1 || /\s/.test(textNode.value[open + 1] ?? "")) {
      out.push({ type: "text", value: "$" });
      cursor = open + 1;
      index += 1;
      continue;
    }

    const closeIndex = dollars[close]!;
    const from = rawDollars[index] ?? open;
    const to = (rawDollars[close] ?? closeIndex) + 1;
    const tex = mapped
      ? context.source.slice(from + 1, to - 1)
      : textNode.value.slice(open + 1, closeIndex);
    const span = positionOf(context, from, to);
    const math = parseMath(tex);
    if (math.ok) {
      out.push({ type: "text", value: tex, position: span, data: mathData(tex, "inline", math.nodes) });
    } else {
      out.push({
        type: "inlineCode",
        value: tex,
        position: span,
        data: withProblem(undefined, problem(math.id, math.message)),
      });
    }
    cursor = closeIndex + 1;
    index = close + 1;
  }

  if (cursor < textNode.value.length) out.push({ type: "text", value: textNode.value.slice(cursor) });
  return out.length === 0 ? undefined : out;
}

function blockMath(parent: Parent, context: Context): number | undefined {
  const children = parent.children as RootContent[];
  for (let index = 0; index < children.length; index += 1) {
    const start = children[index];
    if (start === undefined || start.type !== "paragraph" || start.position === undefined) continue;
    if ((context.lines[start.position.start.line - 1] ?? "").trim() !== "$$") continue;

    let endIndex = -1;
    let closing = -1;
    for (let candidate = index; candidate < children.length; candidate += 1) {
      const sibling = children[candidate];
      if (sibling === undefined || sibling.type !== "paragraph" || sibling.position === undefined) break;
      const first = candidate === index ? start.position.start.line + 1 : sibling.position.start.line;
      for (let line = first; line <= sibling.position.end.line; line += 1) {
        if ((context.lines[line - 1] ?? "").trim() === "$$") {
          closing = line;
          endIndex = candidate;
          break;
        }
      }
      if (closing !== -1) break;
    }

    if (closing === -1) {
      start.data = withProblem(start.data, problem(
        "math.unclosed-block",
        "The math block opened here has no closing $$ line.",
        "Close the block with a line that holds only $$.",
        true,
      ));
      return start.position.start.line;
    }

    const tex = context.lines.slice(start.position.start.line, closing - 1).join("\n");
    const closingLine = context.lines[closing - 1] ?? "";
    const span: Position = {
      start: start.position.start,
      end: {
        line: closing,
        column: closingLine.length + 1,
        offset: (context.starts[closing - 1] ?? 0) + closingLine.length,
      },
    };

    if (tex.trim() === "") {
      start.data = withProblem(start.data, problem("math.empty", "The math block has no TeX source."));
      index = endIndex;
      continue;
    }

    const math = parseMath(tex);
    if (math.ok) {
      children.splice(index, endIndex - index + 1, {
        type: "paragraph",
        children: [],
        position: span,
        data: mathData(tex, "block", math.nodes),
      });
      continue;
    }
    children.splice(index, endIndex - index + 1, {
      type: "code",
      lang: null,
      value: tex,
      position: span,
      data: withProblem(undefined, problem(math.id, math.message)),
    });
  }
  return undefined;
}

function transform(parent: Parent, context: Context, stopLine?: number): void {
  const stop = stopLine ?? blockMath(parent, context);
  const children = parent.children as RootContent[];
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (child === undefined) continue;
    if ((child.data as MathData | undefined)?.mathProblem !== undefined) continue;
    if (stop !== undefined && (child.position?.start.line ?? 0) >= stop) continue;
    if (child.type === "text") {
      const parts = inlineNodes(child, context);
      if (parts === undefined) continue;
      children.splice(index, 1, ...parts);
      index += parts.length - 1;
    } else if ("children" in child) {
      transform(child as Parent, context, stop);
    }
  }
}

function visit(node: Nodes, visitFn: (node: Nodes) => void): void {
  visitFn(node);
  if ("children" in node) {
    for (const child of node.children) visit(child, visitFn);
  }
}

/**
 * Reports every broken formula in `tree`, in document order, with the formula's source span.
 * `file` is the page's source path relative to the site, as `Page.source.file` gives it.
 */
export function mathDiagnostics(tree: Root, file: string): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  visit(tree, (node) => {
    const finding = (node.data as MathData | undefined)?.mathProblem;
    if (finding === undefined || node.position === undefined) return;
    const pos = finding.point === true
      ? {
          file,
          line: node.position.start.line,
          column: node.position.start.column,
          endLine: node.position.start.line,
          endColumn: node.position.start.column + 1,
        }
      : spanFromPosition(file, node.position);
    diagnostics.push({
      id: finding.id,
      severity: finding.severity,
      message: finding.message,
      pos,
      ...(finding.help === undefined ? {} : { help: finding.help }),
    });
  });
  return diagnostics;
}

export const name = "math";
export const order = 5;
export const plugin: Plugin<[], Root> = () => (tree, file) => {
  const source = String(file);
  transform(tree, { source, starts: lineStarts(source), lines: source.split("\n") });
};
