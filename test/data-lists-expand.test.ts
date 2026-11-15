import assert from "node:assert/strict";
import { test } from "node:test";
import { ids, pageAt, withSite } from "./data-record-site.ts";

const FILES = {
  "mizzen.yml":
    "collections:\n" +
    "  posts:\n" +
    "    source: _data/posts.yml\n" +
    "    template: _templates/posts.md\n" +
    "    permalink: /posts/{id}/\n",
  "_data/posts.yml":
    "- id: a\n  title: Alpha\n  tags: [ui, docs]\n" +
    "- id: b\n  title: Beta\n  tags: [ui]\n" +
    "- id: c\n  title: Gamma\n  tags: [ui]\n",
  "_templates/posts.md": "---\ntitle: \"{title}\"\n---\n# :field[title]\n",
  "blog/index.md":
    "---\ntitle: Blog\n" +
    "list:\n" +
    "  collection: posts\n" +
    "  sort: title\n" +
    "  perPage: 2\n" +
    "  expand:\n" +
    "    field: tags\n" +
    "    permalink: /tags/{value|slug}/\n" +
    '    title: "Tagged {value}"\n' +
    "---\n# Blog\n",
};

test("an expanded list builds one page per value and keeps an index with counts on the parent", async () => {
  await withSite(FILES, (_root, result) => {
    assert.deepEqual(result.diagnostics, []);
    const index = pageAt(result, "/blog/")!;
    assert.deepEqual(index.list?.records, []);
    assert.deepEqual(
      index.list?.groups.map((group) => [group.key, group.count, group.url]),
      [
        ["docs", 1, "/tags/docs/"],
        ["ui", 3, "/tags/ui/"],
      ],
    );
    assert.match(index.markdown, /\[ui\]\(\/tags\/ui\/\) \| 3/);

    const ui = pageAt(result, "/tags/ui/")!;
    assert.equal(ui.title, "Tagged ui");
    assert.equal(ui.list?.records.length, 2);
    assert.deepEqual(ui.list?.pagination, { page: 1, total: 2, next: "/tags/ui/page/2/" });
    assert.deepEqual(pageAt(result, "/tags/ui/page/2/")?.list?.records.map((record) => record.id), ["c"]);
    assert.deepEqual(pageAt(result, "/tags/docs/")?.list?.records.map((record) => record.id), ["a"]);
  });
});

test("a value that another value slugs to the same URL is a duplicate-URL error", async () => {
  await withSite(
    {
      ...FILES,
      "_data/posts.yml": "- id: a\n  title: Alpha\n  tags: [UI]\n- id: b\n  title: Beta\n  tags: [ui]\n",
    },
    (_root, result) => {
      assert.deepEqual(ids(result), ["page.duplicate-url"]);
    },
  );
});

test("an expand pattern without {value} is one error at the list key", async () => {
  await withSite(
    {
      ...FILES,
      "blog/index.md":
        "---\ntitle: Blog\nlist:\n  collection: posts\n  expand:\n    field: tags\n    permalink: /tags/\n---\n# Blog\n",
    },
    (_root, result) => {
      const finding = result.diagnostics.find((diagnostic) => diagnostic.id === "data.list-expand");
      assert.ok(finding);
      assert.equal(finding.pos?.line, 3);
      // The list still renders its records; only the expansion it could not read is dropped.
      assert.equal(pageAt(result, "/blog/")?.list?.records.length, 3);
      assert.equal(pageAt(result, "/tags/"), undefined);
    },
  );
});
