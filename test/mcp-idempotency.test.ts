/** Applying the same edit twice with one idempotency key returns one receipt and one transaction. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { copyFixture, harness, type Harness } from "./mcp-helpers.ts";

let h: Harness;
before(async () => {
  h = await harness(copyFixture("docs-site"), { allowEdits: true });
});
after(() => h.close());

let request: Record<string, unknown>;

async function edit(session: string, text = "Beacon ships as a single binary"): Promise<Record<string, unknown>> {
  const block = await h.call("get_block_source", { page: "/install/", text }, { session });
  assert.equal(block.data.status, "found");
  return {
    file: block.data.file,
    span: block.data.span,
    expected: block.data.text,
    beforeHash: block.data.beforeHash,
    replacement: "Beacon is one binary.",
  };
}

test("the same key returns the same receipt and writes once", async () => {
  request = await edit("idem");
  const first = await h.call("apply_edit", { ...request, idempotencyKey: "idem-1" }, { session: "idem" });
  assert.equal(first.isError, false, first.text);
  assert.equal(first.data.applied, true);
  assert.equal(first.data.idempotent, false);
  assert.match(first.data.receiptId, /^rcpt-/);
  const file = join(h.root, "install.md");
  const afterFirst = readFileSync(file, "utf8");
  assert.equal((afterFirst.match(/Beacon is one binary\./g) ?? []).length, 1);

  const second = await h.call("apply_edit", { ...request, idempotencyKey: "idem-1" }, { session: "idem" });
  assert.equal(second.isError, false, second.text);
  assert.equal(second.data.idempotent, true);
  assert.equal(second.data.proof, first.data.proof);
  assert.equal(second.data.receiptId, first.data.receiptId);
  assert.equal(second.data.afterHash, first.data.afterHash);
  assert.equal(readFileSync(file, "utf8"), afterFirst);
});

test("the same key with a different payload is refused", async () => {
  const conflict = await h.call("apply_edit", { ...request, replacement: "Something else.", idempotencyKey: "idem-1" }, { session: "idem" });
  assert.equal(conflict.isError, true);
  const raw = (await h.rpc("tools/call", {
    name: "apply_edit",
    arguments: { ...request, replacement: "Something else.", idempotencyKey: "idem-1" },
    _meta: { session: "idem" },
  })).result as any;
  assert.equal(raw.structuredContent.code, "idempotency-conflict");
  assert.equal(raw.structuredContent.retryable, false);
  assert.match(readFileSync(join(h.root, "install.md"), "utf8"), /Beacon is one binary\./);
});

test("another session cannot replay or overwrite a receipt", async () => {
  const second = await edit("owner", "Beacon is one binary.");
  const first = await h.call("apply_edit", { ...second, replacement: "Beacon is a single binary.", idempotencyKey: "idem-2" }, { session: "owner" });
  assert.equal(first.isError, false, first.text);
  const other = await h.rpc("tools/call", {
    name: "apply_edit",
    arguments: { ...second, replacement: "Beacon is a single binary.", idempotencyKey: "idem-2" },
    _meta: { session: "intruder" },
  });
  assert.equal((other as any).result.structuredContent.code, "idempotency-conflict");
});

test("a receipt survives a disconnect and a new server process", async () => {
  const first = await harness(copyFixture("docs-site"), { allowEdits: true });
  const request = await (async () => {
    const block = await first.call("get_block_source", { page: "/install/", text: "Beacon ships as a single binary" });
    return {
      file: block.data.file,
      span: block.data.span,
      expected: block.data.text,
      beforeHash: block.data.beforeHash,
      replacement: "Beacon is one binary.",
      idempotencyKey: "idem-reconnect",
    };
  })();
  const applied = await first.call("apply_edit", request, { session: "reconnect" });
  assert.equal(applied.isError, false, applied.text);
  const file = join(first.root, "install.md");
  const content = readFileSync(file, "utf8");
  await first.close();

  const second = await harness(first.root, { allowEdits: true });
  try {
    const replayed = await second.call("apply_edit", request, { session: "reconnect" });
    assert.equal(replayed.isError, false, replayed.text);
    assert.equal(replayed.data.idempotent, true);
    assert.equal(replayed.data.proof, applied.data.proof);
    assert.equal(replayed.data.receiptId, applied.data.receiptId);
    assert.equal(readFileSync(file, "utf8"), content);
  } finally {
    await second.close();
  }
});
