import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadTools, RegistryError, registryOf } from "../src/mcp/registry.ts";
import { TOOLS } from "./mcp-helpers.ts";

const TOOL = (name: string, extra = "") =>
  `export const tool = { name: "${name}", description: "d", inputSchema: { type: "object", properties: { n: { type: "integer" } }, required: ["n"], additionalProperties: false }, ${extra} async handler() { return { text: "ok" }; } };\n`;

function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "mcp-reg-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

test("tools are discovered from files, in name order, with no shared list", async () => {
  const dir = folder({ "zeta.ts": TOOL("zeta"), "alpha.ts": TOOL("alpha") });
  const registry = await loadTools(dir, { allowEdits: false, collections: [] });
  assert.deepEqual(registry.tools.map((t) => t.name), ["alpha", "zeta"]);
});

test("a tool whose name is not its file name is refused", async () => {
  const dir = folder({ "alpha.ts": TOOL("beta") });
  await assert.rejects(loadTools(dir, { allowEdits: false, collections: [] }), (e: unknown) => e instanceof RegistryError && /must be "alpha"/.test((e as Error).message));
});

test("a file that exports no tool is refused", async () => {
  const dir = folder({ "alpha.ts": "export const x = 1;\n" });
  await assert.rejects(loadTools(dir, { allowEdits: false, collections: [] }), RegistryError);
});

test("enabled leaves a tool out", async () => {
  const dir = folder({ "alpha.ts": TOOL("alpha", "enabled: (s) => s.allowEdits,") });
  assert.equal((await loadTools(dir, { allowEdits: false, collections: [] })).tools.length, 0);
  assert.equal((await loadTools(dir, { allowEdits: true, collections: [] })).tools.length, 1);
});

test("input is validated against the schema", async () => {
  const registry = await loadTools(folder({ "alpha.ts": TOOL("alpha") }), { allowEdits: false, collections: [] });
  assert.deepEqual(registry.validate("alpha", { n: 1 }), []);
  assert.ok(registry.validate("alpha", {}).length > 0);
  assert.ok(registry.validate("alpha", { n: "x" }).length > 0);
  assert.ok(registry.validate("alpha", { n: 1, extra: 1 }).length > 0);
  assert.ok(registry.validate("missing", {}).length > 0);
  assert.equal(registryOf([]).tools.length, 0);
});

test("the shipped tools load, each named like its file", async () => {
  const registry = await loadTools(TOOLS, { allowEdits: true, collections: ["c"] });
  assert.ok(registry.tools.length >= 10);
});
