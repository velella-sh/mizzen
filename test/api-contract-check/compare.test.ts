import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Page } from "../../src/contracts/content.ts";
import { compareContractClaims } from "../../src/drift/contract-compare.ts";

const fixture = fileURLToPath(new URL("../../fixtures/api-contract-check/", import.meta.url));

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

/** The fixture page. */
async function fixturePage(): Promise<string> {
  return readFile(join(fixture, "docs/widgets.md"), "utf8");
}

/** The findings of one Markdown body against a site root. */
async function findings(markdown: string, root = fixture): Promise<Awaited<ReturnType<typeof compareContractClaims>>> {
  return compareContractClaims([page(markdown)], { root });
}

/** Just the diagnostics, which is what a report carries. */
async function diagnostics(markdown: string, root = fixture): Promise<string[]> {
  const checks = await findings(markdown, root);
  return checks.flatMap((check) => (check.diagnostic === undefined ? [] : [check.diagnostic.id]));
}

/** A site root under the OS temp folder; the caller removes it. */
function site(): string {
  return mkdtempSync(join(tmpdir(), "api-contract-compare-"));
}

/** Writes one file inside `root`, creating its folders. */
function write(root: string, path: string, text: string): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

test("a matching claim is clean and a body-only change stays clean", async () => {
  const markdown = await fixturePage();
  const clean = await findings(markdown);
  assert.equal(clean.length, 2);
  assert.deepEqual(clean.map((check) => check.state), ["match", "match"]);
  assert.deepEqual(await diagnostics(markdown), []);

  const root = site();
  try {
    const source = await readFile(join(fixture, "src/widget.ts"), "utf8");
    write(root, "src/widget.ts", source.replace("  return new Widget();", "  const widget = new Widget();\n  return widget;"));
    assert.deepEqual(await diagnostics(markdown, root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a changed parameter and a changed member are separate signature mismatches", async () => {
  const markdown = await fixturePage();

  const parameter = await findings(markdown.replace("name: string", "name: number"));
  assert.deepEqual(parameter.filter((check) => check.state !== "match").map((check) => check.state), ["mismatch"]);
  const parameterFinding = parameter.find((check) => check.diagnostic !== undefined)?.diagnostic;
  assert.equal(parameterFinding?.id, "drift.signature-mismatch");
  assert.equal(parameterFinding?.pos?.file, "docs/widgets.md");
  assert.equal(parameterFinding?.pos?.line, 3);
  assert.match(parameterFinding?.message ?? "", /name: number/);
  assert.match(parameterFinding?.message ?? "", /"src\/widget\.ts"/);

  const member = await findings(markdown.replace("readonly id: string", "readonly id: number"));
  assert.deepEqual(member.filter((check) => check.state !== "match").map((check) => check.state), ["mismatch"]);
  const memberFinding = member.find((check) => check.diagnostic !== undefined)?.diagnostic;
  assert.equal(memberFinding?.id, "drift.signature-mismatch");
  assert.equal(memberFinding?.pos?.line, 5);
  assert.match(memberFinding?.message ?? "", /readonly id: number/);
});

test("a removed symbol is missing and a spread argument is unchecked", async () => {
  const markdown = await fixturePage();

  const removed = await findings(markdown.replace("createWidget", "makeWidget"));
  const missing = removed.find((check) => check.state === "missing");
  assert.equal(missing?.ref.symbol, "makeWidget");
  assert.equal(missing?.diagnostic?.id, "drift.missing-symbol");
  assert.equal(missing?.diagnostic?.pos?.line, 3);
  assert.match(missing?.diagnostic?.message ?? "", /"src\/widget\.ts" does not export "makeWidget"/);

  const unchecked = await findings(
    markdown.replace(
      "createWidget(name: string, options?: WidgetOptions): Widget",
      "createWidget(...args)",
    ),
  );
  const spread = unchecked.find((check) => check.state === "unchecked");
  assert.equal(spread?.diagnostic?.id, "drift.signature-unchecked");
  assert.equal(spread?.diagnostic?.pos?.line, 3);
  assert.match(spread?.diagnostic?.message ?? "", /spread/);
});

test("an unreadable declaration is unchecked and a distant declaration is moved", async () => {
  const root = site();
  try {
    write(root, "src/color.ts", "export enum Color { Red }\n");
    const enumDiagnostics = await findings("See `Color` at `/src/color.ts:1`.", root);
    const enumCheck = enumDiagnostics.find((check) => check.state === "unchecked");
    assert.equal(enumCheck?.diagnostic?.id, "drift.signature-unchecked");
    assert.match(enumCheck?.diagnostic?.message ?? "", /enum/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const markdown = (await fixturePage()).replace("/src/widget.ts:10", "/src/widget.ts:40");
  const moved = await findings(markdown);
  const movedCheck = moved.find((check) => check.state === "moved");
  assert.equal(movedCheck?.diagnostic?.id, "drift.moved-symbol");
  assert.equal(movedCheck?.diagnostic?.pos?.line, 3);
  assert.match(movedCheck?.diagnostic?.message ?? "", /at line 10.*cited line is 40/);
});
