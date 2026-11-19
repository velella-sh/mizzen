/**
 * #1135: the 0.2.5 public policy and the task's read permission, enforced everywhere.
 *
 * A field outside a collection's `public` allowlist reaches no fragment, omission, metadata, or
 * lineage report. A principal outside `permissions.read` reads no content at all: no entries, no
 * fragments, no references, every criterion unsatisfied, and one approval request.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Collection, SiteConfig } from "../src/contracts/index.ts";
import { compileTaskContext, contextJson } from "../src/context/compile.ts";
import { blockPage, config, site, task } from "./context-fixture.ts";

const INSTALL = "# Install\n\nRun the installer.\n";

/** A blog record with a public title and three private values. */
function blog(): { readonly collection: Collection; readonly config: SiteConfig } {
  const collection: Collection = {
    name: "blog",
    source: "_data/blog.yml",
    records: [{
      id: "post-1",
      fields: {
        title: "Hello",
        secret: "hunter2",
        author: { name: "Ada", email: "secret@example.com" },
      },
      position: { file: "_data/blog.yml", startLine: 1, startColumn: 1, endLine: 6, endColumn: 1 },
      fieldPositions: {},
      derived: { privateSlug: "hello" },
    }],
  };
  return {
    collection,
    config: config({
      collections: {
        blog: {
          source: "_data/blog.yml",
          template: "_templates/post.md",
          public: ["title", "author.name"],
          derived: { privateSlug: { field: "title", kind: "slug" } },
        } as never,
      },
    }),
  };
}

function model() {
  const { collection, config: settings } = blog();
  const built = site(
    [blockPage("/guide/install/", INSTALL, "Install", "guide/install.md", [])],
    { blog: collection },
  );
  return { ...built, config: settings };
}

test("a private field is absent from fragments, omissions, metadata, and the serialized pack", async () => {
  const compiled = await compileTaskContext(model(), task({
    goal: "Review the blog post",
    scope: { pages: [], blocks: [], collections: ["blog"], symbols: [], files: [] },
  }), { maxTokens: 4000 });
  const json = contextJson(compiled);
  assert.match(json, /Hello/);
  assert.match(json, /Ada/);
  assert.doesNotMatch(json, /hunter2/);
  assert.doesNotMatch(json, /secret@example\.com/);
  assert.doesNotMatch(json, /privateSlug/);
  assert.equal(compiled.fragments.some((fragment) => fragment.kind === "lineage"), false);
  assert.equal(compiled.omitted.some((omission) => /secret|privateSlug/.test(omission.ref)), false);
});

test("a principal outside permissions.read gets no content and an approval request", async () => {
  const restricted = task({
    scope: { pages: ["/guide/install/"], blocks: [], collections: [], symbols: [], files: [] },
    permissions: { read: ["owner"], write: [], check: [] },
    acceptance: [{ id: "review", statement: "The install page is present.", review: true }],
  });
  const compiled = await compileTaskContext(model(), restricted, { maxTokens: 4000, principal: "stranger" });
  assert.deepEqual(compiled.fragments, []);
  assert.deepEqual(compiled.references, []);
  assert.deepEqual(compiled.entries, []);
  assert.equal(compiled.answerability.complete, false);
  assert.equal(compiled.answerability.criteria[0]?.satisfied, false);
  assert.equal(compiled.omitted[0]?.reason, "permission");
  assert.ok(compiled.requests.some((request) => request.kind === "approval" && request.ref.includes("permissions.read")));
  assert.doesNotMatch(compiled.markdown, /Run the installer/);
});

test("the allowed principal reads the same content", async () => {
  const allowed = task({
    scope: { pages: ["/guide/install/"], blocks: [], collections: [], symbols: [], files: [] },
    permissions: { read: ["owner"], write: [], check: [] },
  });
  const compiled = await compileTaskContext(model(), allowed, { maxTokens: 4000, principal: "owner" });
  assert.ok(compiled.fragments.length > 0);
  assert.match(compiled.markdown, /Run the installer/);
  assert.equal(compiled.omitted.some((omission) => omission.reason === "permission"), false);
});
