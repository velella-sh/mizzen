/** Runtime operations directly: packs, replay, verify, cancellation, recovery, limits, and progress. */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { DEFAULT_LIMITS, MAX_PACK_TOKENS, type Limits } from "../src/mcp/limits.ts";
import { Runtime, type OperationView, type Session } from "../src/mcp/runtime/operations.ts";
import { copyFixture, harness, type Harness } from "./mcp-helpers.ts";

let h: Harness;
before(async () => {
  h = await harness(copyFixture("docs-site"));
});
after(() => h.close());

function runtimeOf(limits: Partial<Limits> = {}): Runtime {
  return new Runtime(h.site, { ...DEFAULT_LIMITS, ...limits }, () => [h.root]);
}

async function open(runtime: Runtime, token = "ops", snapshot = h.site.snapshot): Promise<Session> {
  return runtime.openSession(token, snapshot, "2025-06-18", true);
}

async function settle(runtime: Runtime, session: Session, id: string): Promise<OperationView> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const view = await runtime.operation(session, id, undefined, 5_000);
    if (view.status !== "running") return view;
  }
  throw new Error(`operation ${id} did not settle`);
}

const REGISTER = { sequence: 0, taskId: "task-1", snapshot: "snap-1", from: null, to: "draft", reason: "registered", result: null };
const READY = { sequence: 1, taskId: "task-1", snapshot: "snap-1", from: "draft", to: "ready", reason: "run", result: null };

test("pack: progress notifications, pinning, and the event-gap refusal", async () => {
  const runtime = runtimeOf({ maxEventsPerOperation: 2 });
  try {
    const session = await open(runtime, "pack-progress");
    const notices: Record<string, unknown>[] = [];
    runtime.notify = (message) => notices.push(message);
    const started = await runtime.start(session, "pack", { goal: "install beacon", maxTokens: 800 }, "token-1");
    const done = await settle(runtime, session, started.operationId);
    assert.equal(done.status, "succeeded");
    assert.match(String(done.result?.markdown), /Context pack/);
    assert.ok(notices.length > 0, "progress notifications were sent");
    const progress = notices.find((message) => message.method === "notifications/progress") as any;
    assert.equal(progress.params.progressToken, "token-1");
    assert.equal(typeof progress.params.message, "string");

    await assert.rejects(
      runtime.operation(session, started.operationId, 0, 0),
      (error: any) => error.code === "event-gap",
    );

    const pinned = await runtime.openSession("pack-progress", "snap:other", "2025-06-18", true);
    assert.equal(pinned.snapshot, "snap:other");
  } finally {
    await runtime.close();
  }
});

test("pack: a large budget is refused and a bad request is named", async () => {
  const runtime = runtimeOf();
  try {
    const session = await open(runtime, "pack-failures");
    await assert.rejects(
      runtime.start(session, "pack", { goal: "install", maxTokens: MAX_PACK_TOKENS + 1 }),
      (error: any) => error.code === "budget-too-large",
    );
    await assert.rejects(
      runtime.start(session, "pack", { goal: "install", maxTokens: 0 }),
      (error: any) => error.code === "bad-request",
    );
  } finally {
    await runtime.close();
  }
});

test("replay: a full stream, a broken stream, and a missing request", async () => {
  const runtime = runtimeOf();
  try {
    const session = await open(runtime, "replay");
    const success = await runtime.start(session, "replay", { taskId: "task-1", events: [REGISTER, READY] });
    const done = await settle(runtime, session, success.operationId);
    assert.equal(done.status, "succeeded");
    assert.equal(done.result?.ok, true);
    assert.equal(done.result?.state, "ready");

    const broken = await runtime.start(session, "replay", { taskId: "task-1", events: [REGISTER, { ...READY, from: "running" }] });
    const brokenDone = await settle(runtime, session, broken.operationId);
    assert.equal(brokenDone.status, "succeeded");
    assert.equal(brokenDone.result?.ok, false);
    assert.ok(Array.isArray(brokenDone.result?.problems));

    const taskDocument = await runtime.start(session, "replay", { task: { id: "task-2", events: [REGISTER, READY] } });
    const documentDone = await settle(runtime, session, taskDocument.operationId);
    assert.equal(documentDone.status, "succeeded");

    await assert.rejects(
      runtime.start(session, "replay", {}),
      (error: any) => error.code === "bad-request",
    );
  } finally {
    await runtime.close();
  }
});

test("verify: an explicit proof path, a default folder scan, and a path outside the site", async () => {
  const runtime = runtimeOf();
  try {
    const session = await open(runtime, "verify");
    const edits = join(h.root, ".mizzen", "mcp", "edits");
    mkdirSync(edits, { recursive: true });
    writeFileSync(join(edits, "one.proof.json"), "{}\n");

    const scanned = await runtime.start(session, "verify", {});
    const scannedDone = await settle(runtime, session, scanned.operationId);
    assert.equal(scannedDone.status, "succeeded");
    assert.equal(scannedDone.result?.verified, 1);

    const named = await runtime.start(session, "verify", { proof: ".mizzen/mcp/edits/one.proof.json" });
    const namedDone = await settle(runtime, session, named.operationId);
    assert.equal(namedDone.status, "succeeded");

    await assert.rejects(
      runtime.start(session, "verify", { proof: "../outside.proof.json" }),
      (error: any) => error.code === "path-outside-site",
    );
  } finally {
    await runtime.close();
  }
});

test("cancel refuses an unknown id and a finished operation is returned unchanged", async () => {
  const runtime = runtimeOf();
  try {
    const session = await open(runtime, "cancel");
    await assert.rejects(
      runtime.cancel(session, "op-9999"),
      (error: any) => error.code === "unknown-operation",
    );
    const started = await runtime.start(session, "replay", { taskId: "task-1", events: [REGISTER] });
    const done = await settle(runtime, session, started.operationId);
    const again = await runtime.cancel(session, started.operationId);
    assert.equal(again.status, done.status);
  } finally {
    await runtime.close();
  }
});

test("a corrupt receipts file starts empty and a malformed session file starts fresh", async () => {
  const runtime = runtimeOf();
  const session = await open(runtime, "corrupt");
  const id = session.id;
  await runtime.close();

  const dir = join(h.root, ".mizzen", "mcp", "runtime");
  writeFileSync(join(dir, "receipts.json"), "{not json");
  writeFileSync(join(dir, "sessions", `${id}.json`), "{not json");
  const second = runtimeOf();
  try {
    const reopened = await second.openSession("corrupt", h.site.snapshot, "2025-06-18", true);
    assert.equal(reopened.id, id);
    assert.equal((await second.receipt(reopened, "absent", "hash")), undefined);
  } finally {
    await second.close();
  }

  writeFileSync(join(dir, "sessions", `${id}.json`), JSON.stringify({ version: 2, id: "other", operations: [] }));
  const third = runtimeOf();
  try {
    const fresh = await third.openSession("corrupt", h.site.snapshot, "2025-06-18", true);
    assert.equal(fresh.snapshot, h.site.snapshot);
  } finally {
    await third.close();
  }
});

test("a running operation from a dead owner becomes interrupted; old records are pruned", async () => {
  const runtime = runtimeOf({ maxOperationRecords: 1 });
  const session = await open(runtime, "resume");
  await session.pin(h.site.snapshot);
  const path = join(h.root, ".mizzen", "mcp", "runtime", "sessions", `${session.id}.json`);
  const file = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
  file.operations.push({
    id: "op-9999",
    kind: "replay",
    status: "running",
    stage: "start",
    completed: 0,
    total: 1,
    expected: "the events replay to one task state",
    events: [],
    dropped: 0,
    lastSeq: 0,
    snapshot: h.site.snapshot,
    owner: "999999:dead",
    pid: 999999,
    resumed: false,
  });
  writeFileSync(path, JSON.stringify(file));
  await runtime.close();

  const second = runtimeOf({ maxOperationRecords: 1 });
  try {
    const reopened = await open(second, "resume");
    const interrupted = await second.operation(reopened, "op-9999", undefined, 0);
    assert.equal(interrupted.status, "interrupted");
    assert.equal(interrupted.error?.code, "interrupted");

    for (let index = 0; index < 3; index++) {
      const started = await second.start(reopened, "replay", { taskId: "task-1", events: [REGISTER] });
      const done = await settle(second, reopened, started.operationId);
      assert.equal(done.status, "succeeded");
    }
  } finally {
    await second.close();
  }
});

test("receipts are recorded, replayed, and refused across payloads and sessions", async () => {
  const runtime = runtimeOf();
  try {
    const owner = await open(runtime, "receipt-owner");
    const other = await open(runtime, "receipt-other");
    const recorded = await runtime.recordReceipt(owner, "key-1", "hash-1", { ok: true, token: "private" });
    assert.match(recorded.id, /^rcpt-/);
    assert.equal(recorded.result.token, undefined, "private fields are dropped");

    const replayed = await runtime.receipt(owner, "key-1", "hash-1");
    assert.deepEqual(replayed, recorded);
    await assert.rejects(runtime.receipt(owner, "key-1", "hash-2"), (error: any) => error.code === "idempotency-conflict");
    await assert.rejects(runtime.receipt(other, "key-1", "hash-1"), (error: any) => error.code === "idempotency-conflict");

    const replaced = await runtime.recordReceipt(owner, "key-1", "hash-1", { ok: false });
    assert.equal((await runtime.receipt(owner, "key-1", "hash-1"))?.result.ok, false);
    assert.equal(replaced.result.ok, false);
  } finally {
    await runtime.close();
  }

  const reopened = runtimeOf();
  try {
    const session = await open(reopened, "receipt-owner");
    assert.equal((await reopened.receipt(session, "key-1", "hash-1"))?.result.ok, false, "a receipt survives a restart");
  } finally {
    await reopened.close();
  }
});

test("a session at its operation limit refuses another start with busy", async () => {
  const runtime = runtimeOf({ maxOperations: 1, verifyTimeoutMs: 60_000 });
  try {
    const session = await open(runtime, "busy");
    const edits = join(h.root, ".mizzen", "mcp", "edits");
    for (let index = 0; index < 2_000; index++) writeFileSync(join(edits, `busy-${index}.proof.json`), "{}\n");
    const first = await runtime.start(session, "verify", {});
    await assert.rejects(
      runtime.start(session, "pack", { goal: "install", maxTokens: 100 }),
      (error: any) => error.code === "busy" && error.details.retryable === true,
    );
    await runtime.cancel(session, first.operationId);
  } finally {
    await runtime.close();
  }
});

test("an operation whose timer fires fails with operation-timeout", async () => {
  const runtime = runtimeOf({ verifyTimeoutMs: 1 });
  try {
    const session = await open(runtime, "timeout");
    const edits = join(h.root, ".mizzen", "mcp", "edits");
    for (let index = 0; index < 200; index++) writeFileSync(join(edits, `timeout-${index}.proof.json`), "{}\n");
    const started = await runtime.start(session, "verify", {});
    const done = await settle(runtime, session, started.operationId);
    assert.equal(done.status, "failed", JSON.stringify(done));
    assert.equal(done.error?.code, "operation-timeout");
    assert.equal(done.error?.retryable, true);
  } finally {
    await runtime.close();
  }
});
