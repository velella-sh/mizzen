import assert from "node:assert/strict";
import { test } from "node:test";
import type { OutputContext } from "../src/contracts/index.ts";
import { hreflangLinks } from "../src/outputs/hreflang.ts";
import { writeSitemap, SITEMAP_LIMITS } from "../src/outputs/sitemap.ts";
import { pageAt, withSite } from "./data-record-site.ts";

const context: OutputContext = { renderPage: async () => "", report: () => {} };

const files = {
  "mizzen.yml":
    "url: https://example.com\nlang: en\nlanguages:\n  - code: en\n    name: English\n    prefix: \"\"\n  - code: fa\n    name: Persian\n    prefix: /fa\n" +
    "collections:\n  components:\n    source: _data/components.yml\n    template: _templates/components.md\n    permalink: /components/{id}/\n" +
    "  tags:\n    source: _data/tags.yml\n    template: _templates/tags.md\n    permalink: /tags/{id}/\n",
  "_data/components.yml":
    "- id: button\n  name:\n    en: Button\n    fa: Dokme\n- id: input\n  name:\n    en: Input\n- id: select\n  name:\n    en: Select\n    fa: Entekhab\n",
  "_data/tags.yml": "- id: ui\n  name: UI\n",
  "_templates/components.md": '---\ntitle: "{name}"\nlayout: record\n---\nBody.\n',
  "_templates/tags.md": '---\ntitle: "{name}"\nlayout: record\n---\nBody.\n',
};

const hrefs = (links: readonly { href: string; attrs?: Record<string, string> }[]): string[] =>
  links.map((link) => `${link.attrs?.hreflang}=${link.href}`);

test("a record translated into two languages links both, with x-default at the default language", async () => {
  await withSite(files, (_root, result) => {
    const expected = [
      "en=https://example.com/components/button/",
      "fa=https://example.com/fa/components/button/",
      "x-default=https://example.com/components/button/",
    ];
    assert.deepEqual(hrefs(hreflangLinks(result.site, pageAt(result, "/components/button/")!)), expected);
    assert.deepEqual(hrefs(hreflangLinks(result.site, pageAt(result, "/fa/components/button/")!)), expected);
  });
});

test("a record's language page that only holds the default text is a copy: it links nothing and is not linked", async () => {
  await withSite(files, (_root, result) => {
    assert.deepEqual(hreflangLinks(result.site, pageAt(result, "/components/input/")!), []);
    assert.deepEqual(hreflangLinks(result.site, pageAt(result, "/fa/components/input/")!), []);
  });
});

test("links never cross records", async () => {
  await withSite(files, (_root, result) => {
    for (const url of ["/components/button/", "/components/select/"]) {
      const list = hrefs(hreflangLinks(result.site, pageAt(result, url)!));
      assert.ok(list.every((entry) => entry.includes(url)), url);
    }
  });
});

test("a record with no translatable fields is plain data, not a copy: it keeps its links", async () => {
  await withSite(files, (_root, result) => {
    assert.equal(hreflangLinks(result.site, pageAt(result, "/tags/ui/")!).length, 3);
  });
});

test("the sitemap carries the same alternates and leaves the copy out of them", async () => {
  await withSite(files, async (_root, result) => {
    const [file] = await writeSitemap(result.site, context, SITEMAP_LIMITS);
    const xml = file!.contents.toString();
    const entry = (url: string): string => new RegExp(`<url>\\s*<loc>https://example.com${url}</loc>[\\s\\S]*?</url>`).exec(xml)![0];
    const button = entry("/components/button/");
    assert.match(button, /hreflang="en" href="https:\/\/example.com\/components\/button\/"/);
    assert.match(button, /hreflang="fa" href="https:\/\/example.com\/fa\/components\/button\/"/);
    assert.match(button, /hreflang="x-default" href="https:\/\/example.com\/components\/button\/"/);
    assert.doesNotMatch(entry("/components/input/"), /xhtml:link/);
    assert.doesNotMatch(entry("/fa/components/input/"), /xhtml:link/);
    assert.match(entry("/tags/ui/"), /hreflang="fa"/);
  });
});
