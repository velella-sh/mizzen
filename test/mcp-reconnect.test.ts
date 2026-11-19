/** The installed MCP client disconnects during verification, reconnects, and recovers one progress report and one receipt. */
import assert from "node:assert/strict";
import { copyFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
  const client = new Client({ name: "mizzen-reconnect", version: "0" });
  await client.connect(transport);
  clients.push(client);
  return client;
}

const data = (result: unknown): any => JSON.parse(((result as { content: { text: string }[] }).content[0]?.text ?? "{}"));

async function call(client: Client, session: string, name: string, args: Record<string, unknown>): Promise<any> {
  return client.callTool({ name, arguments: args, _meta: { session } } as never) as Promise<any>;
}

test("the installed client recovers one verification and one apply receipt after a reconnect", { timeout: 240_000 }, async () => {
  const root = copyFixture("docs-site");
  const session = "reconnect-verify";
  let client = await connect(root, ["--allow-edits"]);
  try {
    const block = data(await client.callTool({ name: "get_block_source", arguments: { page: "/install/", text: "Beacon ships as a single binary" } }));
    assert.equal(block.status, "found");
    const edit = {
      file: block.file,
      span: block.span,
      expected: block.text,
      beforeHash: block.beforeHash,
      replacement: "Beacon is one binary.",
      idempotencyKey: "reconnect-edit",
    };
    const applied = data(await call(client, session, "apply_edit", edit));
    assert.equal(applied.applied, true, JSON.stringify(applied));
    assert.match(applied.receiptId, /^rcpt-/);
    const file = join(root, "install.md");
    const once = readFileSync(file, "utf8");
    assert.equal((once.match(/Beacon is one binary\./g) ?? []).length, 1);

    // More proofs than one journal page keeps: verification has real work to resume.
    const proof = join(root, applied.proof);
    for (let index = 1; index < 40; index++) copyFileSync(proof, join(dirname(proof), `copy-${index}.proof.json`));

    const started = data(await call(client, session, "start_operation", { kind: "verify", input: {} }));
    assert.match(started.operationId, /^op-/);
    assert.equal(started.snapshot.startsWith("snap:"), true);

    await client.close();
    client = await connect(root, ["--allow-edits"]);

    let view: any;
    for (let attempt = 0; attempt < 10; attempt++) {
      view = data(await call(client, session, "get_operation", { operationId: started.operationId, waitMs: 5_000 }));
      if (view.status !== "running") break;
    }
    assert.equal(view.status, "succeeded", JSON.stringify(view));
    assert.equal(view.result.ok, true);
    assert.ok(view.result.verified >= 40);
    assert.equal(view.work.completed, view.work.total);
    assert.equal(view.events[0].stage, "start");
    assert.equal(view.events.at(-1).stage, "done");
    assert.ok(view.events.every((event: any) => event.completed <= event.total));

    const replayed = data(await call(client, session, "apply_edit", edit));
    assert.equal(replayed.idempotent, true);
    assert.equal(replayed.receiptId, applied.receiptId);
    assert.equal(replayed.proof, applied.proof);
    assert.equal(readFileSync(file, "utf8"), once);
    assert.equal((readFileSync(file, "utf8").match(/Beacon is one binary\./g) ?? []).length, 1);
  } finally {
    await client.close().catch(() => undefined);
  }
});

after(async () => {
  await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
});
