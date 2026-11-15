import assert from "node:assert/strict";
import { test } from "node:test";
import { ids, pageAt, withSite } from "./data-record-site.ts";

const base = {
  "mizzen.yml":
    "collections:\n" +
    "  components:\n" +
    "    source: _data/components.yml\n" +
    "    template: _templates/components.md\n" +
    "    permalink: /components/{id}/\n",
  "_data/components.yml": "- id: button\n  name: Button\n  summary: A button.\n  image: /img/button.png\n  status: stable\n  old: \"{{literal}}\"\n",
};

test("every listed key and a theme key are filled from the record", async () => {
  await withSite(
    {
      ...base,
      "_templates/components.md":
        "---\n" +
        "title: \"{name}\"\n" +
        "description: \"{summary}\"\n" +
        "image: \"{image}\"\n" +
        "lang: en\n" +
        "status: \"{status}\"\n" +
        "theme_note: \"{name} note\"\n" +
        "layout: record\n" +
        "---\nBody.\n",
    },
    (_root, result) => {
      assert.deepEqual(result.diagnostics, []);
      const page = pageAt(result, "/components/button/")!;
      assert.equal(page.title, "Button");
      assert.equal(page.frontMatter.description, "A button.");
      assert.equal(page.frontMatter.image, "/img/button.png");
      assert.equal(page.frontMatter.status, "stable");
      assert.equal(page.frontMatter.theme_note, "Button note");
    },
  );
});

test("a literal brace survives, and an unknown or empty value is one error", async () => {
  await withSite(
    {
      ...base,
      "_data/components.yml": "- id: button\n  name: Button\n  summary: \"\"\n  old: \"{{literal}}\"\n",
      "_templates/components.md":
        "---\ntitle: \"{name}\"\ndescription: \"{summary}\"\nnote: \"{nope}\"\nliteral: \"{{literal}}\"\n---\nBody.\n",
    },
    (_root, result) => {
      assert.deepEqual(ids(result), ["data.frontmatter-empty", "data.frontmatter-missing-field"]);
      const page = pageAt(result, "/components/button/")!;
      assert.equal(page.frontMatter.description, undefined);
      assert.equal(page.frontMatter.note, undefined);
      assert.equal(page.frontMatter.literal, "{literal}");
    },
  );
});
