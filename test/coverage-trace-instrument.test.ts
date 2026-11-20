import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TraceDocument } from "../src/contracts/trace.ts";
import {
  recordEditApply,
  recordMcpEdit,
  recordPack,
  recordVerification,
  siteReference,
  standaloneTrace,
  traceEditApply,
  traceMcpEdit,
  tracePack,
  traceVerification,
  writeTraceFromEnv,
} from "../src/trace/instrument.ts";
import { TraceRecorder } from "../src/trace/record.ts";
import { inputHashOf } from "../src/trace/safe.ts";
import { traceFixture } from "./trace-fixture.ts";

const SPAN = { line: 3, column: 1, endLine: 3, endColumn: 8 };

/** A site root under the OS temp folder; the caller removes it. */
function site(): string {
  return mkdtempSync(join(tmpdir(), "trace-instrument-"));
}

/** A recorder pinned to a standalone task for `capability`. */
function recorder(capability = "edit.apply"): TraceRecorder {
  const standalone = standaloneTrace(capability);
  return new TraceRecorder({ task: standalone.task, snapshot: standalone.snapshot });
}

/** One applied edit with every field filled. */
function appliedEdit() {
  return {
    file: "docs/install.md",
    beforeHash: "1".repeat(64),
    afterHash: "2".repeat(64),
    proof: "docs/install.proof.json",
    dryRun: false,
    span: SPAN,
    patchHash: "3".repeat(64),
    diffHash: "4".repeat(64),
  };
}

test("a standalone trace is deterministic and pins the content hash", () => {
  const first = standaloneTrace("edit.apply");
  assert.deepEqual(first, standaloneTrace("edit.apply"));
  assert.equal(first.task.id, inputHashOf({ standalone: "edit.apply" }));
  assert.equal(first.task.goal, "Run edit.apply");
  assert.equal(first.snapshot.content, inputHashOf({ standalone: "edit.apply" }));

  const pinned = standaloneTrace("pack", "a".repeat(64));
  assert.equal(pinned.snapshot.content, "a".repeat(64));
  assert.match(pinned.snapshot.data, /^[0-9a-f]{64}$/);
  assert.match(pinned.snapshot.config, /^[0-9a-f]{64}$/);
  assert.match(pinned.snapshot.tooling, /^[0-9a-f]{64}$/);
});

test("a site reference is relative inside the root and absent outside it", () => {
  const root = site();
  try {
    assert.equal(siteReference(root, join(root, "docs/install.md")), "docs/install.md");
    assert.equal(siteReference(root, root), undefined);
    assert.equal(siteReference(root, join(root, "..", "outside.md")), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an applied edit records status, links, span, proof, and optional fields", () => {
  const root = site();
  try {
    const full = recorder();
    const event = recordEditApply(full, appliedEdit(), {
      subtask: "write",
      durationMs: 12,
      pack: "pack/install.json",
      root,
    });
    assert.equal(event.stage, "edit");
    assert.equal(event.kind, "edit");
    assert.equal(event.capability, "edit.apply");
    assert.equal(event.status, "ok");
    assert.equal(event.result, "docs/install.proof.json");
    assert.equal(event.file, "docs/install.md");
    assert.equal(event.subtask, "write");
    assert.equal(event.durationMs, 12);
    assert.equal(event.links?.patch, "3".repeat(64));
    assert.equal(event.links?.diff, "4".repeat(64));
    assert.equal(event.links?.pack, "pack/install.json");
    assert.deepEqual(event.links?.span, SPAN);
    assert.equal(full.document().receipts.length, 1);

    const { proof: _proof, ...withoutProof } = appliedEdit();
    const dry = recordEditApply(recorder(), { ...withoutProof, dryRun: true });
    assert.equal(dry.status, "skipped");
    assert.equal(dry.result, null);
    assert.equal(dry.subtask, undefined);
    assert.equal(dry.links?.pack, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a proof outside the root becomes a hashed reference, never an absolute path", () => {
  const root = site();
  try {
    const outside = join(root, "..", "elsewhere", "install.proof.json");
    const event = recordEditApply(recorder(), { ...appliedEdit(), proof: `..${"/"}${outside}` }, { root });
    assert.equal(event.result, `result-${inputHashOf(`../${outside}`)}`);
    assert.equal(JSON.stringify(event).includes(root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a verification records success, failure, reason, and proof references", () => {
  const root = site();
  try {
    const ok = recorder("edit.verify");
    const okEvent = recordVerification(
      ok,
      { ok: true, proof: join(root, "docs/install.proof.json"), siteRoot: root, files: 2, doctor: "clean", failures: [] },
      { subtask: "verify", durationMs: 5 },
    );
    assert.equal(okEvent.stage, "verify");
    assert.equal(okEvent.kind, "verify");
    assert.equal(okEvent.status, "ok");
    assert.equal(okEvent.result, "docs/install.proof.json");
    assert.equal(okEvent.reason, undefined);
    assert.equal(okEvent.subtask, "verify");
    assert.equal(okEvent.durationMs, 5);
    assert.equal(ok.document().receipts.length, 1);

    const failed = recordVerification(recorder("edit.verify"), {
      ok: false,
      proof: join(root, "docs/install.proof.json"),
      siteRoot: root,
      files: 1,
      doctor: "one error",
      failures: [{ kind: "link" }],
    });
    assert.equal(failed.status, "failed");
    assert.equal(failed.reason, "Verification failed: link.");

    const unknown = recordVerification(recorder("edit.verify"), {
      ok: false,
      proof: join(root, "docs/install.proof.json"),
      siteRoot: root,
      files: 1,
      doctor: "unknown failure",
      failures: [],
    });
    assert.equal(unknown.reason, "Verification failed: unknown.");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a verification proof outside the root is identified by its hash", () => {
  const root = site();
  try {
    const event = recordVerification(recorder("edit.verify"), {
      ok: true,
      proof: join(root, "..", "outside.proof.json"),
      siteRoot: root,
      files: 1,
      doctor: "clean",
      failures: [],
    });
    assert.equal(event.result, null);
    assert.match(String(event.inputHash), /^[0-9a-f]{64}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a context pack records its build, tokens, cost, and output reference", () => {
  const packed = {
    markdown: "# Install\n",
    evidence: { accounting: { used: 42 }, build: { id: "build-1" } },
  };
  const withOut = recorder("pack");
  const event = recordPack(withOut, packed, { out: "pack/install.md", subtask: "research", durationMs: 7 });
  assert.equal(event.stage, "context");
  assert.equal(event.kind, "context");
  assert.equal(event.capability, "pack");
  assert.equal(event.status, "ok");
  assert.equal(event.result, "pack/install.md");
  assert.equal(event.subtask, "research");
  assert.equal(event.durationMs, 7);
  assert.deepEqual(event.cost, { contextTokens: 42, refillTokens: 0, toolCalls: 1 });
  assert.equal(event.links?.pack, inputHashOf(packed.markdown));
  assert.equal(withOut.document().receipts.length, 1);

  const hashed = recordPack(recorder("pack"), packed);
  assert.equal(hashed.result, inputHashOf(packed.markdown));
});

test("an MCP edit records its tool capability, span, transaction, and proof", () => {
  const root = site();
  try {
    const full = recorder("mcp.apply_edit");
    const event = recordMcpEdit(
      full,
      { file: "docs/install.md", span: SPAN },
      { file: "docs/install.md", beforeHash: "1".repeat(64), afterHash: "2".repeat(64), proof: "docs/install.proof.json", diagnostics: 1 },
      { subtask: "tool", durationMs: 3, pack: "pack/tool.json", root },
    );
    assert.equal(event.stage, "edit");
    assert.equal(event.kind, "tool");
    assert.equal(event.capability, "mcp.apply_edit");
    assert.equal(event.result, "docs/install.proof.json");
    assert.equal(event.file, "docs/install.md");
    assert.equal(event.subtask, "tool");
    assert.equal(event.durationMs, 3);
    assert.deepEqual(event.links?.span, SPAN);
    assert.equal(event.links?.pack, "pack/tool.json");
    assert.equal(event.links?.transaction, inputHashOf({ before: "1".repeat(64), after: "2".repeat(64) }));
    assert.equal(full.document().receipts.length, 1);

    const bare = recordMcpEdit(recorder("mcp.apply_edit"), { file: "docs/a.md", span: SPAN }, {
      file: "docs/a.md",
      beforeHash: "a".repeat(64),
      afterHash: "b".repeat(64),
    });
    assert.equal(bare.result, null);
    assert.equal(bare.links?.pack, undefined);
    assert.equal(bare.subtask, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a trace is written only when MIZZEN_TRACE names a file", async () => {
  const root = site();
  try {
    const trace: TraceDocument = traceFixture();
    assert.equal(await writeTraceFromEnv(trace, {}), undefined);
    assert.equal(await writeTraceFromEnv(trace, { MIZZEN_TRACE: "   " }), undefined);
    assert.equal(existsSync(join(root, "trace.json")), false);

    const file = join(root, "nested", "trace.json");
    assert.equal(await writeTraceFromEnv(trace, { MIZZEN_TRACE: file }), file);
    const written = JSON.parse(readFileSync(file, "utf8")) as TraceDocument;
    assert.equal(written.id, trace.id);
    assert.equal(readFileSync(file, "utf8").endsWith("\n"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the trace helpers write nothing without a destination", async () => {
  await traceEditApply(appliedEdit(), undefined, {});
  await traceVerification(
    { ok: true, proof: "docs/install.proof.json", siteRoot: "/site", files: 1, doctor: "clean", failures: [] },
    {},
  );
  await tracePack({ markdown: "x", evidence: { accounting: { used: 1 }, build: { id: "b" } } }, {}, {});
  await traceMcpEdit({ file: "docs/a.md", span: SPAN }, { file: "docs/a.md", beforeHash: "a".repeat(64), afterHash: "b".repeat(64) }, {});
});

test("each enabled helper writes one trace with its own capability", async () => {
  const root = site();
  try {
    const reads: Array<[string, string]> = [
      ["edit.apply", join(root, "edit.json")],
      ["edit.verify", join(root, "verify.json")],
      ["pack", join(root, "pack.json")],
      ["mcp.apply_edit", join(root, "mcp.json")],
    ];
    const env = (file: string): NodeJS.ProcessEnv => ({ MIZZEN_TRACE: file });

    await traceEditApply(appliedEdit(), root, env(reads[0]![1]));
    await traceVerification(
      { ok: false, proof: "docs/install.proof.json", siteRoot: root, files: 1, doctor: "x", failures: [{ kind: "link" }] },
      env(reads[1]![1]),
    );
    await tracePack(
      { markdown: "# Pack\n", evidence: { accounting: { used: 9 }, build: { id: "b" } } },
      { out: "pack/out.md", root },
      env(reads[2]![1]),
    );
    await traceMcpEdit(
      { file: "docs/a.md", span: SPAN },
      { file: "docs/a.md", beforeHash: "a".repeat(64), afterHash: "b".repeat(64), proof: "docs/a.proof.json" },
      env(reads[3]![1]),
    );

    for (const [capability, file] of reads) {
      const trace = JSON.parse(readFileSync(file, "utf8")) as TraceDocument;
      assert.equal(trace.events.length, 1);
      assert.equal(trace.events[0]?.capability, capability);
      assert.equal(trace.events[0]?.sequence, 0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a trace write failure never fails the recorded call", async () => {
  const root = site();
  try {
    const blocker = join(root, "blocker");
    writeFileSync(blocker, "not a directory");
    const env: NodeJS.ProcessEnv = { MIZZEN_TRACE: join(blocker, "trace.json") };

    await traceEditApply(appliedEdit(), undefined, env);
    await traceVerification(
      { ok: true, proof: "docs/install.proof.json", siteRoot: root, files: 1, doctor: "clean", failures: [] },
      env,
    );
    await tracePack({ markdown: "x", evidence: { accounting: { used: 1 }, build: { id: "b" } } }, {}, env);
    await traceMcpEdit({ file: "docs/a.md", span: SPAN }, { file: "docs/a.md", beforeHash: "a".repeat(64), afterHash: "b".repeat(64) }, env);
    assert.equal(existsSync(join(blocker, "trace.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the same edit produces the same trace bytes", async () => {
  const root = site();
  try {
    const first = join(root, "one.json");
    const second = join(root, "two.json");
    await traceEditApply(appliedEdit(), undefined, { MIZZEN_TRACE: first });
    await traceEditApply(appliedEdit(), undefined, { MIZZEN_TRACE: second });
    assert.equal(readFileSync(first, "utf8"), readFileSync(second, "utf8"));
    mkdirSync(join(root, "unused"), { recursive: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
