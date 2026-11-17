import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const text = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const page = (name: string) => text(`../site/data/${name}.md`);
const config = JSON.parse(text("../schema/config.schema.json"));
const countRule = config.$defs.derivedRule.oneOf[0] as {
  properties: { kind: { enum: string[] } } & Record<string, unknown>;
};

test("the dates page documents every dated-data key of the schema", () => {
  const doc = page("dates");
  const keys = [
    "asOf",
    ...Object.keys(config.properties.dates.properties),
    "derived",
    ...Object.keys(countRule.properties),
    ...Object.keys(config.$defs.derivedBand.properties),
  ];
  for (const key of keys) assert.ok(doc.includes(key), key);
  for (const kind of countRule.properties.kind.enum) assert.ok(doc.includes(kind), kind);
  for (const style of ["short", "long", "full"]) assert.ok(doc.includes(`format=${style}`), style);
});

test("the data guide and the navigation link the dates page", () => {
  assert.ok(page("index").includes("(/data/dates/)"), "guide link");
  assert.ok(text("../site/_data/navigation.yml").includes("url: /data/dates/"), "nav link");
});
