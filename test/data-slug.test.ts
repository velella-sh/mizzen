import assert from "node:assert/strict";
import { test } from "node:test";
import { fillPermalink, recordUrlsOf } from "../src/data/permalink.ts";
import { slugOf } from "../src/data/slug.ts";
import { ids, pageAt, withSite } from "./data-record-site.ts";

const FILE = {
  "mizzen.yml":
    "collections:\n" +
    "  people:\n" +
    "    source: _data/people.yml\n" +
    "    template: _templates/person.md\n" +
    "    permalink: /people/{name|slug}/\n",
  "_data/people.yml": '- id: jane\n  name: "Jane Doe"\n',
  "_templates/person.md": "---\ntitle: \"{name}\"\n---\n# :field[name]\n",
};

test("a slug is lowercase, keeps letters and digits of every script, and never holds a slash", () => {
  assert.equal(slugOf("@Scope/My_Pkg.v2"), "scope-my-pkg-v2");
  assert.equal(slugOf("  Hello,   World!  "), "hello-world");
  assert.equal(slugOf("Café"), "café");
  assert.equal(slugOf("سلام دنیا"), "سلام-دنیا");
  assert.equal(slugOf("+++"), "");
});

test("the slug filter fills a pattern and leaves the value alone without it", () => {
  assert.deepEqual(fillPermalink("/p/{name|slug}/", { name: "@scope/name" }).value, "/p/scope-name/");
  assert.deepEqual(fillPermalink("/p/{name}/", { name: "@scope/name" }).value, "/p/@scope/name/");
  assert.deepEqual(fillPermalink("/p/{name|slug}/", { name: "!!!" }).empty, ["name"]);
});

test("an unknown filter and an empty slug are reported at the record", async () => {
  await withSite(
    { ...FILE, "mizzen.yml": FILE["mizzen.yml"].replace("{name|slug}", "{name|upper}") },
    (_root, result) => {
      assert.deepEqual(ids(result), ["data.permalink-filter"]);
    },
  );
  await withSite({ ...FILE, "_data/people.yml": '- id: jane\n  name: "!!!"\n' }, (_root, result) => {
    assert.deepEqual(ids(result), ["data.permalink-slug"]);
  });
});

test("disambiguate appends its field only to the records a pattern cannot tell apart", () => {
  const config = { permalink: "/people/{name|slug}/", disambiguate: "id" };
  const position = { file: "people.yml", startLine: 1, startColumn: 1, endLine: 1, endColumn: 5 };

  // One record, no collision: its URL is the pattern's, without a suffix.
  const alone = recordUrlsOf(
    "people",
    [{ id: "a", fields: { name: "Alpha", id: "a" }, position }],
    config,
    { base: "" },
  );
  assert.equal(alone.urls.get("a")?.url, "/people/alpha/");
  assert.equal(alone.suffixes.size, 0);

  // Two records share a URL; a third keeps the one it already had.
  const set = recordUrlsOf(
    "people",
    [
      { id: "a", fields: { name: "Jane", id: "a" }, position },
      { id: "b", fields: { name: "Jane", id: "b" }, position },
      { id: "c", fields: { name: "Solo", id: "c" }, position },
    ],
    config,
    { base: "" },
  );
  assert.equal(set.urls.get("a")?.url, "/people/jane-a/");
  assert.equal(set.urls.get("b")?.url, "/people/jane-b/");
  assert.equal(set.urls.get("c")?.url, "/people/solo/");
  assert.deepEqual([...set.suffixes].sort(), [["a", "a"], ["b", "b"]]);
});

test("two records a pattern cannot tell apart are reported, naming both and building neither", async () => {
  await withSite(
    { ...FILE, "_data/people.yml": '- id: a\n  name: "Jane"\n- id: b\n  name: "Jane"\n' },
    (_root, result) => {
      assert.deepEqual(ids(result), ["data.permalink-collision"]);
      assert.match(result.diagnostics[0]!.message, /"a", "b" of people all build the URL "\/people\/jane\/"/);
      assert.equal(result.site.pages.length, 0);
    },
  );
});

test("the disambiguated URLs do not depend on the order of the records", async () => {
  const files = {
    ...FILE,
    "mizzen.yml": `${FILE["mizzen.yml"]}    disambiguate: id\n`,
    "_data/people.yml": '- id: a\n  name: "Jane"\n- id: b\n  name: "Jane"\n- id: c\n  name: "Solo"\n',
  };
  const urlsOf = async (data: string): Promise<string[]> => {
    let urls: string[] = [];
    await withSite({ ...files, "_data/people.yml": data }, (_root, result) => {
      urls = result.site.pages.map((page) => page.url).sort();
    });
    return urls;
  };
  const straight = await urlsOf(files["_data/people.yml"]);
  const reversed = await urlsOf('- id: c\n  name: "Solo"\n- id: b\n  name: "Jane"\n- id: a\n  name: "Jane"\n');
  assert.deepEqual(straight, reversed);
  assert.deepEqual(straight, ["/people/jane-a/", "/people/jane-b/", "/people/solo/"]);
});

test("a page, its named view, and a record: link agree on a disambiguated URL", async () => {
  await withSite(
    {
      "mizzen.yml":
        "collections:\n" +
        "  people:\n" +
        "    source: _data/people.yml\n" +
        "    template: _templates/person.md\n" +
        "    permalink: /people/{name|slug}/\n" +
        "    disambiguate: id\n" +
        "    views:\n" +
        "      print:\n" +
        "        template: _templates/print.md\n" +
        "        permalink: /people/{name|slug}/print/\n",
      "_data/people.yml": '- id: a\n  name: "Jane"\n- id: b\n  name: "Jane"\n',
      "_templates/person.md": "---\ntitle: \"{name}\"\n---\n# :field[name]\n",
      "_templates/print.md": "---\ntitle: \"{name} print\"\n---\nPrint :field[name].\n",
      "links.md": "---\ntitle: Links\n---\n[The first Jane](record:people/a)\n",
    },
    (_root, result) => {
      // Two people named Jane share a title: the SEO check says so, and nothing else is wrong.
      assert.deepEqual(ids(result), ["data.seo-duplicate-title"]);
      const page = pageAt(result, "/people/jane-a/")!;
      const view = pageAt(result, "/people/jane-a/print/")!;
      assert.equal(page.record?.views?.print, "/people/jane-a/print/");
      assert.equal(view.record?.view, "print");
      assert.equal(view.frontMatter.canonical_url, "/people/jane-a/");
      assert.match(pageAt(result, "/links/")!.html, /href="\/people\/jane-a\/"/);
    },
  );
});
