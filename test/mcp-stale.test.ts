import assert from "node:assert/strict";
import { test } from "node:test";
import { harness } from "./mcp-helpers.ts";
import { run, site, write } from "./helpers-stale.ts";

const FILES = {
  "mizzen.yml": "title: T\ndefaults:\n  - path: \"\"\n    values:\n      layout: doc\n",
  "index.md": "---\ntitle: Home\ncovers: [src/x.ts]\n---\n# Home\n",
  "src/x.ts": "x",
};

async function marked(files: Record<string, string> = FILES): Promise<string> {
  const root = site(files);
  assert.equal((await run(["stale", "mark", "--all", "--site", root, "--date", "2026-01-01"])).code, 0);
  return root;
}

test("get_stale_pages lists a stale page with its source, files, and date", async () => {
  const root = await marked();
  write(root, { "src/x.ts": "changed" });
  const h = await harness(root);
  try {
    const r = await h.call("get_stale_pages");
    assert.equal(r.isError, false);
    assert.equal(r.data.total, 1);
    const [p] = r.data.pages;
    assert.equal(p.source, "index.md");
    assert.equal(p.reviewed, "2026-01-01");
    assert.deepEqual(p.covers, ["src/x.ts"]);
    assert.deepEqual(p.files, [{ path: "src/x.ts", change: "changed" }]);
    assert.match(p.fix, /stale mark index\.md/);
  } finally {
    await h.close();
  }
});

test("get_stale_pages never marks a page as reviewed", async () => {
  const root = await marked();
  write(root, { "src/x.ts": "changed" });
  const h = await harness(root);
  try {
    await h.call("get_stale_pages");
    assert.equal((await h.call("get_stale_pages")).data.total, 1);
  } finally {
    await h.close();
  }
});

test("get_stale_pages answers an empty list for a clean site and for a site without covers", async () => {
  const clean = await harness(await marked());
  const plain = await harness(site({ "mizzen.yml": FILES["mizzen.yml"], "index.md": "# Home\n" }));
  try {
    assert.deepEqual((await clean.call("get_stale_pages")).data, { total: 0, pages: [] });
    assert.deepEqual((await plain.call("get_stale_pages")).data, { total: 0, pages: [] });
  } finally {
    await clean.close();
    await plain.close();
  }
});

test("get_stale_pages bounds the pages and the files per page", async () => {
  const files: Record<string, string> = { "mizzen.yml": FILES["mizzen.yml"] };
  for (let i = 0; i < 4; i++) files[`p${i}.md`] = `---\ntitle: P${i}\ncovers: [src/**]\n---\n# P${i}\n`;
  for (let i = 0; i < 30; i++) files[`src/f${String(i).padStart(2, "0")}.ts`] = "a";
  const root = await marked(files);
  for (let i = 0; i < 30; i++) write(root, { [`src/f${String(i).padStart(2, "0")}.ts`]: "b" });
  const h = await harness(root);
  try {
    const r = await h.call("get_stale_pages", { limit: 2 });
    assert.equal(r.data.total, 4);
    assert.equal(r.data.pages.length, 2);
    assert.equal(r.data.more, 2);
    assert.equal(r.data.pages[0].files.length, 25);
    assert.equal(r.data.pages[0].moreFiles, 5);
  } finally {
    await h.close();
  }
});
