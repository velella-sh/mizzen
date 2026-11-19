/**
 * #1124-#1126: exact sources, public lineage, and stable references.
 *
 * Every fragment names its file, span, block or record id, and build snapshot, and its text is the
 * same Markdown the build produced. A record keeps only its public fields; a generated public field
 * adds a lineage fragment with the effective rule and source, never the value. A block recorded by
 * the lock but missing from the build is reported as removed, and a block the lock recorded on
 * another page resolves at its current page with `moved: true`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Collection, DataRecord, SiteConfig } from "../src/contracts/index.ts";
import { compileTaskContext } from "../src/context/compile.ts";
import { emptyBlocksLock } from "../src/blocks/lock.ts";
import { blockPage, config, page, site, task } from "./context-fixture.ts";

const INSTALL = "# Install the engine\n\nInstall once.\n\n## Steps\n\nRun the installer.\n";

/** A data record at a known source position. */
function record(id: string, fields: Record<string, unknown>, derived?: Record<string, unknown>): DataRecord {
  return {
    id,
    fields,
    position: { file: "_data/blog.yml", startLine: 1, startColumn: 1, endLine: 8, endColumn: 1 },
    fieldPositions: {
      title: { file: "_data/blog.yml", startLine: 2, startColumn: 3, endLine: 2, endColumn: 20 },
      secret: { file: "_data/blog.yml", startLine: 3, startColumn: 3, endLine: 3, endColumn: 20 },
    },
    ...(derived === undefined ? {} : { derived }),
  };
}

/** A blog collection whose public policy allows the title and the derived slug only. */
function blog(): { readonly collection: Collection; readonly config: SiteConfig } {
  const collection: Collection = {
    name: "blog",
    source: "_data/blog.yml",
    records: [record("post-1", { title: "Hello", secret: "hunter2" }, { publicSlug: "hello" })],
  };
  const settings = config({
    collections: {
      blog: {
        source: "_data/blog.yml",
        template: "_templates/post.md",
        public: ["title", "publicSlug"],
        derived: { publicSlug: { field: "title", kind: "slug" } },
      } as never,
    },
  });
  return { collection, config: settings };
}

/** A site with the install page, the blog collection, and the given config. */
function blogSite() {
  const { collection, config: settings } = blog();
  const model = site(
    [blockPage("/guide/install/", INSTALL, "Install the engine", "guide/install.md", [["install-steps", 5]])],
    { blog: collection },
  );
  return { ...model, config: settings };
}

test("page and block fragments carry file, span, block id, and snapshot", async () => {
  const model = blogSite();
  const compiled = await compileTaskContext(model, task({
    scope: { pages: ["/guide/install/"], blocks: ["install-steps"], collections: [], symbols: [], files: [] },
  }), { maxTokens: 4000 });
  const block = compiled.fragments.find((fragment) => fragment.source.block === "install-steps");
  assert.ok(block, compiled.fragments.map((fragment) => fragment.id).join(", "));
  assert.equal(block.source.file, "guide/install.md");
  assert.match(block.source.span, /^guide\/install\.md:5:1-/);
  assert.equal(block.source.snapshot, compiled.snapshot);
  assert.match(block.content, /Run the installer\./);
  assert.equal(block.kind, "block");
});

test("a record carries its public fields, record id, and source; the private field is absent", async () => {
  const model = blogSite();
  const compiled = await compileTaskContext(model, task({
    goal: "Review the blog post",
    scope: { pages: [], blocks: [], collections: ["blog"], symbols: [], files: [] },
  }), { maxTokens: 4000 });
  const recordFragment = compiled.fragments.find((fragment) => fragment.source.record === "post-1");
  assert.ok(recordFragment);
  assert.match(recordFragment.content, /Hello/);
  assert.doesNotMatch(recordFragment.content, /hunter2/);
  assert.doesNotMatch(compiled.markdown, /hunter2/);
  assert.match(recordFragment.source.span, /^_data\/blog\.yml:1:1-/);
});

test("a public derived field adds a lineage fragment with its rule and no value", async () => {
  const model = blogSite();
  const compiled = await compileTaskContext(model, task({
    goal: "Review the blog post",
    scope: { pages: [], blocks: [], collections: ["blog"], symbols: [], files: [] },
  }), { maxTokens: 8000 });
  const lineage = compiled.fragments.find((fragment) => fragment.kind === "lineage");
  assert.ok(lineage, compiled.fragments.map((fragment) => fragment.id).join(", "));
  assert.match(lineage.content, /Rule: publicSlug/);
  assert.doesNotMatch(lineage.content, /hunter2|Hello/);
  assert.equal(lineage.source.record, "post-1");
});

test("a block the lock recorded and the build dropped is reported removed, not invented", async () => {
  const model = blogSite();
  const lock = { ...emptyBlocksLock(), pages: { "guide/install.md": { "old-steps": 5 } } };
  const compiled = await compileTaskContext(model, task({
    scope: { pages: [], blocks: ["old-steps"], collections: [], symbols: [], files: [] },
  }), { maxTokens: 4000, lock });
  assert.deepEqual(compiled.removedReferences, ["old-steps"]);
  assert.equal(compiled.references[0]?.status, "removed");
  assert.equal(compiled.fragments.some((fragment) => fragment.source.block === "old-steps"), false);
});

test("a block recorded on another page resolves where the build put it, marked moved", async () => {
  const model = blogSite();
  const lock = { ...emptyBlocksLock(), pages: { "guide/old.md": { "install-steps": 5 } } };
  const compiled = await compileTaskContext(model, task({
    scope: { pages: [], blocks: ["install-steps"], collections: [], symbols: [], files: [] },
  }), { maxTokens: 4000, lock });
  assert.equal(compiled.references[0]?.status, "resolved");
  assert.equal(compiled.references[0]?.source, "guide/install.md");
  assert.equal(compiled.references[0]?.moved, true);
});
