import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { capAnswer, confine, McpError, scrub } from "../src/mcp/limits.ts";
import { registryOf } from "../src/mcp/registry.ts";
import { createServer } from "../src/mcp/server.ts";
import type { Tool } from "../src/mcp/tool.ts";
import { copyFixture, harness, type Harness } from "./mcp-helpers.ts";

let h: Harness;
before(async () => {
  h = await harness(copyFixture("docs-site"), { allowEdits: true });
});
after(() => h.close());

const tool = (name: string, handler: Tool["handler"]): Tool => ({ name, description: "d", inputSchema: { type: "object", additionalProperties: false }, handler });
const call = async (server: ReturnType<typeof createServer>, name: string) => ((await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } })) as any).result;

test("confine refuses .., absolute paths, and a symlink that leaves the site", async () => {
  const outside = mkdtempSync(join(tmpdir(), "mcp-out-"));
  writeFileSync(join(outside, "secret.txt"), "secret");
  const root = mkdtempSync(join(tmpdir(), "mcp-in-"));
  writeFileSync(join(root, "ok.md"), "ok");
  mkdirSync(join(root, "sub"));
  symlinkSync(outside, join(root, "link"), "dir");
  symlinkSync(join(outside, "secret.txt"), join(root, "file-link.md"));
  await confine(root, "ok.md");
  for (const bad of ["../x", "sub/../../x", "/etc/passwd", "link/secret.txt", "file-link.md", "C:\\Windows", "a\0b", ""]) {
    await assert.rejects(confine(root, bad), (e: unknown) => e instanceof McpError, bad);
  }
  await assert.rejects(confine(root, "link/new.md", false), McpError);
});

test("an edit naming a file outside the site is refused and writes nothing", async () => {
  const outside = mkdtempSync(join(tmpdir(), "mcp-out-"));
  writeFileSync(join(outside, "x.md"), "hello\n");
  for (const file of ["../../../../../../../../../../" + outside.slice(1) + "/x.md", outside + "/x.md"]) {
    const r = await h.call("apply_edit", { file, span: { line: 1, column: 1, endLine: 1, endColumn: 5 }, expected: "hello", beforeHash: "0".repeat(64), replacement: "pwned" });
    assert.equal(r.isError, true);
  }
  assert.equal(readFileSync(join(outside, "x.md"), "utf8"), "hello\n");
});

test("page and block lookups never leave the site", async () => {
  for (const page of ["../../etc/passwd", "/etc/passwd", "file:///etc/passwd"]) {
    const r = await h.call("get_page", { page });
    assert.equal(r.isError, true);
    assert.ok(!/root:/.test(r.text));
  }
});

test("answers never carry this machine's absolute folders", async () => {
  const all = [await h.call("get_diagnostics", {}), await h.call("get_page", { page: "/install/" }), await h.call("list_pages", { limit: 200 })];
  for (const r of all) {
    assert.ok(!r.text.includes(h.root), "site root");
    assert.ok(!r.text.includes(tmpdir()), "temp folder");
  }
  assert.equal(scrub("a /x/y/z.md b /x/y", ["/x/y"]), "a z.md b .");
});

test("an answer over the cap is cut on a character boundary with a note", async () => {
  const big = createServer({
    site: h.site,
    registry: registryOf([tool("big", async () => ({ text: "é".repeat(100_000) }))]),
    info: { name: "t", version: "0" },
    limits: { maxAnswerBytes: 1000 },
  });
  const result = await call(big, "big");
  assert.ok(Buffer.byteLength(result.content[0].text) <= 1000);
  assert.match(result.content[0].text, /truncated/);
  assert.ok(!result.content[0].text.includes("�"));
  assert.equal(capAnswer("short", 100).truncated, false);
});

test("a call that outlives the timeout is stopped with an error, and the server still answers", async () => {
  const slow = createServer({
    site: h.site,
    registry: registryOf([tool("slow", () => new Promise(() => {})), tool("quick", async () => ({ text: "fine" }))]),
    info: { name: "t", version: "0" },
    limits: { callTimeoutMs: 1000 },
  });
  const result = await call(slow, "slow");
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /took longer than 1000 ms/);
  assert.equal((await call(slow, "quick")).content[0].text, "fine");
});

test("more calls than the in-flight limit are refused, and finished ones free their slot", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const busy = createServer({
    site: h.site,
    registry: registryOf([tool("hold", async () => (await gate, { text: "done" }))]),
    info: { name: "t", version: "0" },
    limits: { maxInFlight: 2 },
  });
  const running = [call(busy, "hold"), call(busy, "hold")];
  const refused = await call(busy, "hold");
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /Too many calls/);
  release();
  assert.deepEqual((await Promise.all(running)).map((r) => r.content[0].text), ["done", "done"]);
  assert.equal((await call(busy, "hold")).content[0].text, "done");
});

test("a handler that throws becomes an error result, not a crash", async () => {
  const bad = createServer({ site: h.site, registry: registryOf([tool("boom", async () => { throw new Error("kaboom"); })]), info: { name: "t", version: "0" } });
  const result = await call(bad, "boom");
  assert.equal(result.isError, true);
});
