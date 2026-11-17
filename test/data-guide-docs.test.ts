import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

const text = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const page = (name: string) => text(`../site/data/${name}.md`);
const config = JSON.parse(text("../schema/config.schema.json"));
const collection = config.$defs.collection.properties as Record<string, { properties?: Record<string, unknown> }>;

test("the collections page has a row for every collection key of the schema", () => {
  const doc = page("collections");
  for (const key of Object.keys(collection)) assert.ok(doc.includes(`| \`${key}\` |`), `collections.<name>.${key}`);
});

test("the search and seo pages have a row for each of their keys", () => {
  for (const [name, doc] of [["search", page("search")], ["seo", page("seo")]] as const) {
    for (const key of Object.keys(collection[name]!.properties!)) assert.ok(doc.includes(`| \`${key}\` |`), `${name}.${key}`);
  }
});

test("the social images page has a row for each social key", () => {
  const doc = page("social-images");
  for (const key of Object.keys(config.properties.social.properties)) assert.ok(doc.includes(`| \`${key}\` |`), `social.${key}`);
});

test("the templates page shows every data directive a plugin registers", () => {
  const doc = page("templates");
  const names = readdirSync(new URL("../src/markdown/plugins/", import.meta.url))
    .filter((file) => /^(data-count|data-table|data-value|records|field|snapshot)\.ts$/.test(file))
    .map((file) => file);
  assert.equal(names.length, 6, "the data plugins are the six the page covers");
  for (const directive of [":field[", ":::if{", ":::each{", ":::records{", ":count{", "::data-table{", ":data[", ":snapshot["]) {
    assert.ok(doc.includes(directive), directive);
  }
});

test("the lists page names every where operator, group key, and list key", () => {
  const doc = page("lists");
  for (const word of ["exists", "before", "after", "reference", "perPage", "splitGroups", "expand", "missing", "order", "desc"]) {
    assert.ok(doc.includes(word), word);
  }
});

test("the urls page names the lock rules and the data guide links every reference page", () => {
  const urls = page("urls");
  for (const word of ["urls.lock.json", "--update-urls", "urls check", "onRemoved", "aliases", "urls.json", "urls.url-changed", "urls.removed"]) {
    assert.ok(urls.includes(word), word);
  }
  const guide = page("index");
  for (const link of ["collections", "templates", "lists", "feeds", "search", "seo", "social-images", "urls", "theme-contract", "validation", "quick-start"]) {
    assert.ok(guide.includes(`(/data/${link}/)`), link);
  }
});

test("the theme contract names the props and files a theme reads", () => {
  const doc = page("theme-contract");
  for (const word of ["LayoutProps.record", "LayoutProps.list", "search-facets.json", "fixtures/data-site", "pagination", "groups"]) {
    assert.ok(doc.includes(word), word);
  }
});

test("the data pages are in the navigation", () => {
  const nav = text("../site/_data/navigation.yml");
  for (const url of ["/data/", "/data/quick-start/", "/data/collections/", "/data/templates/", "/data/lists/", "/data/search/", "/data/seo/", "/data/social-images/", "/data/urls/", "/data/theme-contract/"]) {
    assert.ok(nav.includes(`url: ${url}`), url);
  }
});
