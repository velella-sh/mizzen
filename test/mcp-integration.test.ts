/** The full loop with the official MCP client over a real subprocess and a real stdio pipe: no mocked transport. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { copyFixture, THEME } from "./mcp-helpers.ts";

const BIN = fileURLToPath(new URL("../bin/mizzen.ts", import.meta.url));
const clients: Client[] = [];

async function connect(root: string, extra: string[] = []): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN, "mcp", root, "--theme", THEME, ...extra],
    stderr: "ignore",
  });
  const client = new Client({ name: "mizzen-test", version: "0" });
  await client.connect(transport);
  clients.push(client);
  return client;
}

const text = (result: unknown): string => ((result as { content: { text: string }[] }).content[0]?.text ?? "");
const data = (result: unknown): any => JSON.parse(text(result));

after(async () => {
  await Promise.all(clients.map((c) => c.close()));
});

test("a real client searches, reads, finds a block, proposes, applies, and sees the change", { timeout: 180_000 }, async () => {
  const root = copyFixture("docs-site");
  const client = await connect(root, ["--allow-edits"]);
  const names = (await client.listTools()).tools.map((t) => t.name);
  for (const name of ["search_docs", "get_page", "list_pages", "get_block_source", "propose_edit", "apply_edit", "get_diagnostics", "get_pack"]) {
    assert.ok(names.includes(name), name);
  }

  const found = data(await client.callTool({ name: "search_docs", arguments: { query: "install" } }));
  assert.ok(found.results.some((r: { url: string }) => r.url === "/install/"));

  const page = data(await client.callTool({ name: "get_page", arguments: { page: "/install/" } }));
  assert.equal(page.source, "install.md");

  const block = data(await client.callTool({ name: "get_block_source", arguments: { page: "/install/", text: "Beacon ships as a single binary" } }));
  const edit = { file: block.file, span: block.span, expected: block.text, beforeHash: block.beforeHash, replacement: "Beacon is one binary." };

  const proposed = data(await client.callTool({ name: "propose_edit", arguments: edit }));
  assert.equal(proposed.applied, false);
  assert.match(readFileSync(join(root, "install.md"), "utf8"), /Beacon ships as a single binary/);

  const applied = data(await client.callTool({ name: "apply_edit", arguments: edit }));
  assert.equal(applied.applied, true);
  assert.match(readFileSync(join(root, "install.md"), "utf8"), /Beacon is one binary\./);

  const after = data(await client.callTool({ name: "get_page", arguments: { page: "/install/" } }));
  assert.match(after.markdown, /Beacon is one binary\./);

  const refused = await client.callTool({ name: "apply_edit", arguments: edit });
  assert.equal(refused.isError, true);

  const resources = await client.listResources();
  assert.ok(resources.resources.some((r) => r.uri === "mizzen://site/llms.txt"));
  const read = await client.readResource({ uri: "mizzen://site/llms.txt" });
  assert.ok(read.contents.length === 1);
});

test("a real client on a data site queries records, and a read-only server has no apply_edit", { timeout: 180_000 }, async () => {
  const client = await connect(copyFixture("data-site"));
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes("get_record") && names.includes("query_records"));
  assert.ok(!names.includes("apply_edit"));
  const record = data(await client.callTool({ name: "get_record", arguments: { collection: "components", id: "button" } }));
  assert.equal(record.url, "/components/button/");
  const list = data(await client.callTool({ name: "query_records", arguments: { collection: "components", fields: ["name"], limit: 3 } }));
  assert.equal(list.records.length, 3);
});

test("closing stdin ends the server cleanly", { timeout: 120_000 }, async () => {
  const client = await connect(copyFixture("data-site"));
  await client.ping();
  await client.close();
});
