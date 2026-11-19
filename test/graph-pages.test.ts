import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { buildGraph } from "../src/graph/build.ts";
import { collectGraphInput } from "../src/graph/collect.ts";
import { buildModel } from "../src/model/build.ts";

/** A temporary site from a path-to-text map. */
function tree(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "graph-pages-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const FILES = {
  "mizzen.yml": "title: Graph pages\n",
  "guide.md": [
    "---",
    "title: Guide",
    "---",
    "# Guide {#guide}",
    "",
    "<!-- {#intro} -->",
    "See [the other page](/other/) and the note.",
    "",
    "::include[snippets/note.md]",
    "",
  ].join("\n"),
  "other.md": "---\ntitle: Other\n---\n# Other {#other}\n",
  "snippets/note.md": "The included note.\n",
} as const;

test("a page graph carries pages, blocks, headings, links, and includes with spans", async () => {
  const root = tree(FILES);
  try {
    const model = await buildModel(root, { updateBlocks: true });
    const input = await collectGraphInput({ root, site: model.site });
    const { graph, diagnostics } = buildGraph(input);
    assert.deepEqual(diagnostics.filter((problem) => problem.severity === "error"), []);
    const id = (nodeId: string) => graph.nodes.find((node) => node.id === nodeId);
    assert.ok(id("page:guide.md"));
    assert.ok(id("page:other.md"));
    const block = id("block:intro");
    assert.ok(block, JSON.stringify(graph.nodes.filter((n) => n.kind === "block")));
    assert.equal(block.pos?.file, "guide.md");
    assert.ok(id("heading:guide.md#guide"));
    const link = graph.nodes.find((node) => node.kind === "link");
    assert.ok(link, "a link node");
    assert.equal(link.url, "/other/");
    assert.equal(link.pos?.file, "guide.md");
    assert.ok(graph.nodes.some((node) => node.kind === "include" && node.label === "snippets/note.md"));
    assert.ok(graph.edges.some((edge) => edge.from === "link:guide.md#1" && edge.to === "page:other.md" && edge.kind === "targets"));
    assert.ok(graph.edges.some((edge) => edge.from === "page:guide.md" && edge.to === "include:snippets/note.md" && edge.kind === "includes"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("moving a block to another page keeps its block id", () => {
  const base = {
    config: {
      title: "Move",
      base: "",
      lang: "en",
      dir: "ltr" as const,
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
    },
    nav: {},
    collections: {},
    data: {},
  };
  const block = { id: "intro", pos: { file: "one.md", line: 3, column: 1, endLine: 3, endColumn: 5 }, declared: true };
  const page = (file: string) => ({
    url: file === "one.md" ? "/one/" : "/two/",
    source: { file, line: 1, column: 1, endLine: 1, endColumn: 1 },
    frontMatter: { title: file },
    title: file,
    lang: "en",
    dir: "ltr" as const,
    headings: [],
    blocks: [block],
    html: "",
    markdown: "",
    kind: "doc" as const,
  });
  const first = buildGraph({ site: { ...base, pages: [page("one.md")] } }).graph;
  const second = buildGraph({ site: { ...base, pages: [page("two.md")] } }).graph;
  assert.ok(first.nodes.some((node) => node.id === "block:intro"));
  assert.ok(second.nodes.some((node) => node.id === "block:intro"));
  assert.ok(second.edges.some((edge) => edge.from === "page:two.md" && edge.to === "block:intro"));
});
