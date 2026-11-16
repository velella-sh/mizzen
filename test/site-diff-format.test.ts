import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import { formatDiff, MARKER } from "../src/diff/format.ts";
import { diffBuilds } from "../src/diff/index.ts";
import { cleanup, writeBuild } from "./site-diff-builds.ts";

const schema = JSON.parse(readFileSync(new URL("../schema/site-diff.schema.json", import.meta.url), "utf8")) as object;
const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

async function fixture() {
  const a = await writeBuild({
    pages: [
      { url: "/", title: "Home", md: "# Home\n\n## One\n\nx\n" },
      { url: "/gone/", title: "Gone", md: "# Gone\n" },
    ],
    files: { "feed.xml": "<a/>" },
  });
  const b = await writeBuild({
    pages: [
      { url: "/", title: "Home", md: "# Home\n\n## One\n\ny\n" },
      { url: "/new/", title: "New | <b>", md: "# New\n" },
    ],
    files: { "feed.xml": "<b/>" },
  });
  const diff = await diffBuilds(a, b);
  return { diff, a, b };
}

test("text, json, and markdown each describe the same diff", async () => {
  const { diff, a, b } = await fixture();
  const text = formatDiff(diff, "text");
  assert.match(text, /Added pages/);
  assert.match(text, /\/new\//);
  assert.match(text, /\/gone\//);
  const json = JSON.parse(formatDiff(diff, "json")) as { version: number };
  assert.equal(json.version, 1);
  const markdown = formatDiff(diff, "markdown", { linkBase: "https://preview.example/pr-1" });
  assert.ok(markdown.startsWith(MARKER));
  assert.match(markdown, /\| Page \| Change \| Details \|/);
  assert.match(markdown, /\[\/new\/\]\(https:\/\/preview\.example\/pr-1\/new\/\)/);
  cleanup(a, b);
});

test("the JSON report validates against the schema", async () => {
  const { diff, a, b } = await fixture();
  assert.equal(validate(JSON.parse(formatDiff(diff, "json"))), true, JSON.stringify(validate.errors));
  cleanup(a, b);
});

test("markdown stops at the cap and says how many entries it left out", async () => {
  const { diff, a, b } = await fixture();
  const markdown = formatDiff(diff, "markdown", { maxEntries: 1 });
  assert.match(markdown, /more entr(y|ies) left out/);
  assert.equal(markdown.split("\n").filter((l) => l.startsWith("| /") || l.startsWith("| \\/")).length <= 1, true);
  cleanup(a, b);
});

test("no format names an absolute path or a build folder", async () => {
  const { diff, a, b } = await fixture();
  for (const format of ["text", "json", "markdown"] as const) {
    const out = formatDiff(diff, format);
    assert.equal(out.includes(a), false);
    assert.equal(out.includes(b), false);
  }
  cleanup(a, b);
});

test("a table cell cannot carry markup from page content", async () => {
  const { diff, a, b } = await fixture();
  assert.equal(formatDiff(diff, "markdown").includes("<b>"), false);
  cleanup(a, b);
});
