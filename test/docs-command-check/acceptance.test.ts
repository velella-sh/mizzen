/**
 * Acceptance for #538: with `examples: { failOnFailure: true }` the healthy Offing guide passes, and the broken
 * `offing explain` command is an error at its fence (line 42); without the key the same failure only warns.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Diagnostic, Page, Site, SiteConfig } from "../../src/contracts/index.ts";
import { loadConfigText } from "../../src/config/load.ts";
import { examplesReport, type ExampleRunner } from "../../src/outputs/examples-report.ts";

const GUIDE = new URL("./fixtures/offing/quickstart.md", import.meta.url);
const FILE = "test/docs-command-check/fixtures/offing/quickstart.md";

/** The guide's body starts after its front matter. */
function guide(): { markdown: string; line: number } {
  const text = readFileSync(GUIDE, "utf8");
  const start = text.indexOf("# Quickstart");
  return { markdown: text.slice(start), line: text.slice(0, start).split("\n").length };
}

function config(failOnFailure: boolean): SiteConfig {
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
    ...(failOnFailure ? { examples: { failOnFailure: true } } : {}),
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

function site(failOnFailure: boolean): Site {
  return { config: config(failOnFailure), pages: [page()], nav: {}, collections: {}, data: {} };
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

async function reportOf(
  failOnFailure: boolean,
  run: ExampleRunner,
): Promise<{ counts: Record<string, number>; diagnostics: Diagnostic[] }> {
  const diagnostics: Diagnostic[] = [];
  const files = await examplesReport(site(failOnFailure), {
    runner: run,
    report: (diagnostic) => diagnostics.push(diagnostic),
  });
  assert.equal(files.length, 1);
  const body = JSON.parse(String(files[0]!.contents)) as { pages: Array<Record<string, number>> };
  assert.equal(body.pages.length, 1);
  return { counts: body.pages[0]!, diagnostics };
}

test("the examples config key loads and defaults to no failure", () => {
  const { config: parsed, diagnostics } = loadConfigText(
    "examples:\n  failOnFailure: true\n",
    "mizzen.yml",
    "Site",
  );
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(parsed.examples, { failOnFailure: true });
  assert.equal(loadConfigText("", "mizzen.yml", "Site").config.examples, undefined);
});

test("the healthy guide passes with failOnFailure", async () => {
  const { counts, diagnostics } = await reportOf(true, runner());
  assert.deepEqual(counts, { url: "/quickstart/", total: 5, passed: 5, failed: 0, skipped: 0 });
  assert.deepEqual(diagnostics, []);
});

test("the broken command is an error at the fence with failOnFailure", async () => {
  const { counts, diagnostics } = await reportOf(true, runner("offing explain"));
  assert.deepEqual({ total: counts.total, passed: counts.passed, failed: counts.failed }, {
    total: 5,
    passed: 4,
    failed: 1,
  });
  assert.equal(diagnostics.length, 1);
  const [failure] = diagnostics;
  assert.equal(failure?.id, "example-failed");
  assert.equal(failure?.severity, "error");
  assert.equal(failure?.pos?.file, FILE);
  assert.equal(failure?.pos?.line, 42, "the explain fence starts at line 42 of the guide");
});

test("without the key the broken command is only a warning", async () => {
  const { diagnostics } = await reportOf(false, runner("offing explain"));
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.severity, "warning");
  assert.equal(diagnostics[0]?.pos?.line, 42);
});
