import assert from "node:assert/strict";
import { test } from "node:test";
import { jsonLdFromMapping } from "../src/data/json-ld.ts";
import { headMeta } from "../src/outputs/head-meta.ts";
import { pageAt, withSite } from "./data-record-site.ts";

const types = (head: ReturnType<typeof headMeta>): unknown[] => head.jsonLd.map((object) => object["@type"]);

test("a mapping fills {field} values, keeps literals and typed values, and defaults the context", () => {
  const object = jsonLdFromMapping(
    { "@type": "Product", name: "{name}", sku: "SKU-{id}", price: "{price}", brand: "{{x}}", tags: "{tags}" },
    { name: "Lamp", id: 7, price: 12.5, tags: ["a", "b"] },
  );
  assert.deepEqual(object, {
    "@context": "https://schema.org",
    "@type": "Product",
    name: "Lamp",
    sku: "SKU-7",
    price: 12.5,
    brand: "{x}",
    tags: ["a", "b"],
  });
});

test("a property whose field is empty is dropped, and so is a nested object that lost all its fields", () => {
  const object = jsonLdFromMapping(
    {
      "@type": "Product",
      name: "{name}",
      description: "{description}",
      label: "A {missing} label",
      offers: { "@type": "Offer", price: "{price}", seller: { "@type": "Organization", name: "{seller.name}" } },
    },
    { name: "Lamp", description: "  ", price: 3, seller: {} },
  );
  assert.deepEqual(object, {
    "@context": "https://schema.org",
    "@type": "Product",
    name: "Lamp",
    offers: { "@type": "Offer", price: 3 },
  });
  assert.equal(jsonLdFromMapping({ "@type": "Product", name: "{name}" }, {}), undefined, "all fields empty: no object");
});

test("nested objects and dot paths read nested fields", () => {
  const object = jsonLdFromMapping(
    { "@type": "Person", address: { "@type": "PostalAddress", addressCountry: "{place.country}" } },
    { place: { country: "NL" } },
  );
  assert.deepEqual(object?.address, { "@type": "PostalAddress", addressCountry: "NL" });
});

test("a mapping without @type makes no object", () => {
  assert.equal(jsonLdFromMapping({ name: "{name}" }, { name: "x" }), undefined);
  assert.equal(jsonLdFromMapping({ "@type": " ", name: "{name}" }, { name: "x" }), undefined);
});

const FILES = {
  "mizzen.yml":
    "url: https://example.com\ncollections:\n  posts:\n    source: _data/posts.yml\n    template: _templates/posts.md\n" +
    "    permalink: /posts/{id}/\n    seo:\n      jsonLd:\n        '@type': Article\n        headline: '{title}'\n        author: '{author}'\n",
  "_data/posts.yml":
    "- id: a\n  title: Alpha\n  author: Ada\n- id: b\n  title: Beta\n- id: c\n  title: Gamma\n",
  "_templates/posts.md": '---\ntitle: "{title}"\n---\n# :field[title]\n',
  "blog/index.md": "---\ntitle: Blog\nlist:\n  collection: posts\n  perPage: 2\n---\n# Blog\n",
};

test("a record page gets the mapped object, with empty fields dropped, besides its usual objects", async () => {
  await withSite(FILES, (_root, result) => {
    const head = headMeta(result.site, pageAt(result, "/posts/a/")!, []);
    assert.deepEqual(types(head), ["TechArticle", "Article"]);
    assert.deepEqual(head.jsonLd[1], { "@context": "https://schema.org", "@type": "Article", headline: "Alpha", author: "Ada" });
    const second = headMeta(result.site, pageAt(result, "/posts/b/")!, []);
    assert.deepEqual(second.jsonLd[1], { "@context": "https://schema.org", "@type": "Article", headline: "Beta" });
  });
});

test("a mapping without @type is one error and writes no object", async () => {
  const files = { ...FILES, "mizzen.yml": FILES["mizzen.yml"].replace("        '@type': Article\n", "") };
  await withSite(files, (_root, result) => {
    const found = result.diagnostics.filter((d) => d.id === "data.json-ld-type");
    assert.equal(found.length, 1);
    assert.equal(found[0]!.severity, "error");
    assert.deepEqual(types(headMeta(result.site, pageAt(result, "/posts/a/")!, [])), ["TechArticle"]);
  });
});

const TRAIL = [
  { title: "Home", url: "/" },
  { title: "Blog", url: "/blog/" },
];

test("a record page and page two of a list carry a BreadcrumbList, and the list an ItemList of its own items", async () => {
  await withSite(FILES, (_root, result) => {
    const record = headMeta(result.site, pageAt(result, "/posts/a/")!, TRAIL);
    assert.ok(types(record).includes("BreadcrumbList"));
    assert.ok(!types(record).includes("ItemList"));

    const one = headMeta(result.site, pageAt(result, "/blog/")!, TRAIL);
    const two = headMeta(result.site, pageAt(result, "/blog/page/2/")!, TRAIL);
    for (const head of [one, two]) assert.ok(types(head).includes("BreadcrumbList"));
    const items = (head: ReturnType<typeof headMeta>): unknown =>
      (head.jsonLd.find((object) => object["@type"] === "ItemList") as { itemListElement: { url: string }[] }).itemListElement.map((item) => item.url);
    assert.deepEqual(items(one), ["https://example.com/posts/a/", "https://example.com/posts/b/"]);
    assert.deepEqual(items(two), ["https://example.com/posts/c/"], "never more than the items on that page");
  });
});

test("the config turns the breadcrumb and the item list off", async () => {
  const off = { ...FILES, "mizzen.yml": FILES["mizzen.yml"] + "      breadcrumbs: false\n      itemList: false\n" };
  await withSite(off, (_root, result) => {
    for (const url of ["/posts/a/", "/blog/"]) {
      const head = headMeta(result.site, pageAt(result, url)!, TRAIL);
      assert.ok(!types(head).includes("BreadcrumbList"), url);
      assert.ok(!types(head).includes("ItemList"), url);
    }
  });
});
