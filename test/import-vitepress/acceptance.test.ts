/**
 * Acceptance for #586: the converted VitePress sample builds as a Mizzen page. The checks are the
 * manual cases of docs/import-vitepress-components.md: container titles, text order, the link, and
 * the dynamic component that needs a person.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Diagnostic } from "../../src/contracts/index.ts";
import { convertVitePress } from "../../src/import/vitepress/components.ts";
import { reportVue } from "../../src/import/vitepress/diagnostics.ts";
import { build } from "../../src/pipeline/build.ts";

const FIXTURES = fileURLToPath(new URL("../../fixtures/import-vitepress/", import.meta.url));
const THEME = fileURLToPath(new URL("../../../lateen", import.meta.url));
const FILE = "deploy.md";
const SOURCE = readFileSync(join(FIXTURES, "source/deploy.md"), "utf8");
const EXPECTED = readFileSync(join(FIXTURES, "expected/deploy.md"), "utf8");
const CONVERTED = convertVitePress(SOURCE, { Badge: "badge" });

/** Writes the converted page beside its link target in a real site, builds it, and returns the result. */
async function buildPage(): Promise<{ html: string; diagnostics: readonly Diagnostic[] }> {
  const root = mkdtempSync(join(tmpdir(), "import-vitepress-"));
  const out = mkdtempSync(join(tmpdir(), "import-vitepress-out-"));
  try {
    writeFileSync(join(root, "mizzen.yml"), "title: Import\n");
    writeFileSync(join(root, FILE), CONVERTED.markdown);
    writeFileSync(join(root, "releases.md"), "---\ntitle: Releases\n---\n# Releases\n");
    const result = await build({ root, out: join(out, "site"), themeRoot: THEME, defaultLayout: "doc" });
    return { html: readFileSync(join(out, "site/deploy/index.html"), "utf8"), diagnostics: result.diagnostics };
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
}

test("the converted fixture matches the recorded page and reports its one dynamic part", () => {
  assert.equal(CONVERTED.markdown, EXPECTED);
  assert.deepEqual(
    CONVERTED.dynamic.map((part) => [part.line, part.text]),
    [[19, '<ReleaseNotes :version="version">']],
  );

  const after = reportVue(CONVERTED.markdown, FILE);
  assert.equal(after.markdown, EXPECTED, "nothing else is Vue logic");
  assert.deepEqual(after.diagnostics, [], "no unmapped Vue logic is left for the report");
});

test("the built page keeps container titles, text order, the link, and the badge", async () => {
  const page = await buildPage();

  assert.deepEqual(page.diagnostics.filter((d) => d.severity === "error"), []);
  assert.deepEqual(page.diagnostics.filter((d) => d.id === "link.missing-page"), [], "the link target is a page");

  const markers = [
    ">Deploying beacon<",
    ">Before you start<",
    'data-src="deploy.md:5:1-7:3"',
    ">Run the doctor first<",
    "beacon doctor",
    'data-src="deploy.md:9:1-11:3"',
    "beacon rollback",
    ">Release status<",
    'data-src="deploy.md:15:1-15:20"',
    ">Release notes<",
    '<a href="./releases.md">release notes</a>',
    "for the version you run",
  ].map((marker) => page.html.indexOf(marker));
  assert.ok(markers.every((at) => at !== -1), "every marker is present");
  assert.deepEqual(markers, [...markers].sort((a, b) => a - b), "markers are in source order");

  assert.doesNotMatch(page.html, /<ReleaseNotes\b|<Badge\b|:::|\{\{/);
});
