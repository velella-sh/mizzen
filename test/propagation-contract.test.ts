/**
 * The propagation contract: consumer manifests, semantic diffing, matching, severity, evidence authorization, and the
 * partial results one missing or unreadable snapshot produces. Each test names the public input it drives and the
 * stable behavior it proves, so a release scope entry can point at it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import type { SemanticChange, SnapshotView } from "../src/contracts/propagation.ts";
import { compareChanges, stableHash } from "../src/propagation/contract.ts";
import { diffSnapshots } from "../src/propagation/diff.ts";
import { parsePropagationManifest } from "../src/propagation/manifest.ts";
import { matchChanges } from "../src/propagation/match.ts";
import { authorizedEvidence } from "../src/propagation/propose.ts";
import { applyPropagation, previewPropagation } from "../src/propagation/run.ts";
import { emptyLedger } from "../src/propagation/receipt.ts";
import { acceptsVersion, severityFor } from "../src/propagation/severity.ts";
import {
  PUBLIC,
  PRIVATE,
  behavior,
  bundle,
  consumer,
  decision,
  evidence,
  manifest,
  surfaceItem,
  view,
} from "./propagation-fixture.ts";

/** A valid manifest describing one consumer of `api:greet`. */
function validManifest(): unknown {
  return {
    version: 1,
    consumers: [
      consumer({
        id: "docs",
        consumes: [{ kind: "surface", id: "api:greet", pages: ["guide/install.md"], files: ["setup.ts"] }],
        range: ">=1.0.0 <2.0.0",
        approval: { mode: "required", approvers: ["docs-lead"] },
        allowEvidence: ["claim-greet"],
      }),
    ],
  };
}

test("a valid consumer manifest names dependencies, a version policy, and an evidence policy", () => {
  const parsed = parsePropagationManifest(validManifest());
  assert.deepEqual(parsed.problems, []);
  assert.equal(parsed.manifest?.consumers.length, 1);
  const docs = parsed.manifest!.consumers[0]!;
  assert.equal(docs.project, "product");
  assert.equal(docs.policy.range, ">=1.0.0 <2.0.0");
  assert.equal(docs.policy.channel, "compatible");
  assert.deepEqual(docs.evidence, { allow: ["claim-greet"], deny: [] });
  assert.deepEqual(docs.consumes[0], { kind: "surface", id: "api:greet", pages: ["guide/install.md"], files: ["setup.ts"] });
});

test("an invalid dependency kind, page, file, or version range is refused at its own path", () => {
  const unknownKind = parsePropagationManifest({
    version: 1,
    consumers: [{ id: "docs", project: "product", policy: {}, approval: { mode: "automatic", approvers: [] }, consumes: [{ kind: "widget", id: "x" }] }],
  });
  assert.ok(unknownKind.problems.some((problem) => problem.path === "/consumers/0/consumes/0/kind"));

  const escapingPage = parsePropagationManifest({
    version: 1,
    consumers: [{ id: "docs", project: "product", policy: {}, approval: { mode: "automatic", approvers: [] }, consumes: [{ kind: "page", id: "../outside.md" }] }],
  });
  assert.ok(escapingPage.problems.some((problem) => problem.path === "/consumers/0/consumes/0/id"));

  const nonMarkdownPage = parsePropagationManifest({
    version: 1,
    consumers: [{ id: "docs", project: "product", policy: {}, approval: { mode: "automatic", approvers: [] }, consumes: [{ kind: "page", id: "guide/install.txt" }] }],
  });
  assert.ok(nonMarkdownPage.problems.some((problem) => problem.path === "/consumers/0/consumes/0/id"));

  const badRange = parsePropagationManifest({
    version: 1,
    consumers: [{ id: "docs", project: "product", policy: { range: "not a range", channel: "compatible" }, approval: { mode: "automatic", approvers: [] }, consumes: [{ kind: "surface", id: "api:greet" }] }],
  });
  assert.ok(badRange.problems.some((problem) => problem.path === "/consumers/0/policy/range"));

  const compatibleWithoutRange = parsePropagationManifest({
    version: 1,
    consumers: [{ id: "docs", project: "product", policy: { channel: "compatible" }, approval: { mode: "automatic", approvers: [] }, consumes: [{ kind: "surface", id: "api:greet" }] }],
  });
  assert.ok(compatibleWithoutRange.problems.some((problem) => problem.code === "propagation.invalid-policy"));
});

test("a duplicate consumer or dependency is refused", () => {
  const duplicateConsumer = parsePropagationManifest({
    version: 1,
    consumers: [
      { id: "docs", project: "product", policy: {}, approval: { mode: "automatic", approvers: [] }, consumes: [{ kind: "surface", id: "api:greet" }] },
      { id: "docs", project: "product", policy: {}, approval: { mode: "automatic", approvers: [] }, consumes: [{ kind: "surface", id: "api:other" }] },
    ],
  });
  assert.ok(duplicateConsumer.problems.some((problem) => problem.code === "propagation.duplicate-consumer"));

  const duplicateDependency = parsePropagationManifest({
    version: 1,
    consumers: [{
      id: "docs",
      project: "product",
      policy: {},
      approval: { mode: "automatic", approvers: [] },
      consumes: [{ kind: "surface", id: "api:greet" }, { kind: "surface", id: "api:greet" }],
    }],
  });
  assert.ok(duplicateDependency.problems.some((problem) => problem.code === "propagation.duplicate-dependency"));
});

test("diffing two snapshots emits versioned events with source and hash for every public change", () => {
  const baseline = view({
    version: "1.0.0",
    surface: [surfaceItem("greet", { signature: "greet(name)" })],
    behaviors: [behavior("greet.returns-name", { status: "supported", surface: "api:greet" })],
    evidence: evidence("claim-greet", "surface:api:greet", "a".repeat(64)),
    decisions: [decision("ADR-0001", { status: "accepted", behavior: "greet.returns-name" })],
  });
  const current = view({
    version: "1.1.0",
    surface: [surfaceItem("greet", { signature: "greet(name, options)" }), surfaceItem("farewell")],
    behaviors: [behavior("greet.returns-name", { status: "deprecated", surface: "api:greet" })],
    evidence: evidence("claim-greet", "surface:api:greet", "b".repeat(64)),
    decisions: [decision("ADR-0001", { status: "superseded", behavior: "greet.returns-name" })],
  });
  const changes = diffSnapshots(baseline, current);
  assert.ok(changes.every((change) => change.version === 1 && change.project === "product" && change.external === true));
  const surface = changes.filter((change) => change.subject === "surface");
  assert.ok(surface.some((change) => change.kind === "signature" && change.ref === "api:greet"));
  assert.ok(surface.some((change) => change.kind === "added" && change.ref === "api:farewell"));
  assert.ok(surface.every((change) => change.hash.length === 64 && change.source?.file === "guide/install.md"));
  assert.ok(changes.some((change) => change.subject === "behavior" && change.kind === "status" && change.ref === "behavior:greet.returns-name"));
  assert.ok(changes.some((change) => change.subject === "decision" && change.kind === "status" && change.ref === "decision:ADR-0001"));
  assert.ok(changes.some((change) => change.subject === "evidence" && change.kind === "digest" && change.ref === "evidence:claim-greet->test"));
  const again = diffSnapshots(baseline, current);
  assert.deepEqual(again, changes);
  assert.deepEqual([...changes].sort(compareChanges), changes);
});

test("an internal change that preserves the public surface emits no external event", () => {
  const baseline = view({ version: "1.0.0", surface: [surfaceItem("greet")], behaviors: [behavior("greet.returns-name")] });
  const current: SnapshotView = {
    ...baseline,
    snapshot: { id: "snap-1.0.1", version: "1.0.1" },
    graph: {
      ...baseline.graph,
      nodes: baseline.graph.nodes.map((node) => ({ ...node, label: `${node.label} edited` })),
    },
  };
  assert.deepEqual(diffSnapshots(baseline, current), []);
});

test("matching selects only consumers whose declared dependency changed", () => {
  const baseline = view({ version: "1.0.0", surface: [surfaceItem("greet"), surfaceItem("farewell")] });
  const current = view({ version: "1.1.0", surface: [surfaceItem("greet", { signature: "greet(name, options)" }), surfaceItem("farewell")] });
  const changes = diffSnapshots(baseline, current);
  const docs = consumer({ id: "docs", consumes: [{ kind: "surface", id: "api:greet" }] });
  const other = consumer({ id: "other", consumes: [{ kind: "surface", id: "api:farewell" }] });
  const unaffected = consumer({ id: "unaffected", consumes: [{ kind: "behavior", id: "greet.returns-name" }] });
  assert.ok(matchChanges(docs, changes, current.snapshot.version).length > 0);
  assert.deepEqual(matchChanges(other, changes, current.snapshot.version), []);
  assert.deepEqual(matchChanges(unaffected, changes, current.snapshot.version), []);
});

test("a page dependency matches a change whose behavior page it names", () => {
  const baseline = view({ version: "1.0.0", behaviors: [behavior("install.runs", { normative: "Install runs." })] });
  const current = view({ version: "1.1.0", behaviors: [behavior("install.runs", { normative: "Install runs offline." })] });
  const changes = diffSnapshots(baseline, current);
  const page = consumer({ id: "guide", consumes: [{ kind: "page", id: "guide/install.md" }] });
  const affected = matchChanges(page, changes, current.snapshot.version);
  assert.equal(affected.length, 1);
  assert.equal(affected[0]!.change.kind, "signature");
});

test("severity follows the shape of the change and the consumer's version range", () => {
  const removal: SemanticChange = {
    version: 1,
    project: "product",
    subject: "surface",
    kind: "removed",
    ref: "api:greet",
    record: "api:greet",
    hash: "a".repeat(64),
    external: true,
  };
  const addition: SemanticChange = { ...removal, kind: "added" };
  const signature: SemanticChange = { ...removal, kind: "signature" };
  const accepted = { range: ">=1.0.0 <2.0.0", channel: "compatible" as const };
  assert.equal(severityFor(removal, accepted, "1.5.0"), "breaking");
  assert.equal(severityFor(addition, accepted, "1.5.0"), "compatible");
  assert.equal(severityFor(signature, accepted, "1.5.0"), "review");
  assert.equal(severityFor(addition, accepted, "2.0.0"), "breaking");
  assert.equal(acceptsVersion(accepted, "1.5.0"), true);
  assert.equal(acceptsVersion(accepted, "2.0.0"), false);
  assert.equal(acceptsVersion({}, "9.9.9"), true);
});

test("evidence is carried only when the consumer's policy authorizes it", () => {
  const current = view({
    version: "1.1.0",
    surface: [surfaceItem("greet", { signature: "greet(name, options)" })],
    evidence: evidence("claim-greet", "surface:api:greet", "a".repeat(64)),
  });
  const baseline = view({ version: "1.0.0", surface: [surfaceItem("greet", { signature: "greet(name)" })] });
  const changes = diffSnapshots(baseline, current);
  const allowed = authorizedEvidence(current, changes, { allow: ["*"], deny: [] });
  assert.equal(allowed.withheld, 0);
  assert.ok(allowed.evidence.some((entry) => entry.id === "claim-greet"));
  const denied = authorizedEvidence(current, changes, { allow: ["*"], deny: ["*"] });
  assert.equal(denied.withheld, 2);
  assert.deepEqual(denied.evidence, []);
  const partial = authorizedEvidence(current, changes, { allow: ["claim-greet"], deny: ["claim-greet"] });
  assert.equal(partial.withheld, 2);
  assert.deepEqual(partial.evidence, []);
});

test("a missing bundle and a private bundle are recorded per consumer while other results survive", () => {
  const baseline = new Map<string, SnapshotView>([
    ["product", view({ version: "1.0.0", surface: [surfaceItem("greet", { signature: "greet(name)" })] })],
    ["private", view({ project: "private", version: "1.0.0", surface: [surfaceItem("secret")], policy: PRIVATE })],
  ]);
  const current = new Map<string, SnapshotView>([
    ["product", view({ version: "1.1.0", surface: [surfaceItem("greet", { signature: "greet(name, options)" })] })],
    ["private", view({ project: "private", version: "1.1.0", surface: [surfaceItem("secret", { signature: "secret(x)" })], policy: PRIVATE })],
  ]);
  const preview = previewPropagation({
    manifest: manifest([
      consumer({ id: "docs", project: "product", consumes: [{ kind: "surface", id: "api:greet" }] }),
      consumer({ id: "gone", project: "missing", consumes: [{ kind: "surface", id: "api:x" }] }),
      consumer({ id: "secret", project: "private", consumes: [{ kind: "surface", id: "api:secret" }] }),
    ]),
    baseline,
    current,
  });
  assert.equal(preview.partial, true);
  assert.deepEqual(preview.consumers.map((impact) => impact.consumer), ["docs"]);
  assert.deepEqual(
    preview.failures.map((failure) => `${failure.consumer}:${failure.kind}`).sort(),
    ["gone:missing-bundle", "secret:permission"],
  );
  assert.equal(stableHash(preview).length, 64);
  assert.equal(PUBLIC.public, true);
  assert.equal(bundle({ version: "1.0.0" }).project, "product");
});

const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;

test("the committed schemas accept a valid manifest and a receipt ledger and refuse an invalid dependency", () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const schema = (name: string): Record<string, unknown> =>
    JSON.parse(readFileSync(fileURLToPath(new URL(`../schema/${name}`, import.meta.url)), "utf8")) as Record<string, unknown>;
  const validateManifest = ajv.compile(schema("propagation-manifest.schema.json"));
  const validateLedger = ajv.compile(schema("propagation-ledger.schema.json"));

  assert.equal(validateManifest(validManifest()), true, ajv.errorsText(validateManifest.errors));
  assert.equal(
    validateManifest({
      version: 1,
      consumers: [{ id: "docs", project: "product", policy: {}, approval: { mode: "automatic", approvers: [] }, consumes: [{ kind: "widget", id: "x" }] }],
    }),
    false,
  );

  const baseline = view({ version: "1.0.0", surface: [surfaceItem("greet", { signature: "greet(name)" })] });
  const current = view({ version: "1.1.0", surface: [surfaceItem("greet", { signature: "greet(name, options)" })] });
  const docs = consumer({ id: "docs", consumes: [{ kind: "surface", id: "api:greet" }] });
  const result = applyPropagation({
    manifest: manifest([docs]),
    baseline: new Map([[baseline.project, baseline]]),
    current: new Map([[current.project, current]]),
    ledger: emptyLedger(),
  });
  assert.equal(validateLedger(result.ledger), true, ajv.errorsText(validateLedger.errors));
});

test("every public record shape emits its own event", () => {
  const baseline = view({
    version: "1.0.0",
    surface: [
      surfaceItem("one"),
      surfaceItem("two"),
      surfaceItem("three", { parent: "command:build" }),
      surfaceItem("four"),
      surfaceItem("five", { area: "cli", kind: "command" }),
    ],
    behaviors: [behavior("a"), behavior("b"), behavior("c"), behavior("d")],
    decisions: [decision("ADR-1"), decision("ADR-2"), decision("ADR-3"), decision("ADR-4"), decision("ADR-5")],
    evidence: {
      version: 1,
      claims: [
        { id: "c1", subject: "surface:api:one", evidence: ["t1"] },
        { id: "c2", subject: "surface:api:four", evidence: [] },
      ],
      links: [
        { from: "c1", to: "t1", kind: "backs", digest: "a".repeat(64) },
        { from: "c2", to: "t2", kind: "backs", digest: "c".repeat(64) },
      ],
    },
  });
  const current = view({
    version: "1.1.0",
    surface: [
      surfaceItem("one", { signature: "one(x)" }),
      surfaceItem("two", { stability: "deprecated" }),
      surfaceItem("three"),
      surfaceItem("five", { area: "config", kind: "flag" }),
      surfaceItem("six"),
    ],
    behaviors: [
      { ...behavior("a"), status: "deprecated", versions: { introduced: "1.0.0", deprecated: "1.1.0" }, replacement: "b" },
      {
        ...behavior("b"),
        tests: [{ file: "test/b.test.ts", outcome: "passed", state: "found", digest: "a".repeat(64) }],
        evidence: [{ kind: "ci", state: "resolved", digest: "b".repeat(64) }],
        verification: { status: "unverified", reasons: ["missing-evidence"], required: { tests: 1, evidence: 1, kinds: ["ci"] } },
      },
      { ...behavior("c"), environments: [{ os: "linux" }] },
    ],
    decisions: [
      decision("ADR-1", { status: "superseded" }),
      decision("ADR-2", { links: [{ kind: "page", id: "guide/other.md", raw: "page:guide/other.md" }] }),
      { ...decision("ADR-3"), evidence: [{ kind: "test", value: "test/x.test.ts", status: "resolved" }] },
      { ...decision("ADR-4"), validity: { from: "2" }, audience: ["internal"] },
      decision("ADR-6"),
    ],
    evidence: {
      version: 1,
      claims: [
        { id: "c1", subject: "surface:api:two", evidence: ["t1"] },
        { id: "c3", subject: "surface:api:six", evidence: [] },
      ],
      links: [
        { from: "c1", to: "t1", kind: "backs", digest: "b".repeat(64) },
        { from: "c3", to: "t3", kind: "backs", digest: "d".repeat(64) },
      ],
    },
  });
  const keys = new Set(diffSnapshots(baseline, current).map((change) => `${change.subject}|${change.kind}|${change.ref}`));
  for (const key of [
    "surface|added|api:six",
    "surface|removed|api:four",
    "surface|signature|api:one",
    "surface|status|api:two",
    "surface|link|api:three",
    "surface|scope|api:five",
    "behavior|added|behavior:d",
    "behavior|removed|behavior:d",
    "behavior|status|behavior:a",
    "behavior|link|behavior:a",
    "behavior|digest|behavior:b",
    "behavior|scope|behavior:c",
    "decision|added|decision:ADR-6",
    "decision|removed|decision:ADR-5",
    "decision|status|decision:ADR-1",
    "decision|link|decision:ADR-2",
    "decision|digest|decision:ADR-3",
    "decision|scope|decision:ADR-4",
    "evidence|added|evidence:c3",
    "evidence|removed|evidence:c2",
    "evidence|link|evidence:c1",
    "evidence|digest|evidence:c1->t1",
    "evidence|added|evidence:c3->t3",
    "evidence|removed|evidence:c2->t2",
  ]) {
    if (key === "behavior|added|behavior:d") {
      assert.ok(!keys.has(key), "an unchanged behavior is not added");
      continue;
    }
    assert.ok(keys.has(key), `missing ${key}`);
  }
});

test("a malformed manifest is refused whole with every problem located", () => {
  const cases: readonly [unknown, string][] = [
    [null, ""],
    [{ version: 2, consumers: [] }, "/version"],
    [{ version: 1, consumers: [null] }, "/consumers/0"],
    [{ version: 1, consumers: [{ id: "Bad", project: "", namespace: "Bad", policy: null, approval: null, consumes: "x" }] }, "/consumers/0/id"],
    [{ version: 1, consumers: [{ id: "docs", project: "product", policy: { onCompatible: "maybe" }, approval: { mode: "manual", approvers: ["a"] }, consumes: [{ kind: "surface", id: "api:greet" }] }] }, "/consumers/0/policy/onCompatible"],
    [{ version: 1, consumers: [{ id: "docs", project: "product", policy: {}, approval: { mode: "automatic", approvers: "a" }, consumes: [{ kind: "surface", id: "api:greet" }] }] }, "/consumers/0/approval/approvers"],
    [{ version: 1, consumers: [{ id: "docs", project: "product", policy: {}, approval: { mode: "automatic", approvers: [] }, evidence: "x", consumes: [{ kind: "surface", id: "api:greet" }] }] }, "/consumers/0/evidence"],
    [{ version: 1, consumers: [{ id: "docs", project: "product", policy: {}, approval: { mode: "automatic", approvers: [] }, consumes: [] }] }, "/consumers/0/consumes"],
    [{ version: 1, consumers: [{ id: "docs", project: "product", policy: {}, approval: { mode: "automatic", approvers: [] }, consumes: [null] }] }, "/consumers/0/consumes/0"],
    [{ version: 1, consumers: [{ id: "docs", project: "product", policy: {}, approval: { mode: "automatic", approvers: [] }, consumes: [{ kind: "surface", id: "  " }] }] }, "/consumers/0/consumes/0/id"],
    [{ version: 1, consumers: [{ id: "docs", project: "product", policy: {}, approval: { mode: "automatic", approvers: [] }, consumes: [{ kind: "surface", id: "api:greet", pages: "guide.md" }] }] }, "/consumers/0/consumes/0/pages"],
    [{ version: 1, consumers: [{ id: "docs", project: "product", policy: {}, approval: { mode: "automatic", approvers: [] }, consumes: [{ kind: "surface", id: "api:greet", files: ["../out.ts"] }] }] }, "/consumers/0/consumes/0/files/0"],
    [{ version: 1, consumers: [{ id: "docs", project: "product", policy: { channel: "compatible" }, approval: { mode: "automatic", approvers: [] }, consumes: [{ kind: "surface", id: "api:greet" }] }] }, "/consumers/0/policy/range"],
  ];
  for (const [value, path] of cases) {
    const parsed = parsePropagationManifest(value);
    assert.ok(parsed.manifest === undefined, `accepted ${JSON.stringify(value)}`);
    assert.ok(parsed.problems.some((problem) => problem.path === path), `${JSON.stringify(value)}: ${parsed.problems.map((problem) => problem.path).join(", ")}`);
  }
});
