import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { BlogConfig, BlogPost, BlogPostSource, BlogRoute } from "../../src/content/blog/routes.ts";
import { buildBlogRoutes } from "../../src/content/blog/routes.ts";
import { blogFeed } from "../../src/outputs/blog-feed.ts";

const FIXTURE = fileURLToPath(new URL("../../fixtures/blog/", import.meta.url));

async function fixture(): Promise<{
  config: BlogConfig;
  authors: Record<string, unknown>;
  posts: BlogPostSource[];
}> {
  const config = (parse(await readFile(join(FIXTURE, "mizzen.yml"), "utf8")) as { blog: BlogConfig }).blog;
  const authors = parse(await readFile(join(FIXTURE, "_data/authors.yml"), "utf8")) as Record<string, unknown>;
  const names = (await readdir(join(FIXTURE, "posts"))).sort();
  const posts = await Promise.all(names.map(async (name) => ({
    file: `posts/${name}`,
    text: await readFile(join(FIXTURE, "posts", name), "utf8"),
  })));
  return { config, authors, posts };
}

function archiveOf(routes: readonly BlogRoute[]): readonly BlogPost[] {
  const route = routes.find((candidate): candidate is Extract<BlogRoute, { kind: "archive" }> =>
    candidate.kind === "archive");
  if (route === undefined) assert.fail("the archive route is missing");
  return route.posts;
}

/** The entry titles and links, in the order the feed lists them. */
function entries(xml: string): { title: string; link: string }[] {
  return [...xml.matchAll(/<entry>\n {4}<title>([^<]*)<\/title>\n {4}<link href="([^"]+)"/g)].map((match) => ({
    title: match[1] ?? "",
    link: match[2] ?? "",
  }));
}

test("the feed copies the archive's public order and leaves the draft out", async () => {
  const built = await fixture();
  const { routes } = buildBlogRoutes(built);
  const files = blogFeed({ routes, url: "https://example.org", title: "Example blog" });

  assert.equal(files.length, 1);
  assert.equal(files[0]!.path, "blog/feed.xml");
  const xml = String(files[0]!.contents);
  const listed = entries(xml);

  const archive = archiveOf(routes);
  assert.deepEqual(listed.map((entry) => entry.title), archive.map((post) => post.title));
  assert.deepEqual(listed.map((entry) => entry.link), archive.map((post) => `https://example.org${post.url}`));
  assert.deepEqual(listed.map((entry) => entry.title), ["Hello, world", "One more day"]);
  assert.equal(xml.includes("Not yet"), false);
  assert.equal(xml.includes("not-yet"), false);
  assert.equal(xml.includes("<summary>The first post on this blog.</summary>"), true);
  assert.equal((xml.match(/<updated>2026-01-12T00:00:00\.000Z<\/updated>/g) ?? []).length, 3);
  assert.equal(xml.includes('<link href="https://example.org/blog/feed.xml" rel="self" type="application/atom+xml"/>'), true);
  assert.equal(xml.includes('<link href="https://example.org/blog/" rel="alternate" type="text/html"/>'), true);
});

test("the source order changes no byte", async () => {
  const built = await fixture();
  const first = buildBlogRoutes(built).routes;
  const second = buildBlogRoutes({ ...built, posts: [...built.posts].reverse() }).routes;

  const feed = (routes: readonly BlogRoute[]): string =>
    String(blogFeed({ routes, url: "https://example.org", title: "Example blog" })[0]!.contents);
  assert.equal(feed(second), feed(first));
});

test("base stays in every link and out of the output path", async () => {
  const { authors } = await fixture();
  const { routes } = buildBlogRoutes({
    config: { posts: "posts", route: "journal", archive: "old" },
    base: "/docs",
    authors,
    posts: [{ file: "posts/hello.md", text: "---\ntitle: Hello\ndate: 2026-01-12\nauthor: armin\n---\n\nBody.\n" }],
  });
  const files = blogFeed({ routes, url: "https://example.org", base: "/docs", title: "Example blog" });

  assert.equal(files.length, 1);
  assert.equal(files[0]!.path, "journal/feed.xml");
  const xml = String(files[0]!.contents);
  assert.deepEqual(entries(xml), [{ title: "Hello", link: "https://example.org/docs/journal/hello/" }]);
  assert.equal(xml.includes('<link href="https://example.org/docs/journal/feed.xml" rel="self"'), true);
  assert.equal(xml.includes('<link href="https://example.org/docs/journal/" rel="alternate"'), true);
});

test("no public post and no site url each write no feed", async () => {
  const built = await fixture();
  const drafts = built.posts.filter((post) => post.file === "posts/not-yet.md");
  const onlyDraft = buildBlogRoutes({ ...built, posts: drafts }).routes;
  assert.deepEqual(blogFeed({ routes: onlyDraft, url: "https://example.org", title: "Example blog" }), []);

  const { routes } = buildBlogRoutes(built);
  assert.deepEqual(blogFeed({ routes, title: "Example blog" }), []);
});
