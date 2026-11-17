/**
 * Acceptance for #581: both converted Starlight samples build as Mizzen pages. The checks are the
 * manual cases of docs/import-starlight-components.md: steps in order, one file tree block, and a
 * card that points at the same destination as the inline link.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseFrontMatter } from "../../src/content/frontmatter.ts";
import type { Page } from "../../src/contracts/index.ts";
import { convertStarlight } from "../../src/import/starlight/index.ts";
import { buildModel } from "../../src/model/build.ts";

const FIXTURES = fileURLToPath(new URL("../../fixtures/import-starlight/", import.meta.url));

/** Convert one sample and build it as a one-page site; the temp folder is always removed. */
async function build(name: "release.mdx" | "release.mdoc"): Promise<Page> {
  const root = mkdtempSync(join(tmpdir(), "import-starlight-"));
  try {
    const file = `fixtures/import-starlight/${name}`;
    const frontMatter = parseFrontMatter(readFileSync(join(FIXTURES, name), "utf8"), file);
    const converted = convertStarlight(frontMatter.body, file, frontMatter.bodyLine);
    writeFileSync(join(root, "mizzen.yml"), "title: Import\n");
    writeFileSync(
      join(root, "release.md"),
      `---\ntitle: ${String(frontMatter.data.title)}\n---\n${converted.body}`,
    );
    const { site, diagnostics } = await buildModel(root);
    assert.deepEqual(
      diagnostics.filter((d) => d.severity === "error"),
      [],
      `${name} has build errors`,
    );
    const [page] = site.pages;
    assert.ok(page, `${name} built no page`);
    return page;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("both Starlight samples convert and build to the same page", async () => {
  const mdx = await build("release.mdx");
  const mdoc = await build("release.mdoc");

  assert.equal(mdx.title, "Publish a release");
  assert.equal(mdoc.title, "Publish a release");
  assert.equal(mdx.html, mdoc.html);
});

test("the built page keeps step order, the file tree, and the card destination", async () => {
  const { html } = await build("release.mdx");

  const steps = [
    "Build the site:",
    "Check the <code>site</code> output folder.",
    "Upload the folder to a host.",
  ].map((text) => html.indexOf(text));
  assert.ok(steps.every((at) => at !== -1), "all three steps are present");
  assert.deepEqual(steps, [...steps].sort((a, b) => a - b), "steps are in source order");
  assert.match(html, /<li>\s*<p[^>]*>Build the site:<\/p>\s*<pre[^>]*><code class="language-sh">/);

  const tree = [
    "site/",
    "  index.html",
    "  guides/",
    "    install/",
    "      index.html",
    "  sitemap.xml",
  ].join("\n");
  assert.ok(html.includes(`<code class="language-text">${tree}\n</code>`), "the file tree is one text block");

  assert.ok(
    html.includes(
      '<a href="/guides/deploy/">Deployment guide</a> — Configure a host, a domain, and caching.',
    ),
    "the card is a link with its description",
  );
  assert.equal(
    html.match(/href="\/guides\/deploy\/"/g)?.length,
    2,
    "the inline link and the card point at the deployment guide",
  );
});
