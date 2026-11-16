import assert from "node:assert/strict";
import { test } from "node:test";
import { diffBuilds } from "../src/diff/index.ts";
import { cleanup, writeBuild } from "./site-diff-builds.ts";

const person = (id: string, fields: Record<string, unknown>) => ({
  url: `/people/${id}/`,
  source: `_data/people.yml#${id}`,
  title: id,
  md: `# ${id}\n\n${JSON.stringify(fields)}\n`,
  json: { record: { collection: "people", id, fields } },
});
const list = (ids: string[]) => ({
  url: "/people/",
  title: "People",
  md: `# People\n\n${ids.join(", ")}\n`,
  json: { list: { collection: "people", records: ids } },
});

test("a changed field is named with both values", async () => {
  const a = await writeBuild({ pages: [person("ada", { role: "dev" }), list(["ada"])] });
  const b = await writeBuild({ pages: [person("ada", { role: "lead" }), list(["ada"])] });
  const diff = await diffBuilds(a, b);
  const changed = diff.records[0]!.changed[0]!;
  assert.equal(changed.id, "ada");
  assert.deepEqual(changed.fields, [{ name: "role", before: "dev", after: "lead" }]);
  cleanup(a, b);
});

test("an added record names the list that gains it", async () => {
  const a = await writeBuild({ pages: [person("ada", { n: 1 }), list(["ada"])] });
  const b = await writeBuild({ pages: [person("ada", { n: 1 }), person("bob", { n: 2 }), list(["ada", "bob"])] });
  const diff = await diffBuilds(a, b);
  const added = diff.records[0]!.added[0]!;
  assert.equal(added.id, "bob");
  assert.deepEqual(added.lists, ["/people/"]);
  cleanup(a, b);
});

test("a removed record is reported", async () => {
  const a = await writeBuild({ pages: [person("ada", { n: 1 }), person("bob", { n: 2 }), list(["ada", "bob"])] });
  const b = await writeBuild({ pages: [person("ada", { n: 1 }), list(["ada"])] });
  const diff = await diffBuilds(a, b);
  assert.deepEqual(diff.records[0]!.removed.map((r) => r.id), ["bob"]);
  cleanup(a, b);
});
