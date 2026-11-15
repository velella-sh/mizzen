import assert from "node:assert/strict";
import { test } from "node:test";
import { fillPermalink, recordUrl } from "../src/data/permalink.ts";
import { slugOf } from "../src/data/slug.ts";
import { ids, withSite } from "./data-record-site.ts";

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

test("disambiguate appends its field to the record URL, so one pattern gives two records two URLs", () => {
  const config = { permalink: "/people/{name|slug}/", disambiguate: "id" };
  const position = { file: "x", startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 };
  const one = recordUrl("people", "a", { name: "Jane", id: "a" }, config, { base: "", position });
  const two = recordUrl("people", "b", { name: "Jane", id: "b" }, config, { base: "", position });
  assert.equal(one.url, "/people/jane-a/");
  assert.equal(two.url, "/people/jane-b/");
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
    "_data/people.yml": '- id: a\n  name: "Jane"\n- id: b\n  name: "Jane"\n',
  };
  const urlsOf = async (data: string): Promise<string[]> => {
    let urls: string[] = [];
    await withSite({ ...files, "_data/people.yml": data }, (_root, result) => {
      urls = result.site.pages.map((page) => page.url).sort();
    });
    return urls;
  };
  const straight = await urlsOf(files["_data/people.yml"]);
  const reversed = await urlsOf('- id: b\n  name: "Jane"\n- id: a\n  name: "Jane"\n');
  assert.deepEqual(straight, reversed);
  assert.deepEqual(straight, ["/people/jane-a/", "/people/jane-b/"]);
});
