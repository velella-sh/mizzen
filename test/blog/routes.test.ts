import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { BlogAuthor, BlogConfig, BlogPost, BlogPostSource, BlogRoute } from "../../src/content/blog/routes.ts";
import { buildBlogRoutes } from "../../src/content/blog/routes.ts";

const FIXTURE = fileURLToPath(new URL("../../fixtures/blog/", import.meta.url));

const AUTHORS = { armin: { name: "Armin" }, sam: { name: "Sam" } };

async function fixture(): Promise<{
  config: BlogConfig;
  authors: Record<string, unknown>;
  posts: BlogPostSource[];
}> {
  const settings = parse(await readFile(join(FIXTURE, "mizzen.yml"), "utf8")) as { blog: BlogConfig };
  const authors = parse(await readFile(join(FIXTURE, "_data/authors.yml"), "utf8")) as Record<string, unknown>;
  const names = (await readdir(join(FIXTURE, "posts"))).sort();
  const posts = await Promise.all(names.map(async (name) => ({
    file: `posts/${name}`,
    text: await readFile(join(FIXTURE, "posts", name), "utf8"),
  })));
  return { config: settings.blog, authors, posts };
}

function postsOf(routes: readonly BlogRoute[]): BlogPost[] {
  return routes.flatMap((route) => (route.kind === "post" ? [route.post] : []));
}

function archiveOf(routes: readonly BlogRoute[]): Extract<BlogRoute, { kind: "archive" }> {
  const route = routes.find((candidate): candidate is Extract<BlogRoute, { kind: "archive" }> => candidate.kind === "archive");
  if (route === undefined) assert.fail("the archive route is missing");
  return route;
}

function authorsOf(routes: readonly BlogRoute[]): Extract<BlogRoute, { kind: "author" }>[] {
  return routes.filter((candidate): candidate is Extract<BlogRoute, { kind: "author" }> => candidate.kind === "author");
}

function authorRecordsOf(routes: readonly BlogRoute[]): BlogAuthor[] {
  return authorsOf(routes).map((route) => route.author);
}

function source(file: string, fields: Readonly<Record<string, string | boolean>>): BlogPostSource {
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${value}`);
  return { file, text: `---\n${lines.join("\n")}\n---\n\nBody.\n` };
}

test("plans a post, the archive, and one page per author, and leaves the draft out", async () => {
  const { config, authors, posts } = await fixture();
  const { routes, diagnostics } = buildBlogRoutes({ config, authors, posts });

  assert.deepEqual(diagnostics, []);
  assert.deepEqual(postsOf(routes).map((post) => post.slug), ["hello-world", "one-more-day"]);
  const hello = postsOf(routes)[0]!;
  assert.equal(hello.url, "/blog/hello-world/");
  assert.equal(hello.title, "Hello, world");
  assert.equal(hello.date, "2026-01-12");
  assert.equal(hello.author, "armin");
  assert.equal(hello.description, "The first post on this blog.");

  const archive = archiveOf(routes);
  assert.equal(archive.url, "/blog/archive/");
  assert.deepEqual(archive.posts.map((post) => post.slug), ["hello-world", "one-more-day"]);

  const authorRoutes = authorsOf(routes);
  assert.deepEqual(authorRecordsOf(routes).map((author) => author.id), ["armin", "sam"]);
  assert.equal(authorRoutes[0]!.url, "/blog/authors/armin/");
  assert.equal(authorRoutes[0]!.author.name, "Armin");
  assert.equal(authorRoutes[0]!.author.url, "https://example.org/armin/");
  assert.deepEqual(authorRoutes[0]!.posts.map((post) => post.slug), ["hello-world"]);
  assert.equal(authorRoutes[1]!.url, "/blog/authors/sam/");
  assert.deepEqual(authorRoutes[1]!.posts.map((post) => post.slug), ["one-more-day"]);

  assert.equal(postsOf(routes).some((post) => post.file === "posts/not-yet.md"), false);
  assert.equal(archive.posts.some((post) => post.slug === "not-yet"), false);
});

test("equal dates sort by slug by code point, whatever the input order", () => {
  const config: BlogConfig = { posts: "posts" };
  const posts = [
    source("posts/zebra.md", { title: "Zebra", date: "2026-01-12", author: "sam", slug: "zebra" }),
    source("posts/Apple.md", { title: "Apple", date: "2026-01-12", author: "sam", slug: "Apple" }),
    source("posts/newer.md", { title: "Newer", date: "2026-02-01", author: "sam" }),
  ];
  const first = buildBlogRoutes({ config, posts, authors: AUTHORS });
  const second = buildBlogRoutes({ config, posts: [...posts].reverse(), authors: AUTHORS });

  assert.deepEqual(first.diagnostics, []);
  assert.deepEqual(postsOf(first.routes).map((post) => post.slug), ["newer", "Apple", "zebra"]);
  assert.deepEqual(second.routes, first.routes);
  assert.deepEqual(second.diagnostics, first.diagnostics);
});

test("an unknown author is an error at the field and the post is not public", async () => {
  const loaded = await fixture();
  const posts = loaded.posts.map((post) => post.file === "posts/hello-world.md"
    ? { ...post, text: post.text.replace("author: armin", "author: nobody") }
    : post);
  const { routes, diagnostics } = buildBlogRoutes({ ...loaded, posts });

  assert.equal(diagnostics.length, 1);
  const found = diagnostics[0]!;
  assert.equal(found.id, "blog.unknown-author");
  assert.equal(found.severity, "error");
  assert.deepEqual(found.pos, { file: "posts/hello-world.md", line: 4, column: 1, endLine: 4, endColumn: 14 });
  assert.match(found.message, /nobody/);
  assert.deepEqual(postsOf(routes).map((post) => post.slug), ["one-more-day"]);
  assert.deepEqual(archiveOf(routes).posts.map((post) => post.slug), ["one-more-day"]);
  assert.deepEqual(authorRecordsOf(routes).map((author) => author.id), ["sam"]);
});

test("two posts with one slug collide, and a public post cannot claim the archive route", () => {
  const config: BlogConfig = { posts: "posts" };
  const { routes, diagnostics } = buildBlogRoutes({
    config,
    authors: AUTHORS,
    posts: [
      source("posts/a.md", { title: "A", date: "2026-01-12", author: "armin", slug: "same" }),
      source("posts/b.md", { title: "B", date: "2026-01-13", author: "sam", slug: "same" }),
      source("posts/c.md", { title: "C", date: "2026-01-14", author: "sam", slug: "archive" }),
    ],
  });

  assert.deepEqual(diagnostics.map((found) => found.id), ["blog.duplicate-slug", "blog.route-collision"]);
  assert.deepEqual(diagnostics.map((found) => found.pos?.file), ["posts/b.md", "posts/c.md"]);
  assert.deepEqual(postsOf(routes).map((post) => post.slug), ["same"]);
  assert.equal(archiveOf(routes).url, "/blog/archive/");
  assert.deepEqual(authorRecordsOf(routes).map((author) => author.id), ["armin"]);
});

test("base, route, archive, and authors follow the config", () => {
  const { routes, diagnostics } = buildBlogRoutes({
    config: { posts: "posts", route: "journal", archive: "old", authors: false },
    base: "/docs",
    authors: AUTHORS,
    posts: [source("posts/hello.md", { title: "Hello", date: "2026-01-12", author: "armin" })],
  });

  assert.deepEqual(diagnostics, []);
  assert.deepEqual(routes.map((route) => route.kind), ["post", "archive"]);
  assert.equal(routes[0]!.url, "/docs/journal/hello/");
  assert.equal(routes[1]!.url, "/docs/journal/old/");
});
