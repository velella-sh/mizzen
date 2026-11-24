/**
 * Downstream change propagation end to end: a preview before publishing, a proposal that keeps the upstream source
 * untouched, an approval-gated apply, deduplication and no-ops, partial results, and the public CLI over real bundle
 * files. Every stable behavior has one test a release scope entry can name.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SnapshotView } from "../src/contracts/propagation.ts";
import { runPropagation } from "../src/cli/propagation.ts";
import { proposeTask } from "../src/propagation/propose.ts";
import {
  emptyLedger,
  verifyReceipt,
  withVerifiedReceipt,
} from "../src/propagation/receipt.ts";
import { applyPropagation, previewPropagation } from "../src/propagation/run.ts";
import {
  PRIVATE,
  behavior,
  bundle,
  consumer,
  decision,
  evidence,
  manifest,
  surfaceItem,
  view,
  writeManifest,
  writeSnapshot,
} from "./propagation-fixture.ts";

/** A change to `api:greet` and its behavior, with a decision and evidence. */
function change(): { baseline: SnapshotView; current: SnapshotView } {
  return {
    baseline: view({
      version: "1.0.0",
      surface: [surfaceItem("greet", { signature: "greet(name)" })],
      behaviors: [behavior("greet.returns-name", { normative: "A greeting returns the name.", surface: "api:greet" })],
      evidence: evidence("claim-greet", "surface:api:greet", "a".repeat(64)),
      decisions: [decision("ADR-0001", { behavior: "greet.returns-name" })],
    }),
    current: view({
      version: "1.1.0",
      surface: [surfaceItem("greet", { signature: "greet(name, options)" })],
      behaviors: [behavior("greet.returns-name", { normative: "A greeting returns the name, padded.", surface: "api:greet" })],
      evidence: evidence("claim-greet", "surface:api:greet", "b".repeat(64)),
      decisions: [decision("ADR-0001", { behavior: "greet.returns-name" })],
    }),
  };
}

/** The two snapshot maps a preview reads. */
function maps(baseline: SnapshotView, current: SnapshotView, extra: readonly SnapshotView[] = []): {
  readonly baseline: ReadonlyMap<string, SnapshotView>;
  readonly current: ReadonlyMap<string, SnapshotView>;
} {
  const baselineMap = new Map([[baseline.project, baseline]]);
  const currentMap = new Map([[current.project, current]]);
  for (const snapshot of extra) {
    baselineMap.set(snapshot.project, { ...snapshot, snapshot: { ...snapshot.snapshot, version: "0.9.0" } });
    currentMap.set(snapshot.project, snapshot);
  }
  return { baseline: baselineMap, current: currentMap };
}

test("a preview names the downstream snapshots, pages, and tasks before anything is published", () => {
  const { baseline, current } = change();
  const docs = consumer({
    id: "docs",
    consumes: [{ kind: "surface", id: "api:greet", pages: ["guide/install.md"], files: ["src/setup.ts"] }],
    range: ">=1.0.0 <2.0.0",
  });
  const preview = previewPropagation({ manifest: manifest([docs]), ...maps(baseline, current) });
  assert.equal(preview.partial, false);
  assert.ok(preview.events.some((event) => event.ref === "api:greet" && event.kind === "signature"));
  assert.deepEqual(preview.consumers.map((impact) => impact.consumer), ["docs"]);
  const impact = preview.consumers[0]!;
  assert.deepEqual(impact.snapshots, [{ project: "docs", from: "1.0.0", to: "1.1.0" }]);
  assert.ok(impact.pages.includes("guide/install.md"));
  assert.equal(impact.severity, "review");
  assert.equal(impact.action, "review");
  assert.equal(impact.tasks.length, 1);
  assert.match(impact.tasks[0]!, /^[0-9a-f]{64}$/);
  assert.match(impact.reason, /api:greet/);
});

test("a proposal carries scope, acceptance, rationale, decisions, and authorized evidence, and keeps the upstream source untouched", () => {
  const { baseline, current } = change();
  const docs = consumer({
    id: "docs",
    consumes: [
      { kind: "surface", id: "api:greet", pages: ["guide/install.md"], files: ["src/setup.ts"] },
      { kind: "behavior", id: "greet.returns-name" },
    ],
    range: ">=1.0.0 <2.0.0",
    allowEvidence: ["claim-greet"],
    denyEvidence: ["claim-greet->test"],
  });
  const preview = previewPropagation({ manifest: manifest([docs]), ...maps(baseline, current) });
  const impact = preview.consumers[0]!;
  const proposal = proposeTask({ consumer: docs, current, affected: impact.affected, severity: impact.severity, action: impact.action });
  assert.ok(proposal.scope.pages.includes("guide/install.md"));
  assert.ok(proposal.scope.files.includes("src/setup.ts"));
  assert.deepEqual(proposal.acceptance.map((criterion) => criterion.id), ["reflect-change", "review-change"]);
  assert.equal(proposal.acceptance[1]!.review, true);
  assert.match(proposal.rationale, /api:greet/);
  assert.deepEqual(proposal.decisions.map((entry) => entry.id), ["ADR-0001"]);
  assert.ok(proposal.evidence.some((entry) => entry.id === "claim-greet"));
  assert.equal(proposal.withheldEvidence, 1);
  assert.ok(proposal.changes.some((entry) => entry.ref === "api:greet" && entry.hash.length === 64));
  assert.match(proposal.id, /^[0-9a-f]{64}$/);
  // The proposal names the consumer's files and never the upstream record as writable.
  const serialized = JSON.stringify(proposal);
  assert.ok(!serialized.includes("upstream/"));
  assert.equal(proposal.upstream.project, "product");
});

test("a required approval holds a pending receipt and advances only when an accepted approver is named", () => {
  const { baseline, current } = change();
  const gated = consumer({
    id: "docs",
    consumes: [{ kind: "surface", id: "api:greet" }],
    approval: { mode: "required", approvers: ["lead"] },
  });
  const pending = applyPropagation({ manifest: manifest([gated]), ...maps(baseline, current), ledger: emptyLedger() });
  assert.equal(pending.tasks.length, 0);
  assert.equal(pending.receipts.length, 1);
  assert.equal(pending.receipts[0]!.status, "pending-approval");
  assert.equal(pending.receipts[0]!.requiresApproval, true);
  const id = pending.receipts[0]!.id;

  const wrong = applyPropagation({
    manifest: manifest([gated]),
    ...maps(baseline, current),
    ledger: pending.ledger,
    approvals: { docs: ["stranger"] },
  });
  assert.deepEqual(wrong.reused, [id]);
  assert.equal(wrong.tasks.length, 0);

  const approved = applyPropagation({
    manifest: manifest([gated]),
    ...maps(baseline, current),
    ledger: pending.ledger,
    approvals: { docs: ["lead"] },
  });
  assert.deepEqual(approved.created, [id]);
  assert.equal(approved.receipts[0]!.status, "proposed");
  assert.deepEqual(approved.receipts[0]!.approvedBy, ["lead"]);
  assert.equal(approved.tasks.length, 1);
  assert.equal(approved.tasks[0]!.id, approved.receipts[0]!.tasks[0]);
});

test("reprocessing the same snapshots after verification is a no-op and the earlier receipt stays retrievable", () => {
  const { baseline, current } = change();
  const docs = consumer({ id: "docs", consumes: [{ kind: "surface", id: "api:greet" }] });
  const first = applyPropagation({ manifest: manifest([docs]), ...maps(baseline, current), ledger: emptyLedger() });
  assert.equal(first.created.length, 1);
  assert.equal(first.tasks.length, 1);
  const id = first.receipts[0]!.id;

  const second = applyPropagation({ manifest: manifest([docs]), ...maps(baseline, current), ledger: first.ledger });
  assert.deepEqual(second.reused, [id]);
  assert.deepEqual(second.created, []);
  assert.equal(second.tasks.length, 0);
  assert.equal(second.receipts[0]!.id, id);

  const verified = verifyReceipt(first.ledger, id);
  assert.ok(verified);
  assert.equal(verified.receipt.status, "verified");
  assert.equal(verified.unchanged, false);
  const ledger = withVerifiedReceipt(first.ledger, verified.receipt);

  const third = applyPropagation({ manifest: manifest([docs]), ...maps(baseline, current), ledger });
  assert.deepEqual(third.reused, [id]);
  assert.equal(third.tasks.length, 0);
  assert.equal(third.receipts[0]!.status, "verified");
  assert.equal(verifyReceipt(ledger, id)?.unchanged, true);
});

test("an upstream API change flags only the consumers that declared it", () => {
  const { baseline, current } = change();
  const docs = consumer({ id: "docs", consumes: [{ kind: "surface", id: "api:greet" }] });
  const other = consumer({ id: "other", consumes: [{ kind: "surface", id: "api:farewell" }] });
  const preview = previewPropagation({ manifest: manifest([docs, other]), ...maps(baseline, current) });
  assert.deepEqual(preview.consumers.map((impact) => impact.consumer), ["docs"]);
  assert.deepEqual(preview.unaffected, ["other"]);
  const applied = applyPropagation({ manifest: manifest([docs, other]), ...maps(baseline, current), ledger: emptyLedger() });
  assert.deepEqual(applied.receipts.map((receipt) => receipt.consumer), ["docs"]);
  assert.equal(applied.tasks.length, 1);
});

test("a pull-request action prepares one reference and reprocessing creates neither a second task nor a second pull request", () => {
  const { baseline, current } = change();
  const docs = consumer({ id: "docs", consumes: [{ kind: "surface", id: "api:greet" }], onReview: "pull-request" });
  const first = applyPropagation({ manifest: manifest([docs]), ...maps(baseline, current), ledger: emptyLedger() });
  assert.equal(first.receipts[0]!.action, "pull-request");
  assert.equal(first.receipts[0]!.pullRequest, `docs/product/${first.receipts[0]!.id.slice(0, 12)}`);
  const second = applyPropagation({ manifest: manifest([docs]), ...maps(baseline, current), ledger: first.ledger });
  assert.equal(second.tasks.length, 0);
  assert.equal(second.receipts[0]!.pullRequest, first.receipts[0]!.pullRequest);
  assert.equal(second.receipts.length, 1);
});

test("a missing bundle and a private bundle are recorded per consumer while a healthy consumer still applies", () => {
  const { baseline, current } = change();
  const privateView = view({ project: "private", version: "1.1.0", surface: [surfaceItem("secret", { signature: "secret(x)" })], policy: PRIVATE });
  const all = maps(baseline, current, [privateView]);
  const result = applyPropagation({
    manifest: manifest([
      consumer({ id: "docs", project: "product", consumes: [{ kind: "surface", id: "api:greet" }] }),
      consumer({ id: "gone", project: "missing", consumes: [{ kind: "surface", id: "api:x" }] }),
      consumer({ id: "secret", project: "private", consumes: [{ kind: "surface", id: "api:secret" }] }),
    ]),
    ...all,
    ledger: emptyLedger(),
  });
  assert.equal(result.partial, true);
  assert.deepEqual(result.failures.map((failure) => `${failure.consumer}:${failure.kind}`).sort(), ["gone:missing-bundle", "secret:permission"]);
  assert.deepEqual(result.receipts.filter((receipt) => receipt.status !== "failed").map((receipt) => receipt.consumer), ["docs"]);
  const failed = result.receipts.filter((receipt) => receipt.status === "failed");
  assert.deepEqual(failed.map((receipt) => receipt.consumer).sort(), ["gone", "secret"]);
  assert.equal(result.tasks.length, 1);
  // The failed receipts are durable, and a second run finds them instead of writing more.
  const again = applyPropagation({
    manifest: manifest([
      consumer({ id: "docs", project: "product", consumes: [{ kind: "surface", id: "api:greet" }] }),
      consumer({ id: "gone", project: "missing", consumes: [{ kind: "surface", id: "api:x" }] }),
      consumer({ id: "secret", project: "private", consumes: [{ kind: "surface", id: "api:secret" }] }),
    ]),
    ...all,
    ledger: result.ledger,
  });
  assert.equal(again.ledger.receipts.length, result.ledger.receipts.length);
  assert.deepEqual(again.created, []);
  assert.equal(again.tasks.length, 0);
});

test("the CLI validates, diffs, previews, proposes, applies, verifies, and reads the receipt back", async () => {
  const root = mkdtempSync(join(tmpdir(), "propagation-cli-"));
  try {
    writeSnapshot(join(root, "baseline"), bundle({
      version: "1.0.0",
      surface: [surfaceItem("greet", { signature: "greet(name)" })],
      behaviors: [behavior("greet.returns-name", { normative: "A greeting returns the name.", surface: "api:greet" })],
      evidence: evidence("claim-greet", "surface:api:greet", "a".repeat(64)),
    }));
    writeSnapshot(join(root, "current"), bundle({
      version: "1.1.0",
      surface: [surfaceItem("greet", { signature: "greet(name, options)" })],
      behaviors: [behavior("greet.returns-name", { normative: "A greeting returns the name, padded.", surface: "api:greet" })],
      evidence: evidence("claim-greet", "surface:api:greet", "b".repeat(64)),
    }), [decision("ADR-0001", { behavior: "greet.returns-name" })]);
    writeManifest(root, manifest([
      consumer({
        id: "docs",
        consumes: [
          { kind: "surface", id: "api:greet", pages: ["guide/install.md"], files: ["src/setup.ts"] },
          { kind: "behavior", id: "greet.returns-name" },
        ],
        range: ">=1.0.0 <2.0.0",
        approval: { mode: "required", approvers: ["lead"] },
      }),
    ]));
    const logs: string[] = [];
    const errors: string[] = [];
    const io = { log: (message: string) => logs.push(message), error: (message: string) => errors.push(message) };
    const run = async (args: readonly string[]) => {
      logs.length = 0;
      errors.length = 0;
      const status = await runPropagation(args, io);
      return { status, out: logs.join("\n"), err: errors.join("\n") };
    };

    const checked = await run(["check", root, "--json"]);
    assert.equal(checked.status, 0, checked.err);
    assert.equal((JSON.parse(checked.out) as { valid: boolean }).valid, true);

    const invalid = await run(["check", root, "--manifest", join(root, "missing.json")]);
    assert.equal(invalid.status, 1);

    const diffed = await run(["diff", root, "--baseline", join(root, "baseline"), "--current", join(root, "current"), "--json"]);
    assert.equal(diffed.status, 0, diffed.err);
    const diffReport = JSON.parse(diffed.out) as { events: { ref: string; subject: string; source?: { file: string } }[] };
    assert.ok(diffReport.events.some((event) => event.ref === "api:greet" && event.subject === "surface"));
    assert.ok(diffReport.events.some((event) => event.subject === "decision" && event.source?.file === "guide/install.md"));

    const preview = await run(["preview", root, "--baseline", join(root, "baseline"), "--current", join(root, "current"), "--json"]);
    assert.equal(preview.status, 0, preview.err);
    const previewReport = JSON.parse(preview.out) as { consumers: { consumer: string; pages: string[]; tasks: string[] }[] };
    assert.deepEqual(previewReport.consumers.map((impact) => impact.consumer), ["docs"]);
    assert.ok(previewReport.consumers[0]!.pages.includes("guide/install.md"));
    assert.equal(previewReport.consumers[0]!.tasks.length, 1);

    const proposed = await run(["propose", root, "--baseline", join(root, "baseline"), "--current", join(root, "current"), "--json"]);
    assert.equal(proposed.status, 0, proposed.err);
    const proposals = JSON.parse(proposed.out) as { proposals: { decisions: { id: string }[]; evidence: { id: string }[] }[] };
    assert.deepEqual(proposals.proposals[0]!.decisions.map((entry) => entry.id), ["ADR-0001"]);
    assert.ok(proposals.proposals[0]!.evidence.some((entry) => entry.id === "claim-greet"));

    const upstream = readFileSync(join(root, "current", "product.bundle.json"), "utf8");
    const pending = await run(["apply", root, "--baseline", join(root, "baseline"), "--current", join(root, "current"), "--json"]);
    assert.equal(pending.status, 0, pending.err);
    const pendingReport = JSON.parse(pending.out) as { receipts: { id: string; status: string }[]; tasks: unknown[] };
    assert.equal(pendingReport.receipts[0]!.status, "pending-approval");
    assert.equal(pendingReport.tasks.length, 0);
    const id = pendingReport.receipts[0]!.id;

    const applied = await run(["apply", root, "--baseline", join(root, "baseline"), "--current", join(root, "current"), "--approve", "lead", "--json"]);
    assert.equal(applied.status, 0, applied.err);
    const appliedReport = JSON.parse(applied.out) as { receipts: { id: string; status: string }[]; tasks: { id: string }[] };
    assert.equal(appliedReport.receipts[0]!.status, "proposed");
    assert.equal(appliedReport.tasks.length, 1);
    assert.equal(appliedReport.receipts[0]!.id, id);
    assert.equal(readFileSync(join(root, "current", "product.bundle.json"), "utf8"), upstream);

    const read = await run(["receipt", id, root, "--json"]);
    assert.equal(read.status, 0, read.err);
    assert.equal((JSON.parse(read.out) as { status: string }).status, "proposed");

    const verified = await run(["verify", id, root, "--json"]);
    assert.equal(verified.status, 0, verified.err);
    assert.equal((JSON.parse(verified.out) as { receipt: { status: string } }).receipt.status, "verified");
    const ledger = JSON.parse(readFileSync(join(root, ".mizzen", "propagation.json"), "utf8")) as { receipts: { id: string; status: string }[] };
    assert.equal(ledger.receipts[0]!.status, "verified");

    const noop = await run(["apply", root, "--baseline", join(root, "baseline"), "--current", join(root, "current"), "--json"]);
    assert.equal(noop.status, 0, noop.err);
    const noopReport = JSON.parse(noop.out) as { reused: string[]; tasks: unknown[]; receipts: { status: string }[] };
    assert.deepEqual(noopReport.reused, [id]);
    assert.equal(noopReport.tasks.length, 0);
    assert.equal(noopReport.receipts[0]!.status, "verified");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
