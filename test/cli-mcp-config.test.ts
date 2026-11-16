import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CLIENTS, clientConfig, isClient } from "../src/cli/mcp.ts";
import { main, parseArgs, usage } from "../src/cli/index.ts";
import { loadTools } from "../src/mcp/registry.ts";
import { TOOLS } from "./mcp-helpers.ts";

const DOC = readFileSync(fileURLToPath(new URL("../site/mcp.md", import.meta.url)), "utf8");

function run(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  return main(args, { write: (t) => void out.push(t), error: (m) => void err.push(m), log: (m) => void out.push(m) }).then((code) => ({ code, out: out.join(""), err: err.join("\n") }));
}

for (const client of Object.keys(CLIENTS)) {
  test(`--print-config ${client} prints valid JSON that starts this server`, async () => {
    const r = await run(["mcp", "my/site", "--print-config", client]);
    assert.equal(r.code, 0);
    const config = JSON.parse(r.out);
    const servers = config[CLIENTS[client as keyof typeof CLIENTS]];
    assert.equal(servers.mizzen.command, "npx");
    assert.deepEqual(servers.mizzen.args, ["-y", "@velella/mizzen", "mcp", "my/site"]);
  });
}

test("--print-config carries --allow-edits only when asked, and is stable", () => {
  const read = clientConfig("cursor", ".", false);
  const write = clientConfig("cursor", ".", true);
  assert.ok(!read.includes("--allow-edits"));
  assert.ok(write.includes("--allow-edits"));
  assert.equal(clientConfig("cursor", ".", true), write);
});

test("an unknown client or option is a usage error", async () => {
  assert.equal(isClient("emacs"), false);
  const r = await run(["mcp", "--print-config", "emacs"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /--print-config must be one of/);
  assert.ok("error" in parseArgs(["mcp", "--nope"]));
  assert.ok("error" in parseArgs(["mcp", "a", "b"]));
});

test("help lists mcp and its flags", () => {
  assert.match(usage, /mcp \[dir\]/);
  assert.match(usage, /--allow-edits/);
  assert.match(usage, /--print-config/);
});

test("the docs page names every tool the server registers, and no tool it does not", async () => {
  const registry = await loadTools(TOOLS, { allowEdits: true, collections: ["c"] });
  for (const tool of registry.tools) assert.ok(DOC.includes(`\`${tool.name}\``), `site/mcp.md must name ${tool.name}`);
  const named = [...DOC.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]);
  const known = new Set(registry.tools.map((t) => t.name));
  for (const name of named) assert.ok(known.has(name!), `site/mcp.md names ${name}, which is not a tool`);
});
