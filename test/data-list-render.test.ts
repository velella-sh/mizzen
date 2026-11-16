import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "../src/pipeline/build.ts";
import { site } from "./data-record-site.ts";

const FILES = {
  "mizzen.yml":
    "collections:\n" +
    "  posts:\n" +
    "    source: _data/posts.yml\n" +
    "    template: _templates/posts.md\n" +
    "    permalink: /posts/{id}/\n",
  "_data/posts.yml": "- id: a\n  title: Alpha\n  kind: ui\n- id: b\n  title: Beta\n  kind: ui\n- id: c\n  title: Gamma\n  kind: docs\n",
  "_templates/posts.md": "---\ntitle: \"{title}\"\n---\n# :field[title]\n",
  "blog/index.md":
    "---\ntitle: Blog\n" +
    "list:\n" +
    "  collection: posts\n" +
    "  group: kind\n" +
    "  perPage: 2\n" +
    "  fields: [title]\n" +
    "---\n# Blog\n",
};

/** A theme with a `doc` layout and, when `withList` is set, a `list` layout that prints the props it receives. */
function theme(withList = true): string {
  const root = mkdtempSync(join(tmpdir(), "data-list-theme-"));
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "list-theme", type: "module" }),
    "src/index.ts": 'export const theme = { name: "list-theme", folders: ["layouts"] };\n',
    "layouts/doc.ts":
      "export default function doc({ page }) { return `<!DOCTYPE html>\\n<html lang=\"en\"><body>${page.html}</body></html>\\n`; }\n",
  };
  if (withList) {
    files["layouts/list.ts"] =
      "export default function list({ page, list }) {\n" +
      "  const groups = list.groups.map((group) => `${group.key}:${group.records.length}`).join(\",\");\n" +
      "  const records = list.records.map((record) => `${record.id}@${record.url}`).join(\",\");\n" +
      "  return `<!DOCTYPE html>\\n<html lang=\"en\"><body>${page.html}<p id=\"list\">${list.collection} ${records} ${groups} ${list.pagination.page}/${list.pagination.total}</p></body></html>\\n`;\n" +
      "}\n";
  }
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

test("a list page reaches its layout as props, the same with one worker and with four", async () => {
  const root = site(FILES);
  const themeRoot = theme();
  const parent = mkdtempSync(join(tmpdir(), "data-list-out-"));
  try {
    const one = await build({ root, out: join(parent, "one"), themeRoot, defaultLayout: "doc" });
    const four = await build({ root, out: join(parent, "four"), themeRoot, defaultLayout: "doc", workers: 4 });
    assert.deepEqual(four.diagnostics, one.diagnostics);
    const serial = readFileSync(join(parent, "one/blog/index.html"), "utf8");
    const parallel = readFileSync(join(parent, "four/blog/index.html"), "utf8");
    assert.equal(parallel, serial);
    assert.match(serial, /posts c@\/posts\/c\/ docs:1 1\/2/);
    assert.match(serial, /<h1[^>]*>Blog<\/h1>/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(themeRoot, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a theme without the list layout is one error naming it", async () => {
  const root = site(FILES);
  const themeRoot = theme(false);
  const parent = mkdtempSync(join(tmpdir(), "data-list-out-"));
  try {
    const result = await build({ root, out: join(parent, "site"), themeRoot, defaultLayout: "doc" });
    const unknown = result.diagnostics.filter((diagnostic) => diagnostic.id === "render.unknown-layout");
    assert.equal(unknown.length, 2);
    assert.match(unknown.map((diagnostic) => diagnostic.message).join("\n"), /"list"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(themeRoot, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});
