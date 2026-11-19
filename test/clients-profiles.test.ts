/**
 * Two client profiles through the public `mizzen mcp` entry point: a full-featured client and a
 * limited one. Both read, search, and propose the same edit; only the full client applies it. The
 * limited client gets the declared fallbacks instead of a silent behavior change.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { verifyProof } from "../src/cli/edit-verify.ts";
import type { ClientHello } from "../src/contracts/clients.ts";
import { copyFixture, THEME } from "./mcp-helpers.ts";

const BIN = fileURLToPath(new URL("../bin/mizzen.ts", import.meta.url));
const servers: Server[] = [];

interface Server {
  readonly root: string;
  readonly child: ChildProcessWithoutNullStreams;
  readonly stderr: string[];
  rpc(method: string, params?: Record<string, unknown>): Promise<any>;
  close(): Promise<void>;
}

async function start(root: string): Promise<Server> {
  const child = spawn(process.execPath, [BIN, "mcp", root, "--theme", THEME, "--allow-edits"], { stdio: ["pipe", "pipe", "pipe"] });
  const stderr: string[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
  const pending = new Map<number, (value: any) => void>();
  let id = 0;
  createInterface({ input: child.stdout }).on("line", (line: string) => {
    const message = JSON.parse(line);
    if (typeof message.id === "number") pending.get(message.id)?.(message);
  });
  const server: Server = {
    root,
    child,
    stderr,
    rpc(method, params = {}) {
      const requestId = ++id;
      return new Promise((resolve) => {
        pending.set(requestId, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
      });
    },
    async close() {
      if (child.exitCode !== null) return;
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      child.stdin.end();
      await closed;
    },
  };
  servers.push(server);
  return server;
}

after(async () => {
  await Promise.all(servers.map((server) => server.close().catch(() => undefined)));
});

const fullHello: ClientHello = {
  protocolVersion: "2025-06-18",
  clientInfo: { name: "claude-code", version: "1" },
  capabilities: {
    tasks: { requests: { tools: { call: {} } } },
    elicitation: {},
    experimental: { mizzen: { contractVersion: 1, capabilities: { resources: true, notifications: true, progress: true, editing: true, cursors: true } } },
  },
};

const limitedHello: ClientHello = {
  protocolVersion: "2025-06-18",
  clientInfo: { name: "minimal-agent", version: "1" },
  capabilities: {
    experimental: {
      mizzen: {
        contractVersion: 1,
        capabilities: { tools: true, resources: false, notifications: false, progress: false, longRunningTasks: false, approvals: false, editing: false, cursors: false },
      },
    },
  },
};

const text = (result: any): string => result?.result?.content?.[0]?.text ?? "";
const data = (result: any): any => JSON.parse(text(result));

test("two client profiles read and propose identically, and the limited one gets honest fallbacks", { timeout: 300_000 }, async () => {
  const fullServer = await start(copyFixture("docs-site"));
  const limitedServer = await start(copyFixture("docs-site"));
  const fullInit = await fullServer.rpc("initialize", fullHello as unknown as Record<string, unknown>);
  const limitedInit = await limitedServer.rpc("initialize", limitedHello as unknown as Record<string, unknown>);

  // Capability reports come from the same contract, not from two code paths.
  assert.deepEqual(fullInit.result._meta.mizzen.fallbacks, []);
  assert.deepEqual(
    limitedInit.result._meta.mizzen.fallbacks.map((fallback: { capability: string }) => fallback.capability),
    ["resources", "notifications", "progress", "long-running-tasks", "approvals", "editing", "cursors"],
  );
  assert.ok(fullInit.result.capabilities.resources);
  assert.equal(limitedInit.result.capabilities.resources, undefined, "resources are not advertised to a client that declared none");
  assert.equal(fullInit.result._meta.mizzen.capabilities.longRunningTasks, true);
  assert.equal(limitedInit.result._meta.mizzen.capabilities.editing, false);

  const fullTools = (await fullServer.rpc("tools/list")).result.tools.map((tool: { name: string }) => tool.name);
  const limitedTools = (await limitedServer.rpc("tools/list")).result.tools.map((tool: { name: string }) => tool.name);
  assert.deepEqual(fullTools, limitedTools, "the tool list does not depend on the client");

  // The same read and the same proposal, byte for byte.
  const fullSearch = data(await fullServer.rpc("tools/call", { name: "search_docs", arguments: { query: "install" } }));
  const limitedSearch = data(await limitedServer.rpc("tools/call", { name: "search_docs", arguments: { query: "install" } }));
  assert.deepEqual(fullSearch, limitedSearch);
  assert.ok(fullSearch.results.some((result: { url: string }) => result.url === "/install/"));

  const fullPage = data(await fullServer.rpc("tools/call", { name: "get_page", arguments: { page: "/install/" } }));
  const limitedPage = data(await limitedServer.rpc("tools/call", { name: "get_page", arguments: { page: "/install/" } }));
  assert.deepEqual(fullPage, limitedPage);
  assert.equal(fullPage.source, "install.md");

  const block = { page: "/install/", text: "Beacon ships as a single binary" };
  const fullBlock = data(await fullServer.rpc("tools/call", { name: "get_block_source", arguments: block }));
  const limitedBlock = data(await limitedServer.rpc("tools/call", { name: "get_block_source", arguments: block }));
  assert.deepEqual(fullBlock, limitedBlock);

  const edit = { file: fullBlock.file, span: fullBlock.span, expected: fullBlock.text, beforeHash: fullBlock.beforeHash, replacement: "Beacon is one binary." };
  const fullProposal = data(await fullServer.rpc("tools/call", { name: "propose_edit", arguments: edit }));
  const limitedProposal = data(await limitedServer.rpc("tools/call", { name: "propose_edit", arguments: edit }));
  assert.deepEqual(fullProposal, limitedProposal, "the proposal is the same on both profiles");
  assert.equal(fullProposal.applied, false);

  // The full client applies and verifies the proof.
  const applied = data(await fullServer.rpc("tools/call", { name: "apply_edit", arguments: edit }));
  assert.equal(applied.applied, true);
  assert.equal(applied.afterHash, fullProposal.afterHash);
  assert.match(readFileSync(join(fullServer.root, applied.file), "utf8"), /Beacon is one binary\./);
  const verified = await verifyProof({ proof: join(fullServer.root, applied.proof), siteRoot: fullServer.root });
  assert.equal(verified.ok, true, JSON.stringify(verified.failures));

  // The limited client is refused with an actionable fallback and nothing changes.
  const before = readFileSync(join(limitedServer.root, edit.file), "utf8");
  const refused = await limitedServer.rpc("tools/call", { name: "apply_edit", arguments: edit });
  assert.equal(refused.result.isError, true);
  assert.equal(refused.result.structuredContent.code, "client-editing-unavailable");
  assert.match(refused.result.content[0].text, /propose_edit/);
  assert.equal(readFileSync(join(limitedServer.root, edit.file), "utf8"), before);

  // Pagination follows the declared capability: cursor for the full client, offset for the limited one.
  const fullList = data(await fullServer.rpc("tools/call", { name: "list_pages", arguments: { limit: 1 } }));
  const limitedList = data(await limitedServer.rpc("tools/call", { name: "list_pages", arguments: { limit: 1 } }));
  assert.ok(fullList.nextCursor);
  assert.equal(fullList.nextOffset, undefined);
  assert.ok(limitedList.nextOffset > 0);
  assert.equal(limitedList.nextCursor, undefined);
  assert.deepEqual(limitedList.pages, fullList.pages);

  // The startup report is on stderr, never on the protocol stream.
  assert.match(fullServer.stderr.join(""), /client claude-code .*all declared capabilities available/);
  assert.match(limitedServer.stderr.join(""), /client generic .*unavailable: resources, notifications, progress, long-running tasks, approvals, safe editing, cursors/);
});
