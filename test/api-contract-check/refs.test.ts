import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Page } from "../../src/contracts/content.ts";
import { codeRefsOf } from "../../src/drift/code-refs.ts";
import { contractRefsOf, contractTypos } from "../../src/drift/contract-refs.ts";
import { exportedSymbols, type ExportedSymbol } from "../../src/drift/symbols.ts";

const root = fileURLToPath(new URL("../../fixtures/api-contract-check/", import.meta.url));

/** A Markdown page whose body starts at `line` in its source file. */
function page(markdown: string): Page {
  return {
    url: "/widgets/",
    source: { file: "docs/widgets.md", line: 1, column: 1, endLine: 1, endColumn: 1 },
    frontMatter: {},
    title: "Widgets",
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "",
    markdown,
    kind: "doc",
  };
}

/** The fixture page and the symbols of the file it cites. */
async function fixture(): Promise<{ readonly markdown: string; readonly symbols: readonly ExportedSymbol[] }> {
  const [markdown, source] = await Promise.all([
    readFile(join(root, "docs/widgets.md"), "utf8"),
    readFile(join(root, "src/widget.ts"), "utf8"),
  ]);
  return { markdown, symbols: exportedSymbols(source, { file: "src/widget.ts" }).symbols };
}

test("a parameter and a member claim attach to the cited symbol", async () => {
  const { markdown, symbols } = await fixture();
  const refs = await contractRefsOf(page(markdown));

  assert.deepEqual(
    refs.map((ref) => [ref.symbol, ref.member, ref.memberKind, ref.path, ref.line, ref.pos.line]),
    [
      ["createWidget", "name", "parameter", "src/widget.ts", 10, 3],
      ["createWidget", "options", "parameter", "src/widget.ts", 10, 3],
      ["WidgetOptions", "id", "member", "src/widget.ts", 1, 5],
    ],
  );
  assert.equal(refs[0]?.file, "docs/widgets.md");
  assert.equal(refs[0]?.text, "createWidget(name: string, options?: WidgetOptions): Widget");
  assert.deepEqual(contractTypos(refs, symbols), []);
});

test("a misspelled member is reported at the documentation claim", async () => {
  const { markdown, symbols } = await fixture();
  const typo = markdown.replace("readonly id: string", "readonly idd: string");
  const refs = await contractRefsOf(page(typo));
  const claim = refs.find((ref) => ref.member === "idd");
  assert.ok(claim);

  const diagnostics = contractTypos(refs, symbols);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.id, "drift.signature-mismatch");
  assert.equal(diagnostics[0]?.severity, "warning");
  assert.deepEqual(diagnostics[0]?.pos, claim.pos);
  assert.equal(diagnostics[0]?.pos?.file, "docs/widgets.md");
  assert.equal(diagnostics[0]?.pos?.line, 5);
  assert.match(diagnostics[0]?.message ?? "", /"WidgetOptions".*"idd"/);
});

test("a plain reference stays a reference and records no claim", async () => {
  const { symbols } = await fixture();
  const body = "See `/src/widget.ts:10` for the entry point.";

  const refs = await contractRefsOf(page(body));
  assert.deepEqual(refs, []);
  assert.deepEqual(contractTypos(refs, symbols), []);

  const references = await codeRefsOf(page(body));
  assert.deepEqual(references.map((ref) => [ref.path, ref.line]), [["src/widget.ts", 10]]);
});
