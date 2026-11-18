/**
 * The blog's feed in a whole build: the output reads the archive page's posts, so the draft stays out and the feed's
 * order and links match the pages a reader can reach.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { BuildResult } from "../src/pipeline/build.ts";
import { build } from "../src/pipeline/build.ts";

function tree(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

const THEME = {
  "src/index.ts": 'export const theme = { name: "t", folders: ["layouts"] };\n',
  "layouts/doc.ts": 'export default (p: any) => `<html><body>${p.page.html}</body></html>`;\n',
  "layouts/post.ts": 'export default (p: any) => `<html><body>${p.page.html}</body></html>`;\n',
  "layouts/list.ts":
    'export default (p: any) => `<html><body><ul>${p.page.frontMatter.blog.posts.map((post: any) => `<li>${post.slug}</li>`).join("")}</ul></body></html>`;\n',
};

const POSTS = {
  "posts/alpha.md": "---\ntitle: Alpha\ndate: 2026-01-12\nauthor: armin\ndescription: First.\n---\n\nAlpha body.\n",
  "posts/beta.md": "---\ntitle: Beta\ndate: 2026-01-12\nauthor: sam\n---\n\nBeta body.\n",
  "posts/draft.md": "---\ntitle: Draft\ndate: 2026-01-12\nauthor: armin\ndraft: true\n---\n\nDraft body.\n",
};

const AUTHORS = "armin:\n  name: Armin\n  url: https://example.org/armin/\nsam:\n  name: Sam\n";

/** A site with the posts and two authors, built with a small test theme. */
async function buildBlog(parent: string, config: string): Promise<{ result: BuildResult; out: string }> {
  const theme = join(parent, "theme");
  tree(theme, THEME);
  const site = join(parent, "site");
  tree(site, {
    "mizzen.yml": `title: Example blog\nurl: https://example.org\n${config}`,
    "_data/authors.yml": AUTHORS,
    ...POSTS,
  });
  const out = join(parent, "out");
  const result = await build({ root: site, out, themeRoot: theme, defaultLayout: "doc" });
  return { result, out };
}

/** The entry titles and links, in the order the feed lists them. */
function entries(xml: string): { title: string; link: string }[] {
  return [...xml.matchAll(/<entry>\n {4}<title>([^<]*)<\/title>\n {4}<link href="([^"]+)"/g)].map((match) => ({
    title: match[1] ?? "",
    link: match[2] ?? "",
  }));
}

test("a build writes the feed from the archive, with both public posts and no draft", async () => {
  const parent = mkdtempSync(join(tmpdir(), "blog-build-"));
  try {
    const { result, out } = await buildBlog(parent, "blog:\n  posts: posts\n");
    assert.deepEqual(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error"), []);
    assert.equal(result.diagnostics.some((diagnostic) => diagnostic.id === "page.duplicate-url"), false);

    for (const slug of ["alpha", "beta"]) assert.ok(result.files.includes(`blog/${slug}/index.html`), slug);
    assert.equal(result.files.includes("blog/draft/index.html"), false, "the draft has no page");

    const archive = readFileSync(join(out, "blog/archive/index.html"), "utf8");
    assert.deepEqual([...archive.matchAll(/<li>([^<]+)<\/li>/g)].map((match) => match[1]), ["alpha", "beta"]);

    for (const author of ["armin", "sam"]) {
      assert.ok(result.files.includes(`blog/authors/${author}/index.html`), `${author} has a page`);
    }

    assert.ok(result.files.includes("blog/feed.xml"), "the feed is written");
    const feed = readFileSync(join(out, "blog/feed.xml"), "utf8");
    assert.deepEqual(entries(feed), [
      { title: "Alpha", link: "https://example.org/blog/alpha/" },
      { title: "Beta", link: "https://example.org/blog/beta/" },
    ]);
    assert.equal(feed.includes("Draft"), false);
    assert.equal(feed.includes("draft"), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("feed: false writes no feed file", async () => {
  const parent = mkdtempSync(join(tmpdir(), "blog-build-"));
  try {
    const { result, out } = await buildBlog(parent, "blog:\n  posts: posts\n  feed: false\n");
    assert.deepEqual(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error"), []);
    assert.equal(existsSync(join(out, "blog/feed.xml")), false);
    assert.equal(result.files.includes("blog/feed.xml"), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
