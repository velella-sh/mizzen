/**
 * Fixture coverage for #580: Steps, FileTree, and LinkCard in MDX and Markdoc, and one unknown
 * component per page. The expected content is fixed by docs/import-starlight-components.md.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parseFrontMatter } from "../../src/content/frontmatter.ts";
import { convertStarlight } from "../../src/import/starlight/index.ts";

const FIXTURES = fileURLToPath(new URL("../../fixtures/import-starlight/", import.meta.url));

function convert(name: "release.mdx" | "release.mdoc") {
  const file = `fixtures/import-starlight/${name}`;
  const frontMatter = parseFrontMatter(readFileSync(join(FIXTURES, name), "utf8"), file);
  return {
    data: frontMatter.data,
    ...convertStarlight(frontMatter.body, file, frontMatter.bodyLine),
  };
}

const mdx = convert("release.mdx");
const mdoc = convert("release.mdoc");

test("both syntaxes convert to the same content and front matter title", () => {
  assert.equal(mdx.body, mdoc.body);
  assert.equal(mdx.data.title, "Publish a release");
  assert.equal(mdoc.data.title, "Publish a release");
  assert.doesNotMatch(mdx.body, /^import /m);
  assert.doesNotMatch(mdoc.body, /\{%|%\}/);
  assert.doesNotMatch(mdx.body, /<[A-Z]/);
});

test("Steps becomes the ordered list with the code block inside item 1", () => {
  const steps = [
    "1. Build the site:",
    "",
    "   ```sh",
    "   node bin/mizzen.ts build site",
    "   ```",
    "",
    "2. Check the `site` output folder.",
    "3. Upload the folder to a host.",
  ].join("\n");
  assert.ok(mdx.body.includes(steps));
  assert.ok(mdoc.body.includes(steps));
  assert.doesNotMatch(mdx.body, /<\/?Steps>/);
});

test("FileTree becomes one text block with the entries and nesting", () => {
  const tree = [
    "```text",
    "site/",
    "  index.html",
    "  guides/",
    "    install/",
    "      index.html",
    "  sitemap.xml",
    "```",
  ].join("\n");
  assert.ok(mdx.body.includes(tree));
  assert.ok(mdoc.body.includes(tree));
  assert.equal(mdx.body.match(/```text/g)?.length, 1);
  assert.doesNotMatch(mdoc.body, /filetree/);
});

test("LinkCard becomes a paragraph with the description after an em dash", () => {
  const card =
    "[Deployment guide](/guides/deploy/) — Configure a host, a domain, and caching.";
  assert.ok(mdx.body.includes(card));
  assert.ok(mdoc.body.includes(card));
  assert.ok(mdx.body.includes("Read the [deployment guide](/guides/deploy/) before"));
  assert.doesNotMatch(mdx.body, /<LinkCard|linking|title=/);
});

test("an unknown component warns once at its opening tag and keeps the sentence", () => {
  const pages = [
    { page: mdx, file: "release.mdx", name: "ReleaseNote", line: 41 },
    { page: mdoc, file: "release.mdoc", name: "releaseNote", line: 38 },
  ] as const;

  for (const { page, file, name, line } of pages) {
    assert.equal(page.diagnostics.length, 1);
    const diagnostic = page.diagnostics[0];
    assert.ok(diagnostic);
    assert.equal(diagnostic.id, "import-starlight.unknown-component");
    assert.equal(diagnostic.severity, "warning");
    assert.match(diagnostic.message, new RegExp(name));
    assert.equal(diagnostic.pos?.line, line);
    assert.equal(diagnostic.pos?.file, `fixtures/import-starlight/${file}`);
    assert.ok(page.body.includes("This page is written for release 0.2.3."));
    assert.doesNotMatch(page.body, /ReleaseNote|releaseNote|version="0.2.3"/);
  }
});
