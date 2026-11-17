import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const page = readFileSync(new URL("../site/data/api.md", import.meta.url), "utf8");
const json = (path: string): any => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

/** The first-column keys of the table under the heading `### <title>`. */
function documentedKeys(title: string): string[] {
  const start = page.indexOf(`### ${title}`);
  assert.notEqual(start, -1, `the page has a "${title}" section`);
  const keys: string[] = [];
  for (const line of page.slice(start).split("\n").slice(1)) {
    if (line.startsWith("#") && !line.startsWith("###")) break;
    const match = /^\| `([^`]+)` \|/.exec(line);
    if (match !== null) keys.push(match[1]!);
    else if (keys.length > 0 && !line.startsWith("|")) break;
  }
  return keys.sort();
}

test("the config keys the page documents are the keys of the api schema", () => {
  const schema = json("../schema/config.schema.json").properties.api.properties as Record<string, unknown>;
  assert.deepEqual(documentedKeys("Config keys"), Object.keys(schema).sort());
});

test("the index keys the page documents are the keys of the index schema", () => {
  const schema = json("../schema/api-index.schema.json").properties as Record<string, unknown>;
  assert.deepEqual(documentedKeys("Index keys"), Object.keys(schema).sort());
});
