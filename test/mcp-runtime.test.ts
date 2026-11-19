/** The recoverable runtime: negotiation, async work, progress, cancellation, queues, deadlines, errors, and isolation. */
import assert from "node:assert/strict";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { createServer } from "../src/mcp/server.ts";
import { registryOf } from "../src/mcp/registry.ts";
import type { Tool } from "../src/mcp/tool.ts";
import { copyFixture, harness, type Harness } from "./mcp-helpers.ts";

let h: Harness;
before(async () => {
  h = await harness(copyFixture("docs-site"));
});
after(() => h.close());

function meta(session: string): Record<string, unknown> {
  return { session };
}

async function result(h: Harness, session: string, name: string, args: Record<string, unknown>): Promise<any> {
  return ((await h.rpc("tools/call", { name, arguments: args, _meta: meta(session) })).result ?? {}) as any;
}

async function start(h: Harness, session: string, kind: string, input: Record<string, unknown>): Promise<any> {
  const response = await result(h, session, "start_operation", { kind, input });
  return response.structuredContent ?? JSON.parse(response.content?.[0]?.text ?? "{}");
}

async function operation(h: Harness, session: string, operationId: string, extra: Record<string, unknown> = {}): Promise<any> {
  const response = await result(h, session, "get_operation", { operationId, ...extra });
  return response.structuredContent ?? JSON.parse(response.content?.[0]?.text ?? "{}");
}

async function settled(h: Harness, session: string, operationId: string): Promise<any> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const view = await operation(h, session, operationId, { waitMs: 5_000 });
    if (view.status !== "running") return view;
  }
  throw new Error(`operation ${operationId} did not settle`);
}

async function seedProofs(h: Harness, count: number): Promise<void> {
  const block = await h.call("get_block_source", { page: "/install/", text: "Beacon ships as a single binary" });
  assert.equal(block.data.status, "found");
  const applied = await h.call("apply_edit", {
    file: block.data.file,
    span: block.data.span,
    expected: block.data.text,
    beforeHash: block.data.beforeHash,
    replacement: "Beacon is one binary.",
  });
  assert.equal(applied.data.applied, true, applied.text);
  const source = join(h.root, applied.data.proof);
  for (let index = 1; index < count; index++) copyFileSync(source, join(dirname(source), `copy-${index}.proof.json`));
}

function custom(tools: readonly Tool[], limits?: Parameters<typeof createServer>[0]["limits"]) {
  return createServer({
    site: h.site,
    registry: registryOf(tools),
    info: { name: "t", version: "0" },
    log: () => {},
    ...(limits === undefined ? {} : { limits }),
  });
}

const tool = (name: string, handler: Tool["handler"], extra: Partial<Tool> = {}): Tool => ({
  name,
  description: "d",
  inputSchema: { type: "object", additionalProperties: false },
  handler,
  ...extra,
});

async function callRaw(server: ReturnType<typeof createServer>, name: string, args: Record<string, unknown> = {}): Promise<any> {
  return ((await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })) as any).result;
}

test("initialize announces the contract version, task capabilities, and limits", async () => {
  const response = (await h.rpc("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "test", version: "1" } })).result;
  assert.equal(response.protocolVersion, "2025-06-18");
  assert.ok(response.capabilities.tools);
  const announced = response.capabilities.experimental.mizzen;
  assert.equal(announced.contractVersion, 1);
  assert.deepEqual(announced.tasks.operations, ["pack", "verify", "replay"]);
  assert.equal(announced.tasks.async, true);
  assert.equal(announced.tasks.recovery, true);
  assert.ok(announced.limits.verifyTimeoutMs >= announced.limits.readTimeoutMs);
  assert.ok(announced.limits.maxEventsPerOperation > 0);
  assert.ok(announced.limits.maxOperations > 0);
});

test("an older client gets the same core answers without structuredContent", async () => {
  const old = await harness(copyFixture("docs-site"));
  try {
    const init = (await old.rpc("initialize", { protocolVersion: "2024-11-05", clientInfo: { name: "old", version: "0" } })).result;
    assert.equal(init.protocolVersion, "2024-11-05");
    assert.ok(init.capabilities.tools);
    const page = (await old.rpc("tools/call", { name: "get_page", arguments: { page: "/install/" } })).result;
    assert.equal(page.structuredContent, undefined);
    assert.equal(JSON.parse(page.content[0].text).source, "install.md");
  } finally {
    await old.close();
  }
});

test("a pack starts asynchronously, reports real progress, and settles with its result", async () => {
  const started = await start(h, "pack-async", "pack", { goal: "install beacon", maxTokens: 800 });
  assert.equal(started.ok, true);
  assert.match(started.operationId, /^op-/);
  assert.ok(started.work.total >= 1);
  const done = await settled(h, "pack-async", started.operationId);
  assert.equal(done.status, "succeeded");
  assert.match(done.result.markdown, /Context pack/);
  assert.equal(done.work.completed, done.work.total);
  assert.ok(done.events.length >= 2);
  for (const event of done.events) {
    assert.equal(typeof event.stage, "string");
    assert.equal(typeof event.completed, "number");
    assert.equal(typeof event.total, "number");
    assert.equal(typeof event.expected, "string");
    assert.ok(event.completed >= 0 && event.completed <= event.total);
  }
  const last = done.events.at(-1);
  assert.equal(last.stage, "done");
  assert.equal(last.completed, last.total);
});

test("a background get_pack returns an operation id at once", async () => {
  const response = (await result(h, "pack-background", "get_pack", { goal: "install beacon", maxTokens: 800, background: true })).structuredContent;
  assert.equal(response.ok, true);
  assert.match(response.operationId, /^op-/);
  const done = await settled(h, "pack-background", response.operationId);
  assert.equal(done.status, "succeeded");
  assert.match(done.result.markdown, /Context pack/);
});

test("cancelling an operation keeps no partial result", async () => {
  const edits = await harness(copyFixture("docs-site"), { allowEdits: true });
  try {
    await seedProofs(edits, 300);
    const started = await start(edits, "cancel", "verify", {});
    const cancelled = (await result(edits, "cancel", "cancel_operation", { operationId: started.operationId })).structuredContent;
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.error.code, "cancelled");
    assert.equal(cancelled.result, undefined);
    const view = await operation(edits, "cancel", started.operationId);
    assert.equal(view.status, "cancelled");
    assert.equal(view.result, undefined);
  } finally {
    await edits.close();
  }
});

test("operation and event limits refuse or bound work instead of growing", async () => {
  const bounded = await harness(copyFixture("docs-site"), { allowEdits: true, limits: { maxOperations: 1, maxEventsPerOperation: 3, maxOperationRecords: 2 } });
  try {
    await seedProofs(bounded, 30);
    const first = await start(bounded, "bounded", "verify", {});
    const busy = await result(bounded, "bounded", "start_operation", { kind: "pack", input: { goal: "install", maxTokens: 500 } });
    assert.equal(busy.isError, true);
    assert.equal(busy.structuredContent.code, "busy");
    assert.equal(busy.structuredContent.retryable, true);
    const done = await settled(bounded, "bounded", first.operationId);
    assert.equal(done.status, "succeeded");
    assert.ok(done.dropped > 0);
    const gap = await result(bounded, "bounded", "get_operation", { operationId: first.operationId, after: 0 });
    assert.equal(gap.isError, true);
    assert.equal(gap.structuredContent.code, "event-gap");
    assert.equal(gap.structuredContent.retryable, true);
    assert.equal(typeof gap.structuredContent.retryFrom, "number");
  } finally {
    await bounded.close();
  }
});

test("a read-only operation resumes after its server stops", async () => {
  const first = await harness(copyFixture("docs-site"), { allowEdits: true, limits: { maxAnswerBytes: 1_000_000 } });
  const root = first.root;
  let started: any;
  try {
    await seedProofs(first, 40);
    started = await start(first, "resume", "verify", {});
  } finally {
    await first.close();
  }
  const second = await harness(root, { allowEdits: true, limits: { maxAnswerBytes: 1_000_000 } });
  try {
    const done = await settled(second, "resume", started.operationId);
    assert.equal(done.status, "succeeded", JSON.stringify(done));
    assert.equal(done.resumed, true);
    assert.equal(done.result.ok, true);
    assert.equal(done.result.verified, 40);
    assert.equal(done.work.completed, done.work.total);
    assert.equal(done.events[0].stage, "start");
    assert.equal(done.events.at(-1).stage, "done");
    assert.ok(done.events.every((event: any) => event.completed >= 0 && event.completed <= event.total));
  } finally {
    await second.close();
  }
});

test("read and verify deadlines are independent", async () => {
  const slow = (name: string, stage: "read" | "verify"): Tool =>
    tool(
      name,
      () => new Promise((resolve) => setTimeout(() => resolve({ text: "done" }), 120)),
      { stage },
    );
  const server = custom([slow("slow_read", "read"), slow("slow_verify", "verify")], {
    readTimeoutMs: 40,
    callTimeoutMs: 40,
    verifyTimeoutMs: 2_000,
  });
  try {
    const read = await callRaw(server, "slow_read");
    assert.equal(read.isError, true);
    assert.match(read.content[0].text, /took longer than 40 ms/);
    const verify = await callRaw(server, "slow_verify");
    assert.equal(verify.isError, undefined);
    assert.equal(verify.content[0].text, "done");
  } finally {
    await server.close();
  }
});

test("cancelling one call aborts its handler and frees the slot", async () => {
  const waiting = tool("wait", async (_input, { signal }) => {
    await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    return { text: "never" };
  });
  const server = custom([waiting, tool("quick", async () => ({ text: "ok" }))]);
  try {
    const pending = server.handle({ jsonrpc: "2.0", id: 41, method: "tools/call", params: { name: "wait", arguments: {} } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(await server.handle({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 41 } }), undefined);
    const response = (await pending) as any;
    assert.equal(response.result.isError, true);
    assert.equal(response.result.structuredContent.code, "cancelled");
    assert.equal(response.result.structuredContent.retryable, true);
    assert.equal((await callRaw(server, "quick")).content[0].text, "ok");
  } finally {
    await server.close();
  }
});

test("errors are machine-readable and never carry a stack or a local path", async () => {
  const unknown = (await h.rpc("tools/call", { name: "nope", arguments: {} })).result as any;
  assert.equal(unknown.structuredContent.code, "unknown-tool");
  assert.equal(unknown.structuredContent.stage, "read");
  assert.equal(unknown.structuredContent.retryable, false);
  const bad = (await h.rpc("tools/call", { name: "get_page", arguments: { page: 5 } })).result as any;
  assert.equal(bad.structuredContent.code, "invalid-input");
  assert.match(bad.content[0].text, /Invalid input/);

  const leak = custom([
    tool("leak", async () => {
      throw new Error(`kaboom at ${h.site.root}/secret.ts\n  at internal.ts:1:1`);
    }),
  ]);
  try {
    const response = await callRaw(leak, "leak");
    assert.equal(response.isError, true);
    assert.ok(!response.content[0].text.includes(h.site.root));
    assert.ok(!response.content[0].text.includes("/Users/"));
    assert.ok(!response.content[0].text.includes("at internal.ts"));
  } finally {
    await leak.close();
  }
});

test("private fields are dropped and this machine's folders are scrubbed from structured answers", async () => {
  const redact = custom([
    tool("redact", async () => ({
      text: JSON.stringify({ token: "t", path: h.site.root, note: "ok" }),
      data: { token: "t", password: "p", apiKey: "k", path: h.site.root, note: "ok" },
    })),
  ]);
  try {
    const response = await callRaw(redact, "redact");
    assert.equal(response.structuredContent.token, undefined);
    assert.equal(response.structuredContent.password, undefined);
    assert.equal(response.structuredContent.apiKey, undefined);
    assert.equal(response.structuredContent.note, "ok");
    assert.ok(!JSON.stringify(response).includes(h.site.root));
  } finally {
    await redact.close();
  }
});

test("an oversized answer is cut and marked, and its structured twin is dropped", async () => {
  const big = custom([tool("big", async () => ({ text: "x".repeat(2_000), data: { blob: "x".repeat(2_000) } }))], { maxAnswerBytes: 300 });
  try {
    const response = await callRaw(big, "big");
    assert.ok(Buffer.byteLength(response.content[0].text) <= 300);
    assert.match(response.content[0].text, /truncated/);
    assert.equal(response._meta.truncated, true);
    assert.equal(response._meta.limit, 300);
    assert.equal(response.structuredContent, undefined);
  } finally {
    await big.close();
  }
});

test("two sessions keep operations and results apart while both read the same site", async () => {
  for (const session of ["iso-a", "iso-b"]) {
    await h.rpc("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "iso", version: "1" }, _meta: meta(session) });
  }
  const started = await start(h, "iso-a", "pack", { goal: "install beacon", maxTokens: 500 });
  const hidden = await result(h, "iso-b", "get_operation", { operationId: started.operationId });
  assert.equal(hidden.isError, true);
  assert.equal(hidden.structuredContent.code, "unknown-operation");

  const pageB = await h.call("get_page", { page: "/install/" }, meta("iso-b"));
  assert.equal(pageB.isError, false);
  assert.equal(pageB.data.source, "install.md");

  const done = await settled(h, "iso-a", started.operationId);
  assert.equal(done.status, "succeeded");
});

test("a site change refuses a pinned session until it resumes on the fresh snapshot", async () => {
  const snap = await harness(copyFixture("docs-site"));
  try {
    const first = (await snap.rpc("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "snap", version: "1" }, _meta: meta("snap-1") })).result;
    const before = await snap.call("get_page", { page: "/install/" }, meta("snap-1"));
    assert.equal(before.isError, false);
    const file = join(snap.root, "install.md");
    writeFileSync(file, `${readFileSync(file, "utf8")}\n\nA new paragraph.\n`, "utf8");

    const changed = (await snap.rpc("tools/call", { name: "get_page", arguments: { page: "/install/" }, _meta: meta("snap-1") })).result;
    assert.equal(changed.isError, true);
    assert.equal(changed.structuredContent.code, "snapshot-changed");
    assert.equal(changed.structuredContent.retryable, true);
    const fresh = changed.structuredContent.snapshot;
    assert.match(fresh, /^snap:/);
    assert.notEqual(fresh, first.capabilities.experimental.mizzen.snapshot);

    const again = (await snap.rpc("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "snap", version: "1" }, _meta: meta("snap-1") })).result;
    assert.equal(again.snapshotChanged, true);
    assert.equal(again.capabilities.experimental.mizzen.snapshot, fresh);

    const after = await snap.call("get_page", { page: "/install/" }, meta("snap-1"));
    assert.equal(after.isError, false);
    assert.match(after.data.markdown, /A new paragraph\./);
  } finally {
    await snap.close();
  }
});
