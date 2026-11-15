import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { buildModel } from "../src/model/build.ts";

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "data-value-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

test("a scalar, a nested path, and a collection record render as text in the page and its twin", async () => {
  const root = tree({
    "mizzen.yml": "collections:\n  items:\n    source: _data/items.yml\n",
    "_data/company.yml": "name: Acme\naddress:\n  city: Tehran\n",
    "_data/items.yml": "- id: a\n  name: Alpha\n",
    "page.md": "# :data[company.name]\n\nCity: :data[company.address.city]\n\nItem: :data[items.a.name]\n",
  });
  try {
    const { site, diagnostics } = await buildModel(root);
    assert.deepEqual(diagnostics, []);
    const page = site.pages[0]!;
    assert.match(page.html, /<h1[^>]*>Acme<\/h1>/);
    assert.match(page.html, /City: Tehran/);
    assert.match(page.html, /Item: Alpha/);
    assert.equal(page.markdown, "# Acme\n\nCity: Tehran\n\nItem: Alpha\n");
    assert.doesNotMatch(page.html, /:data\[/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unknown path and a non-scalar are errors at the directive, and the literal text stays", async () => {
  const root = tree({
    "_data/company.yml": "name: Acme\naddress:\n  city: Tehran\n",
    "page.md": "Missing: :data[nope]\n\nObject: :data[company.address]\n",
  });
  try {
    const { site, diagnostics } = await buildModel(root);
    assert.deepEqual(
      diagnostics.map((diagnostic) => diagnostic.id),
      ["data.unknown-path", "data.not-a-scalar"],
    );
    assert.equal(diagnostics[0]!.pos?.file, "page.md");
    assert.equal(diagnostics[0]!.pos?.line, 1);
    assert.equal(diagnostics[1]!.pos?.line, 3);
    assert.match(site.pages[0]!.html, /:data\[nope\]/);
    assert.match(site.pages[0]!.markdown, /:data\[company\.address\]/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
