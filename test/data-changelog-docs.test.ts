import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const page = readFileSync(new URL("../site/data/changelog.md", import.meta.url), "utf8");
const navigation = readFileSync(new URL("../site/_data/navigation.yml", import.meta.url), "utf8");
const eventSchema = JSON.parse(readFileSync(new URL("../schema/data-changes.schema.json", import.meta.url), "utf8"));
const config = JSON.parse(readFileSync(new URL("../schema/config.schema.json", import.meta.url), "utf8"));
const changelog = config.$defs.collection.properties.changelog.properties as Record<string, unknown>;

/** The first-column keys of the table under the heading `heading`. */
function documentedKeys(heading: string): string[] {
  const start = page.indexOf(`${heading}\n`);
  assert.notEqual(start, -1, `the page has a "${heading}" section`);
  const keys: string[] = [];
  for (const line of page.slice(start).split("\n").slice(1)) {
    if (line.startsWith("#")) break;
    const match = /^\| `([^`]+)` \|/.exec(line);
    if (match !== null) keys.push(match[1]!);
  }
  return keys.sort();
}

test("the event fields the page documents are the fields of the event schema", () => {
  assert.deepEqual(documentedKeys("## The history file"), Object.keys(eventSchema.properties).sort());
});

test("the config keys the page documents are the keys of the changelog schema", () => {
  assert.deepEqual(documentedKeys("## Changelog pages and feed"), Object.keys(changelog).sort());
});

test("the page covers the commands, the block, the pages, and the feed", () => {
  for (const word of [
    "data changes",
    "--write",
    "--check",
    "mizzen diff --base",
    ":::changes",
    ":field[type]",
    "/changes/<collection>/",
    "feeds/<collection>-changes.xml",
    "LayoutProps.record.changes",
    "Page.record.changes",
    "read-only collection",
  ]) {
    assert.ok(page.includes(word), word);
  }
});

test("the change history page is in the data navigation and the guide links it", () => {
  assert.ok(navigation.includes("url: /data/changelog/"));
  const guide = readFileSync(new URL("../site/data/index.md", import.meta.url), "utf8");
  assert.ok(guide.includes("(/data/changelog/)"));
});
