import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { buildModel, type BuildModelOptions, type ModelResult } from "../src/model/build.ts";
import { pageAt, site } from "./data-record-site.ts";

/** Builds a temporary site and removes its folder afterwards. */
async function build(
  files: Readonly<Record<string, string>>,
  options: BuildModelOptions = {},
): Promise<ModelResult> {
  const root = site(files);
  try {
    return await buildModel(root, options);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const COLLECTION = (name: string, extra = ""): string =>
  `  ${name}:\n` +
  `    source: _data/${name}.yml\n` +
  `    template: _templates/${name}.md\n` +
  `    permalink: /${name}/{id}/\n` +
  `    dates: [released]\n` +
  extra;

test("a printed date marks the record page; a plain text field does not", async () => {
  const result = await build({
    "mizzen.yml": `collections:\n${COLLECTION("dated")}${COLLECTION("plain")}`,
    "_data/dated.yml": '- id: one\n  name: Dated\n  released: "2026-03-15"\n',
    "_data/plain.yml": '- id: two\n  name: Plain\n  released: "2026-03-15"\n',
    "_templates/dated.md": '---\ntitle: "{name}"\n---\nReleased: :field[released]\n',
    "_templates/plain.md": '---\ntitle: "{name}"\n---\nName: :field[name]\n',
  });

  assert.deepEqual(result.diagnostics, []);
  assert.equal(pageAt(result, "/dated/one/")?.dates, true);
  assert.equal(Object.hasOwn(pageAt(result, "/plain/two/")!, "dates"), false);
});

test("a template that prints a derived value is marked", async () => {
  const result = await build(
    {
      "mizzen.yml":
        "collections:\n" +
        COLLECTION("releases", "    derived:\n      daysLeft: { field: released, kind: days-left }\n"),
      "_data/releases.yml": '- id: next\n  name: Next\n  released: "2026-03-15"\n',
      "_templates/releases.md": '---\ntitle: "{name}"\n---\nDays left: :field[daysLeft]\n',
    },
    { asOf: "2026-06-01" },
  );

  assert.deepEqual(result.diagnostics, []);
  const page = pageAt(result, "/releases/next/")!;
  assert.equal(page.dates, true);
  assert.match(page.markdown, /Days left: -78/);
});

test("an as-of date filter marks the list; a plain list is not marked", async () => {
  const result = await build(
    {
      "mizzen.yml": "collections:\n" + COLLECTION("posts"),
      "_data/posts.yml":
        '- id: old\n  title: Old\n  status: published\n  released: "2026-01-05"\n' +
        '- id: new\n  title: New\n  status: published\n  released: "2026-07-01"\n',
      "_templates/posts.md": '---\ntitle: "{title}"\n---\n# :field[title]\n',
      "filtered/index.md":
        "---\ntitle: Before\n" +
        "list:\n  collection: posts\n  where:\n    released: { before: reference }\n" +
        "---\n# Before\n",
      "plain/index.md":
        "---\ntitle: All\nlist:\n  collection: posts\n  where: { status: published }\n---\n# All\n",
    },
    { asOf: "2026-06-01" },
  );

  assert.deepEqual(result.diagnostics, []);
  const filtered = pageAt(result, "/filtered/")!;
  assert.equal(filtered.dates, true);
  assert.deepEqual(filtered.list?.records.map((record) => record.id), ["old"]);
  assert.equal(Object.hasOwn(pageAt(result, "/plain/")!, "dates"), false);
});

test("moving the as-of date changes a marked page and leaves a plain page's bytes alone", async () => {
  const root = site({
    "mizzen.yml":
      "collections:\n" +
      COLLECTION("releases", "    derived:\n      daysLeft: { field: released, kind: days-left }\n"),
    "_data/releases.yml": '- id: next\n  name: Next\n  released: "2026-03-15"\n',
    "_templates/releases.md": '---\ntitle: "{name}"\n---\nDays left: :field[daysLeft]\n',
    "plain/index.md": "---\ntitle: Plain\n---\n# Plain\n\nNothing dated here.\n",
  });

  try {
    const first = await buildModel(root, { asOf: "2026-06-01" });
    const second = await buildModel(root, { asOf: "2026-06-02" });
    const marked = pageAt(first, "/releases/next/")!;
    const moved = pageAt(second, "/releases/next/")!;
    const plain = pageAt(first, "/plain/")!;
    const plainAgain = pageAt(second, "/plain/")!;

    assert.equal(marked.dates, true);
    assert.equal(moved.dates, true);
    assert.notEqual(moved.html, marked.html);
    assert.notEqual(moved.markdown, marked.markdown);
    assert.equal(plainAgain.html, plain.html);
    assert.equal(plainAgain.markdown, plain.markdown);
    assert.equal(Object.hasOwn(plain, "dates"), false);
    assert.equal(Object.hasOwn(plainAgain, "dates"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a formatted date is marked, and an invalid format is not", async () => {
  const result = await build({
    "mizzen.yml": `collections:\n${COLLECTION("formatted")}${COLLECTION("invalid")}`,
    "_data/formatted.yml": '- id: one\n  name: Formatted\n  released: "2026-03-15"\n',
    "_data/invalid.yml": '- id: two\n  name: Invalid\n  released: "2026-03-15"\n',
    "_templates/formatted.md": '---\ntitle: "{name}"\n---\nReleased: :field[released]{format=long}\n',
    "_templates/invalid.md": '---\ntitle: "{name}"\n---\nReleased: :field[released]{format=tiny}\n',
  });

  assert.deepEqual(result.diagnostics.map((finding) => finding.id), ["data.field-format"]);
  const formatted = pageAt(result, "/formatted/one/")!;
  assert.equal(formatted.dates, true);
  assert.match(formatted.html, /15 March 2026/);
  const invalid = pageAt(result, "/invalid/two/")!;
  assert.equal(Object.hasOwn(invalid, "dates"), false);
  assert.match(invalid.html, /:field\[released\]/);
});
