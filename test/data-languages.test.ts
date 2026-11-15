import assert from "node:assert/strict";
import { test } from "node:test";
import { pageAt, withSite } from "./data-record-site.ts";

const files = {
  "mizzen.yml":
    "lang: en\n" +
    "languages:\n" +
    "  - code: en\n    name: English\n    prefix: \"\"\n" +
    "  - code: fa\n    name: فارسی\n    prefix: /fa\n" +
    "collections:\n" +
    "  components:\n" +
    "    source: _data/components.yml\n" +
    "    template: _templates/components.md\n" +
    "    permalink: /components/{id}/\n",
  "_data/components.yml":
    "- id: button\n  name:\n    en: Button\n    fa: دکمه\n- id: input\n  name:\n    en: Input\n",
  "_templates/components.md": "---\ntitle: \"{name}\"\nlayout: record\n---\nEnglish page.\n",
  "_templates/components.fa.md": "---\ntitle: \"{name}\"\nlayout: record\ndir: rtl\n---\nصفحهٔ فارسی.\n",
};

test("one record builds a page in every language, with the language's template and prefix", async () => {
  await withSite(files, (_root, result) => {
    assert.deepEqual(result.diagnostics, []);
    const en = pageAt(result, "/components/button/")!;
    const fa = pageAt(result, "/fa/components/button/")!;
    assert.equal(en.title, "Button");
    assert.equal(fa.title, "دکمه");
    assert.equal(fa.lang, "fa");
    assert.equal(fa.dir, "rtl");
    assert.match(en.markdown, /English page/);
    assert.match(fa.markdown, /صفحهٔ فارسی/);
    assert.equal(en.frontMatter.translation_key, "components:button");
    assert.equal(fa.frontMatter.translation_key, "components:button");
  });
});

test("a missing translation falls back to the default language and says so", async () => {
  await withSite(files, (_root, result) => {
    const fa = pageAt(result, "/fa/components/input/")!;
    assert.equal(fa.title, "Input");
    assert.deepEqual(fa.record?.fallbacks, ["name"]);
    const en = pageAt(result, "/components/input/")!;
    assert.deepEqual(en.record?.fallbacks, []);
  });
});
