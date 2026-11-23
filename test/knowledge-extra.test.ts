/**
 * Extra coverage for the knowledge modules' error branches and the record subject path, exercised through the public
 * parser, the report, and the graph builder. These are the paths an invalid author input and a record declaration take.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { parseKnowledge, reviewOf, scopeCovers } from "../src/knowledge/parse.ts";
import { publicDeclarationOf, REDACTED_CITATION } from "../src/knowledge/public.ts";
import { knowledgeReportOf } from "../src/knowledge/report.ts";
import { buildGraph } from "../src/graph/build.ts";
import { collectGraphInput } from "../src/graph/collect.ts";
import { buildModel } from "../src/model/build.ts";

/** A temporary site holding `files`. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "knowledge-extra-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const span = { file: "a.md", line: 2, column: 1, endLine: 2, endColumn: 1 };

test("every invalid declaration value is refused with its own code", () => {
  const cases: [unknown, string][] = [
    [{ scope: "platform:windows" }, "knowledge.invalid-scope"],
    [{ scope: ["nonsense"] }, "knowledge.invalid-scope"],
    [{ scope: [{ kind: "platform", value: "" }] }, "knowledge.invalid-scope"],
    [{ rationale: 3 }, "knowledge.invalid-rationale"],
    [{ citation: "" }, "knowledge.invalid-citation"],
    [{ citation: { value: "" } }, "knowledge.invalid-citation"],
    [{ expires: "2026-02-30" }, "knowledge.invalid-expires"],
    [{ expires: "soon" }, "knowledge.invalid-expires"],
    [{ evidence: "  " }, "knowledge.invalid-evidence"],
    [{ public: "yes" }, "knowledge.invalid-public"],
  ];
  for (const [value, code] of cases) {
    const parsed = parseKnowledge(value, { file: "a.md", span });
    assert.ok(parsed.diagnostics.some((diagnostic) => diagnostic.id === code), `${JSON.stringify(value)} -> ${code}`);
  }
});

test("a scope entry may be written as kind:value or as an object", () => {
  const parsed = parseKnowledge(
    { status: "unknown", scope: ["surface:install", { kind: "version", value: "v2" }] },
    { file: "a.md", span },
  );
  assert.deepEqual(parsed.declaration?.scope, [
    { kind: "surface", value: "install" },
    { kind: "version", value: "v2" },
  ]);
});

test("a citation may be a string or an object with public", () => {
  const asString = parseKnowledge({ status: "unknown", citation: "https://example.test" }, { file: "a.md", span });
  assert.deepEqual(asString.declaration?.citation, { value: "https://example.test" });
  const asObject = parseKnowledge({ status: "unknown", citation: { value: "https://example.test", public: true } }, { file: "a.md", span });
  assert.deepEqual(asObject.declaration?.citation, { value: "https://example.test", public: true });
});

test("scopeCovers answers a query only within the declaration's limits", () => {
  assert.equal(scopeCovers([], [{ kind: "platform", value: "linux" }]), true, "an unlimited declaration covers anything");
  assert.equal(scopeCovers([{ kind: "platform", value: "windows" }], undefined), false, "a query with no scope is not covered");
  assert.equal(scopeCovers([{ kind: "platform", value: "windows" }], [{ kind: "platform", value: "windows" }]), true);
  assert.equal(scopeCovers([{ kind: "platform", value: "windows" }], [{ kind: "platform", value: "linux" }]), false);
});

test("reviewOf reports an expiry and a changed evidence value, and nothing when neither applies", () => {
  const base = { status: "unknown" as const, scope: [], span, expires: "2026-01-01", evidence: "old" };
  assert.deepEqual(reviewOf(base, { asOf: "2025-12-31", evidence: "old" }).reasons, []);
  assert.deepEqual(reviewOf(base, { asOf: "2026-06-01", evidence: "new" }).reasons, ["expired", "evidence-changed"]);
  assert.equal(reviewOf(base, {}).required, false, "no as-of date and no current evidence means nothing to review");
});

test("publicDeclarationOf publishes a string citation privately as its placeholder", () => {
  const parsed = parseKnowledge({ status: "unverified", citation: "https://secret.test" }, { file: "a.md", span });
  assert.ok(parsed.declaration);
  const published = publicDeclarationOf(parsed.declaration, { required: false, reasons: [] });
  assert.equal(published.citation, REDACTED_CITATION);
  assert.equal(published.redacted, true);
});

test("a record's knowledge reaches the graph on its node and its field claims", async () => {
  const root = tree({
    "mizzen.yml": "title: T\ncollections:\n  parts:\n    source: _data/parts.yml\n    knowledge: know\n",
    "_data/parts.yml": "- id: p1\n  name: Part\n  know:\n    status: unverified\n    citation:\n      value: https://docs.test/p1\n      public: true\n",
  });
  try {
    const { site } = await buildModel(root);
    const { graph } = buildGraph(await collectGraphInput({ root, site }));
    const record = graph.nodes.find((node) => node.id === "record:parts/p1");
    assert.equal(record?.knowledge?.status, "unverified");
    assert.deepEqual(record?.knowledge?.citations, ["https://docs.test/p1"]);
    const claim = graph.nodes.find((node) => node.id === "claim:parts/p1/name");
    assert.equal(claim?.knowledge?.status, "unverified", "the field claim carries the record's limitation");

    const report = knowledgeReportOf(site);
    assert.equal(report.counts.unverified, 1);
    assert.equal(report.counts.missing, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a knowledge entry for a node the snapshot does not hold is a warning, not a crash", async () => {
  const root = tree({ "mizzen.yml": "title: T\n", "a.md": "---\ntitle: A\n---\n\n# A\n" });
  try {
    const { site } = await buildModel(root);
    const input = await collectGraphInput({ root, site });
    const { diagnostics } = buildGraph({ ...input, knowledge: [{ node: "page:ghost.md", status: "unknown", scope: [] }] });
    assert.ok(diagnostics.some((problem) => problem.code === "graph.knowledge-unknown-node" && problem.severity === "warning"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the graph builder's knowledge output is order-independent", async () => {
  const root = tree({ "mizzen.yml": "title: T\n", "a.md": "---\ntitle: A\nknowledge:\n  status: unknown\n---\n\n# A\n" });
  try {
    const { site } = await buildModel(root);
    const input = await collectGraphInput({ root, site });
    const first = buildGraph(input).graph.snapshot.id;
    const second = buildGraph({ ...input, knowledge: [...(input.knowledge ?? [])].reverse() }).graph.snapshot.id;
    assert.equal(first, second);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
