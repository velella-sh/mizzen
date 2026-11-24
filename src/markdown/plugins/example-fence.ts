import type { Code, Data, Nodes, Parent, Root } from "mdast";
import type { Plugin } from "unified";
import type { Page } from "../../contracts/index.ts";
import { parseExampleSyntax, type ExampleMatch, type ExampleRole, type ExampleSnippet, type ExampleSyntax } from "../../examples/syntax.ts";
import { spanFromPosition } from "../../source/spans.ts";
import { parseMarkdown } from "../parse.ts";

/**
 * Marks fences that are runnable examples, so later stages can run them and compare their output.
 *
 * A fence is an example when its meta contains the bare token `test`, for example:
 *
 *   ```ts test
 *   console.log("hi");
 *   ```
 *
 * The bare token is matched as one whitespace-separated meta token, so `title="test"` and
 * `testify` are not a `test`. Fences without it are not touched: their HTML is unchanged.
 *
 * The expected output is the fenced block whose language is `output` directly after the
 * example (blank lines between the two are fine; any other block is not):
 *
 *   ```ts test
 *   console.log("hi");
 *   ```
 *   ```output
 *   hi
 *   ```
 *
 * The output fence is left in place and still renders as a plain code fence. The example node
 * gets `data.example` with its id, language, and expected text, and `data.hProperties` with
 * `data-example="true"`, `data-example-lang`, and `data-example-id`, which become attributes in
 * the page HTML.
 *
 * The id is the example's one-based order on the page, `example-1`, `example-2`, …, in document
 * order. It is deterministic and does not move when front matter or prose above it changes.
 *
 * `examplesIn(tree)` reads the examples the plugin recorded; `examplesOf(page)` re-parses the
 * page's Markdown from `page.source.line` and returns the same records with the page's file.
 */

/** What the plugin records on an example's mdast node, under `data.example`. */
export interface ExampleMeta {
  /** Stable id within the page: `example-<order>`, or the author's `id="..."`. */
  readonly id: string;
  /** The fence's language, or `""` when it has none. */
  readonly lang: string;
  /** The adjacent `output` fence's source, or `null` when absent. Kept for older readers. */
  readonly expected: string | null;
  /** The adjacent `stderr` fence's source; absent when there is none. */
  readonly expectedStderr?: string;
  /** The author's opt-in role; absent for a normal example. */
  readonly role?: Exclude<ExampleRole, "output">;
  /** True when the block is hidden from the public HTML but kept in the Markdown twin. */
  readonly hidden?: true;
  /** The shared session this block runs in, when declared. */
  readonly session?: string;
  /** The runbook a `step` block belongs to. */
  readonly runbook?: string;
  /** A command that must exit zero before the step runs. */
  readonly precondition?: string;
  /** The snippet this block reads, when declared. */
  readonly snippet?: ExampleSnippet;
  /** How the `output` fence is compared; absent means `exact`. */
  readonly stdoutMatch?: Exclude<ExampleMatch, "exact">;
  /** How the `stderr` fence is compared; absent means `exact`. */
  readonly stderrMatch?: Exclude<ExampleMatch, "exact">;
  /** `allow` when the block opts into the network; absent means the runner denies it. */
  readonly network?: "allow";
  /** Per-block timeout in milliseconds, when declared. */
  readonly timeoutMs?: number;
  /** Per-block V8 old-space limit in MiB, when declared. */
  readonly memoryMb?: number;
}

/** A run of the source an example came from, 1-based and end-inclusive. */
export interface ExampleSpan {
  /** Path of the source file, relative to the repository root; only `examplesOf` sets it. */
  readonly file?: string;
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
}

/** One runnable example, as later stages see it. */
export interface MarkdownExample {
  readonly id: string;
  readonly lang: string;
  readonly code: string;
  /** The adjacent `output` fence's source, or `null` when absent. */
  readonly expected: string | null;
  /** The adjacent `stderr` fence's source; absent when there is none. */
  readonly expectedStderr?: string;
  /** A hidden setup or teardown block, or a runbook `step`; absent for a normal example. */
  readonly role?: Exclude<ExampleRole, "output">;
  /** True when the block is hidden from the public HTML but kept in the Markdown twin. */
  readonly hidden?: true;
  readonly session?: string;
  readonly runbook?: string;
  readonly precondition?: string;
  readonly snippet?: ExampleSnippet;
  /** How the `output` fence is compared; absent means `exact`. */
  readonly stdoutMatch?: Exclude<ExampleMatch, "exact">;
  /** How the `stderr` fence is compared; absent means `exact`. */
  readonly stderrMatch?: Exclude<ExampleMatch, "exact">;
  /** `allow` when the block opts into the network; absent means the runner denies it. */
  readonly network?: "allow";
  readonly timeoutMs?: number;
  readonly memoryMb?: number;
  readonly pos: ExampleSpan;
}

/** The data an example's code node carries. */
interface ExampleData extends Data {
  readonly example: ExampleMeta;
}

/** The language of the fence that follows an example and holds its expected output. */
const OUTPUT_LANG = "output";

export const name = "example-fence";
export const order = 15;

/**
 * Splits a fence meta string into tokens, keeping a quoted value or a `{...}` list together with
 * its key. Only an exact bare `test` token marks an example.
 */
function metaTokens(meta: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < meta.length) {
    while (i < meta.length && /\s/.test(meta.charAt(i))) i++;
    if (i >= meta.length) break;
    const start = i;
    let quote: string | null = null;
    while (i < meta.length) {
      const char = meta.charAt(i);
      if (quote !== null) {
        if (char === quote) quote = null;
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (/\s/.test(char)) {
        break;
      }
      i++;
    }
    tokens.push(meta.slice(start, i));
  }
  return tokens;
}

/** True when the meta has `test` as a bare token. */
export function isExampleMeta(meta: string | null | undefined): boolean {
  return meta ? metaTokens(meta).includes("test") : false;
}

/** The language of the fence that directly follows an example and holds its expected stderr. */
const STDERR_LANG = "stderr";

/** True for a fence whose language is `lang`, ignoring case. */
function isFence(node: Nodes | undefined, lang: string): node is Code {
  return node?.type === "code" && (node.lang ?? "").toLowerCase() === lang;
}

/** The `output`/`stderr` fences directly after `index` among `children`, or `undefined` for each absent one. */
function expectedAfter(children: readonly Nodes[], index: number): { stdout?: Code; stderr?: Code } {
  const first = children[index + 1];
  if (isFence(first, OUTPUT_LANG)) {
    const after = children[index + 2];
    return { stdout: first, ...(isFence(after, STDERR_LANG) ? { stderr: after } : {}) };
  }
  if (isFence(first, STDERR_LANG)) return { stderr: first };
  return {};
}

/** True when an expected-output fence's meta asks for pattern matching, e.g. `match="pattern"` or `regex`. */
function patternFence(fence: Code | undefined): boolean {
  if (fence === undefined) return false;
  const syntax = parseExampleSyntax(fence.meta);
  return syntax.stdout === "pattern";
}

/**
 * The node's span, with remark's exclusive end turned into the engine's inclusive end,
 * or zeros when a hand-built node has no position. Only the numbers are used; the file comes from
 * `examplesOf`.
 */
function spanOf(node: Code): ExampleSpan {
  if (!node.position) return { line: 0, column: 0, endLine: 0, endColumn: 0 };
  const span = spanFromPosition("", node.position);
  return { line: span.line, column: span.column, endLine: span.endLine, endColumn: span.endColumn };
}

/** The stable id of an example: its one-based order on the page. */
function idOf(order: number): string {
  return `example-${order}`;
}

/** Marks examples among one parent's children, then descends into them. */
function mark(parent: Parent, order: { value: number }): void {
  const children = parent.children;
  for (let i = 0; i < children.length; i++) {
    const node = children[i];
    if (node === undefined) continue;
    if (node.type === "code" && isExampleMeta(node.meta)) {
      order.value += 1;
      const syntax: ExampleSyntax = parseExampleSyntax(node.meta);
      const id = syntax.id ?? idOf(order.value);
      const lang = node.lang ?? "";
      const adjacent = expectedAfter(children, i);
      // The expected-output fence may ask for a pattern match; the example itself may too, and either sets it.
      const stdoutMatch: "pattern" | undefined =
        syntax.stdout === "pattern" || patternFence(adjacent.stdout) ? "pattern" : undefined;
      const stderrMatch: "pattern" | undefined =
        syntax.stderr === "pattern" || patternFence(adjacent.stderr) ? "pattern" : undefined;
      const data = (node.data ??= {}) as Record<string, unknown>;
      const example: ExampleMeta = {
        id,
        lang,
        expected: adjacent.stdout?.value ?? null,
        ...(adjacent.stderr === undefined ? {} : { expectedStderr: adjacent.stderr.value }),
        ...(syntax.role === "output" ? {} : { role: syntax.role }),
        ...(syntax.hidden ? { hidden: true as const } : {}),
        ...(syntax.session === undefined ? {} : { session: syntax.session }),
        ...(syntax.runbook === undefined ? {} : { runbook: syntax.runbook }),
        ...(syntax.precondition === undefined ? {} : { precondition: syntax.precondition }),
        ...(syntax.snippet === undefined ? {} : { snippet: syntax.snippet }),
        ...(stdoutMatch === undefined ? {} : { stdoutMatch }),
        ...(stderrMatch === undefined ? {} : { stderrMatch }),
        ...(syntax.network === "allow" ? { network: "allow" as const } : {}),
        ...(syntax.timeoutMs === undefined ? {} : { timeoutMs: syntax.timeoutMs }),
        ...(syntax.memoryMb === undefined ? {} : { memoryMb: syntax.memoryMb }),
      };
      data.example = example;
      data.hProperties = {
        ...(data.hProperties as Record<string, unknown> | undefined),
        "data-example": "true",
        "data-example-lang": lang,
        "data-example-id": id,
        ...(syntax.hidden ? { "data-example-hidden": "true" } : {}),
      };
      // A hidden block takes its expected-output fences with it: the setup's own stdout is not public text either.
      if (syntax.hidden) {
        for (const fence of [adjacent.stdout, adjacent.stderr]) {
          if (fence !== undefined) hideFence(fence);
        }
      }
    }
    if ("children" in node) mark(node as Parent, order);
  }
}

/** Marks a non-example fence as hidden, so the HTML stage drops it while the Markdown twin keeps its source. */
function hideFence(node: Code): void {
  const data = (node.data ??= {}) as Record<string, unknown>;
  data.hProperties = { ...(data.hProperties as Record<string, unknown> | undefined), "data-example-hidden": "true" };
}

/** Visits every node in document order. */
function visit(node: Nodes, visitFn: (n: Nodes) => void): void {
  visitFn(node);
  if ("children" in node) {
    for (const child of node.children) visit(child, visitFn);
  }
}

/** Every example the plugin recorded in `tree`, in document order. */
export function examplesIn(tree: Root): MarkdownExample[] {
  const examples: MarkdownExample[] = [];
  visit(tree, (node) => {
    if (node.type !== "code") return;
    const example = (node.data as ExampleData | undefined)?.example;
    if (!example) return;
    examples.push({ ...example, code: node.value, pos: spanOf(node) });
  });
  return examples;
}

/**
 * Every example in `page`, in document order, with positions in the page's source file.
 *
 * The page's Markdown body is re-parsed from `page.source.line`, the line where its content
 * starts, so the spans match the ones the build reports for the page.
 */
export async function examplesOf(page: Page): Promise<MarkdownExample[]> {
  const tree = await parseMarkdown(page.markdown, page.source.line);
  return examplesIn(tree).map((example) => ({
    ...example,
    pos: { file: page.source.file, ...example.pos },
  }));
}

export const plugin: Plugin<[], Root> = () => (tree) => {
  mark(tree, { value: 0 });
};
