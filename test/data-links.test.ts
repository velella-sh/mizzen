import assert from "node:assert/strict";
import { test } from "node:test";
import { recordPropsOf } from "../src/data/record-context.ts";
import { checkLinks } from "../src/outputs/link-check.ts";
import { pageAt, withSite } from "./data-record-site.ts";

const files = {
  "mizzen.yml":
    "collections:\n" +
    "  components:\n" +
    "    source: _data/components.yml\n" +
    "    template: _templates/components.md\n" +
    "    permalink: /components/{id}/\n" +
    "  releases:\n" +
    "    source: _data/releases.json\n" +
    "    template: _templates/releases.md\n" +
    "    permalink: /releases/{id}/\n" +
    "    references:\n" +
    "      component: components\n",
  "_data/components.yml": "- id: button\n  name: Button\n",
  "_data/releases.json": '{\n  "one": { "name": "One", "component": "button" }\n}\n',
  "_templates/releases.md": "---\ntitle: \"{name}\"\nlayout: record\n---\n:field[name]\n",
  "_templates/components.md":
    "---\ntitle: \"{name}\"\nlayout: record\n---\n[The button](record:components/button) and [a missing one](record:components/nope).\n",
  "guide.md": "---\ntitle: Guide\n---\nSee [the button](record:components/button).\n",
};

test("a record: link in a file page and in a template becomes the page URL", async () => {
  await withSite(files, (_root, result) => {
    assert.match(pageAt(result, "/guide/")!.html, /href="\/components\/button\/"/);
    const record = pageAt(result, "/components/button/")!;
    assert.match(record.html, /href="\/components\/button\/"/);
    assert.doesNotMatch(record.html, /record:/);
  });
});

test("an unknown collection or id is a broken link at its position", async () => {
  await withSite(files, (_root, result) => {
    const broken = checkLinks(result.site).filter((finding) => finding.id === "link.missing-page");
    assert.equal(broken.length, 1);
    assert.equal(broken[0]!.href, "record:components/nope");
    assert.equal(broken[0]!.pos.file, "_templates/components.md");
    assert.equal(broken[0]!.pos.line, 5);
  });
});

test("a reference field resolves to the URL of the record it points at", async () => {
  await withSite(files, (_root, result) => {
    const page = pageAt(result, "/releases/one/")!;
    const props = recordPropsOf(result.site, page)!;
    assert.equal(props.links["component"], "/components/button/");
  });
});

const localized = {
  "mizzen.yml":
    "base: /docs\n" +
    "languages:\n" +
    "  - code: en\n    name: English\n    prefix: \"\"\n" +
    "  - code: fa\n    name: فارسی\n    prefix: /fa\n" +
    "collections:\n" +
    "  components:\n" +
    "    source: _data/components.yml\n" +
    "    template: _templates/components.md\n" +
    "    permalink: /components/{name}/\n" +
    "  releases:\n" +
    "    source: _data/releases.json\n" +
    "    template: _templates/releases.md\n" +
    "    permalink: /releases/{id}/\n" +
    "    references:\n" +
    "      component: components\n",
  "_data/components.yml": "- id: button\n  name:\n    en: Button\n    fa: دکمه\n",
  "_data/releases.json": '{\n  "one": { "name": "One", "component": "button" }\n}\n',
  "_templates/components.md": "---\ntitle: \"{name}\"\nlayout: record\n---\n[Self](record:components/button)\n",
  "_templates/releases.md": "---\ntitle: \"{name}\"\nlayout: record\n---\n:field[name]\n",
  "fa/guide.md": "---\ntitle: Guide\n---\nSee [the button](record:components/button).\n",
};

test("record links and reference links use the page language prefix and localized target fields", async () => {
  await withSite(localized, (_root, result) => {
    const guide = pageAt(result, "/docs/fa/guide/")!;
    assert.match(guide.html, /href="\/docs\/fa\/components\/%D8%AF%DA%A9%D9%85%D9%87\/"/);
    assert.doesNotMatch(guide.html, /rel="external"/);

    const component = pageAt(result, "/docs/fa/components/دکمه/")!;
    assert.match(component.html, /href="\/docs\/fa\/components\/%D8%AF%DA%A9%D9%85%D9%87\/"/);

    const release = pageAt(result, "/docs/fa/releases/one/")!;
    assert.equal(recordPropsOf(result.site, release)!.links["component"], "/docs/fa/components/دکمه/");

    const english = pageAt(result, "/docs/components/Button/")!;
    assert.match(english.html, /href="\/docs\/components\/Button\/"/);
  });
});
