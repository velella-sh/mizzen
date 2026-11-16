import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { copyFixture, harness, type Harness } from "./mcp-helpers.ts";

let h: Harness;
before(async () => {
  h = await harness(copyFixture("data-site"));
});
after(() => h.close());

test("data tools exist only on a site with collections", async () => {
  const names = (await h.rpc("tools/list")).result.tools.map((t: { name: string }) => t.name);
  assert.ok(names.includes("get_record") && names.includes("query_records"));
  const docs = await harness(copyFixture("docs-site"));
  try {
    const none = (await docs.rpc("tools/list")).result.tools.map((t: { name: string }) => t.name);
    assert.ok(!none.includes("get_record") && !none.includes("query_records"));
  } finally {
    await docs.close();
  }
});

test("get_record returns the fields, the page URL, and the place in the data file", async () => {
  const r = await h.call("get_record", { collection: "components", id: "button" });
  assert.equal(r.data.url, "/components/button/");
  assert.equal(r.data.fields.name, "Button");
  assert.match(r.data.position.file, /components\.yml$/);
  assert.ok(r.data.position.line >= 1);
});

test("get_record names the closest ids and the collections when it misses", async () => {
  const id = await h.call("get_record", { collection: "components", id: "buton" });
  assert.equal(id.data.code, "unknown-record");
  assert.ok(id.data.closest.length > 0);
  const col = await h.call("get_record", { collection: "nope", id: "x" });
  assert.equal(col.data.code, "unknown-collection");
  assert.ok(col.data.collections.includes("components"));
});

test("query_records returns only the named fields, one page at a time", async () => {
  const first = await h.call("query_records", { collection: "components", fields: ["name"], limit: 5 });
  assert.equal(first.data.total, 12);
  assert.equal(first.data.records.length, 5);
  assert.deepEqual(Object.keys(first.data.records[0].fields), ["name"]);
  const second = await h.call("query_records", { collection: "components", fields: ["name"], limit: 5, cursor: first.data.nextCursor });
  assert.notEqual(second.data.records[0].id, first.data.records[0].id);
  const last = await h.call("query_records", { collection: "components", limit: 5, cursor: "10" });
  assert.equal(last.data.records.length, 2);
  assert.equal(last.data.nextCursor, undefined);
});

test("query_records filters and sorts with the list rules", async () => {
  const all = await h.call("query_records", { collection: "components", fields: ["name"], sort: "name desc", limit: 100 });
  const names = all.data.records.map((r: { fields: { name: string } }) => r.fields.name);
  assert.deepEqual(names, [...names].sort().reverse());
  const one = await h.call("query_records", { collection: "components", where: { slug: "button" }, fields: ["name"] });
  assert.equal(one.data.total, 1);
});

test("query_records refuses a bad query and a bad cursor with a message", async () => {
  const bad = await h.call("query_records", { collection: "components", where: { name: { nonsense: 1 } } });
  assert.equal(bad.isError, true);
  assert.equal(bad.data.code, "bad-query");
  const cursor = await h.call("query_records", { collection: "components", cursor: "-4" });
  assert.equal(cursor.isError, true);
  const missing = await h.call("query_records", { collection: "nope" });
  assert.equal(missing.data.code, "unknown-collection");
});
