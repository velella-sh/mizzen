import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { after, before, test } from "node:test";
import { copyFixture, harness, type Harness } from "./mcp-helpers.ts";

let h: Harness;
before(async () => {
  h = await harness(copyFixture("docs-site"));
});
after(() => h.close());

test("initialize answers with the negotiated version, capabilities, and server info", async () => {
  const r = await h.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  assert.equal(r.result.protocolVersion, "2025-06-18");
  assert.equal(r.result.serverInfo.name, "mizzen");
  assert.ok(r.result.capabilities.tools);
  assert.ok(r.result.capabilities.resources);
});

test("an unknown protocol version gets the newest one this server speaks", async () => {
  const r = await h.rpc("initialize", { protocolVersion: "1999-01-01", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  assert.equal(r.result.protocolVersion, "2025-06-18");
});

test("ping and unknown methods", async () => {
  assert.deepEqual((await h.rpc("ping")).result, {});
  assert.equal((await h.rpc("no/such")).error.code, -32601);
});

test("a notification gets no response", async () => {
  assert.equal(await h.server.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), undefined);
});

test("tools/list names every read tool and no write tool by default", async () => {
  const names = (await h.rpc("tools/list")).result.tools.map((t: { name: string }) => t.name);
  for (const name of ["search_docs", "get_page", "list_pages", "get_block_source", "propose_edit", "get_diagnostics", "get_pack"]) {
    assert.ok(names.includes(name), name);
  }
  assert.ok(!names.includes("apply_edit"));
  assert.ok(!names.includes("get_record"), "a site without collections has no data tools");
});

test("an unknown tool and a bad argument are errors the agent can read, not crashes", async () => {
  const unknown = await h.rpc("tools/call", { name: "nope", arguments: {} });
  assert.ok(unknown.error || unknown.result?.isError);
  const bad = await h.call("get_page", { page: 5 });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /Invalid input/);
});

test("serve reads lines, answers each, survives garbage, and ends when input ends", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: string[] = [];
  output.on("data", (chunk: Buffer) => lines.push(...chunk.toString().split("\n").filter(Boolean)));
  const done = h.server.serve(input, output);
  input.write("not json\n");
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" })}\n`);
  input.end();
  await done;
  const replies = lines.map((l) => JSON.parse(l));
  assert.equal(replies[0].error.code, -32700);
  assert.deepEqual(replies[1], { jsonrpc: "2.0", id: 7, result: {} });
});
