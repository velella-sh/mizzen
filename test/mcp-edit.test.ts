import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { verifyProof } from "../src/cli/edit-verify.ts";
import { copyFixture, harness, type Harness } from "./mcp-helpers.ts";

let h: Harness;
before(async () => {
  h = await harness(copyFixture("docs-site"), { allowEdits: true });
});
after(() => h.close());

async function request(replacement: string) {
  const b = await h.call("get_block_source", { page: "/install/", text: "Beacon ships as a single binary" });
  assert.equal(b.data.status, "found");
  return { file: b.data.file, span: b.data.span, expected: b.data.text, beforeHash: b.data.beforeHash, replacement };
}

test("propose_edit shows the diff and writes nothing", async () => {
  const before = readFileSync(join(h.root, "install.md"), "utf8");
  const r = await h.call("propose_edit", await request("Beacon is one binary."));
  assert.equal(r.data.applied, false);
  assert.match(r.data.diff, /\+Beacon is one binary\./);
  assert.equal(readFileSync(join(h.root, "install.md"), "utf8"), before);
});

test("propose_edit refuses a stale hash and a wrong expected text", async () => {
  const req = await request("x");
  const stale = await h.call("propose_edit", { ...req, beforeHash: "0".repeat(64) });
  assert.equal(stale.isError, true);
  const wrong = await h.call("propose_edit", { ...req, expected: "not the text" });
  assert.equal(wrong.isError, true);
});

test("apply_edit writes the source and a proof that verifies, and the next read sees the change", async () => {
  const req = await request("Beacon is one binary.");
  const r = await h.call("apply_edit", req);
  assert.equal(r.data.applied, true);
  assert.match(readFileSync(join(h.root, "install.md"), "utf8"), /^Beacon is one binary\.$/m);
  assert.ok(existsSync(join(h.root, r.data.proof)));
  const page = await h.call("get_page", { page: "/install/" });
  assert.match(page.data.markdown, /Beacon is one binary\./);
  const verified = await verifyProof({ proof: join(h.root, r.data.proof), siteRoot: h.root });
  assert.equal(verified.failures.length, 0);
});

test("applying the same edit again is refused, the file unchanged, and no absolute path leaks", async () => {
  const r = await h.call("get_block_source", { page: "/install/", text: "Beacon is one binary." });
  assert.equal(r.data.status, "found");
  const req = { file: r.data.file, span: r.data.span, expected: "Beacon ships as a single binary", beforeHash: "1".repeat(64), replacement: "again" };
  const before = readFileSync(join(h.root, "install.md"), "utf8");
  const stale = await h.call("apply_edit", req);
  assert.equal(stale.isError, true);
  assert.equal(readFileSync(join(h.root, "install.md"), "utf8"), before);
  assert.ok(!stale.text.includes(h.root));
  assert.ok(!stale.text.includes("/Users/"));
});

test("without --allow-edits there is no apply_edit tool and calling it fails", async () => {
  const ro = await harness(copyFixture("docs-site"));
  try {
    const names = (await ro.rpc("tools/list")).result.tools.map((t: { name: string }) => t.name);
    assert.ok(!names.includes("apply_edit"));
    const r = await ro.rpc("tools/call", { name: "apply_edit", arguments: {} });
    assert.ok(r.error || r.result?.isError);
  } finally {
    await ro.close();
  }
});
