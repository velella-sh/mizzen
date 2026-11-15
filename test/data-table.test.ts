import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { buildModel } from "../src/model/build.ts";

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "data-table-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const ITEMS = "- id: a\n  name: Alpha\n  status: stable\n- id: b\n  name: Beta\n  status: beta\n- id: c\n  name: Gamma\n  status: stable\n";

test("a data table renders Markdown-table markup in the page and a pipe table in the twin", async () => {
  const root = tree({
    "mizzen.yml": "collections:\n  items:\n    source: _data/items.yml\n",
    "_data/items.yml": ITEMS,
    "page.md": '::data-table{from=items columns=name,status sort=name where="status=stable"}\n',
  });
  try {
    const { site, diagnostics } = await buildModel(root);
    assert.deepEqual(diagnostics, []);
    const page = site.pages[0]!;
    assert.match(page.html, /<table[^>]*>/);
    const names = [...page.html.matchAll(/<td>(Alpha|Beta|Gamma)<\/td>/g)].map((match) => match[1]);
    assert.deepEqual(names, ["Alpha", "Gamma"]);
    assert.equal(
      page.markdown,
      "| name | status |\n| --- | --- |\n| Alpha | stable |\n| Gamma | stable |\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a table can read a list in _data, and an unknown column is one error with the row still rendered", async () => {
  const root = tree({
    "_data/regions.yml": "- id: north\n  name: North\n- id: south\n  name: South\n",
    "page.md": "::data-table{from=regions columns=name,missing}\n",
  });
  try {
    const { site, diagnostics } = await buildModel(root);
    assert.deepEqual(diagnostics.map((diagnostic) => diagnostic.id), ["data.table-unknown-column"]);
    assert.match(site.pages[0]!.html, /North/);
    assert.match(site.pages[0]!.html, /South/);
    assert.match(site.pages[0]!.markdown, /\| name \| missing \|/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing source or missing attributes is one error and leaves the page renderable", async () => {
  const root = tree({
    "page.md": "::data-table{from=nope columns=name}\n\n::data-table{from=items}\n",
  });
  try {
    const { site, diagnostics } = await buildModel(root);
    assert.deepEqual(
      diagnostics.map((diagnostic) => diagnostic.id),
      ["data.table-unknown-source", "data.table-attributes"],
    );
    assert.match(site.pages[0]!.html, /<p/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
