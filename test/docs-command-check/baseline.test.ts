/**
 * Baseline for the docs command check (#533): the current example report on a real Offing guide. The guide's five
 * `bash` fences are marked `test`; one runner answer fails so the report has a broken-command case.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Diagnostic, Page, Site, SiteConfig } from "../../src/contracts/index.ts";
import { examplesReport, type ExampleRunner } from "../../src/outputs/examples-report.ts";

const GUIDE = new URL("./fixtures/offing/quickstart.md", import.meta.url);
const FILE = "test/docs-command-check/fixtures/offing/quickstart.md";

/** The guide's body starts after its front matter. */
function guide(): { markdown: string; line: number } {
  const text = readFileSync(GUIDE, "utf8");
  const start = text.indexOf("# Quickstart");
  return { markdown: text.slice(start), line: text.slice(0, start).split("\n").length };
}

function config(): SiteConfig {
  return {
    title: "Command check",
    base: "",
    lang: "en",
    dir: "ltr",
    languages: [],
    source: ".",
    include: [],
    exclude: [],
    navigation: "_data/navigation.yml",
    collections: {},
    feeds: {},
    defaults: [],
    theme: { options: {} },
    search: {},
    redirects: {},
    outputs: {},
  };
}

function page(): Page {
  const { markdown, line } = guide();
  return {
    url: "/quickstart/",
    source: { file: FILE, line, column: 1, endLine: 1, endColumn: 1 },
    frontMatter: {},
    title: "Quickstart",
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "",
    markdown,
    kind: "doc",
  };
}

function site(): Site {
  return { config: config(), pages: [page()], nav: {}, collections: {}, data: {} };
}

/** Answers every command with success, except the one whose code contains `failing`. */
function runner(failing?: string): ExampleRunner {
  return (input) =>
    Promise.resolve(
      failing !== undefined && input.code.includes(failing)
        ? { exitCode: 1, stdout: "error: finding not found\n" }
        : { exitCode: 0, stdout: "" },
    );
}

async function reportOf(run: ExampleRunner): Promise<{ counts: Record<string, number>; diagnostics: Diagnostic[] }> {
  const diagnostics: Diagnostic[] = [];
  const files = await examplesReport(site(), { runner: run, report: (diagnostic) => diagnostics.push(diagnostic) });
  assert.equal(files.length, 1);
  const body = JSON.parse(String(files[0]!.contents)) as { pages: Array<Record<string, number>> };
  assert.equal(body.pages.length, 1);
  return { counts: body.pages[0]!, diagnostics };
}

test("the guide's five commands pass and the report records one page", async () => {
  const { counts, diagnostics } = await reportOf(runner());
  assert.deepEqual(counts, { url: "/quickstart/", total: 5, passed: 5, failed: 0, skipped: 0 });
  assert.deepEqual(diagnostics, []);
});

test("a broken command is a warning at the fence line and does not fail the build", async () => {
  const { counts, diagnostics } = await reportOf(runner("offing explain"));
  assert.deepEqual({ total: counts.total, passed: counts.passed, failed: counts.failed }, {
    total: 5,
    passed: 4,
    failed: 1,
  });
  assert.equal(diagnostics.length, 1);
  const [failure] = diagnostics;
  assert.equal(failure?.id, "example-failed");
  assert.equal(failure?.severity, "warning");
  assert.ok(failure?.pos);
  assert.equal(failure.pos.file, FILE);
  assert.equal(failure.pos.line, 42, "the explain fence starts at line 42 of the guide");
  assert.match(failure?.message ?? "", /\/quickstart\//);
  assert.match(failure?.message ?? "", /exit code 1/);
});
