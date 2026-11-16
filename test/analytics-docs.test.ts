import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const schema = JSON.parse(readFileSync(new URL("../schema/config.schema.json", import.meta.url), "utf8"));
const doc = readFileSync(new URL("../site/analytics.md", import.meta.url), "utf8");

test("the docs name every analytics and verify key and provider in the schema", () => {
  const analytics = schema.properties.analytics;
  for (const key of Object.keys(analytics.properties)) assert.ok(doc.includes(`\`${key}\``), `analytics.${key}`);
  for (const provider of analytics.properties.provider.enum) assert.ok(doc.includes(`\`${provider}\``), provider);
  for (const key of Object.keys(schema.properties.verify.properties)) assert.ok(doc.includes(`\`${key}\``), `verify.${key}`);
});
