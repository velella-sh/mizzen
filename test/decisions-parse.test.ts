/**
 * #1357, #1358, #1360, and #1362: reading versioned decision records, capturing rationale and rejected alternatives,
 * linking to surfaces and behaviors, and citing evidence.
 *
 * A record names an id, title, status, explicit date, and source; a file missing one is refused at the exact key. The
 * body's named sections are extracted with their original text and span. A link to a page or collection the build does
 * not have is reported, and a citation that cannot be resolved stays `unknown`.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { loadDecisions } from "../src/decisions/load.ts";
import { parseDecision } from "../src/decisions/parse.ts";
import { buildModel } from "../src/model/build.ts";

/** A temporary site holding `files`. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "decisions-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const span = { file: "ADR.md", line: 2, column: 1, endLine: 2, endColumn: 5 };

const COMPLETE = `---
id: ADR-0001
title: Use Redis for the cache
status: accepted
date: 2025-03-02
source:
  value: https://example.test/rfcs/2
  public: true
supersedes: []
behaviors: [cache-hit]
pages: [guide/caching.md]
public: true
---

## Context

One answer across workers.

## Decision

Cache in Redis.

## Rationale

Workers shared no memory.

## Alternatives

- **In-memory map** — rejected because each worker answered differently.
- **Sticky sessions** — rejected because the balancer cannot pin a client.
`;

test("#1357 a complete record is read with its five required fields", () => {
  const parsed = parseDecision(COMPLETE, { file: "ADR.md" });
  assert.deepEqual(parsed.diagnostics, []);
  const record = parsed.record!;
  assert.equal(record.id, "ADR-0001");
  assert.equal(record.title, "Use Redis for the cache");
  assert.equal(record.status, "accepted");
  assert.equal(record.date, "2025-03-02");
  assert.equal(record.source.value, "https://example.test/rfcs/2");
  // The span points at the `id` key, not the whole file.
  assert.equal(record.span.line, 2);
});

test("#1357 an incomplete record is refused with a located diagnostic per missing key", () => {
  const noStatus = `---\nid: ADR-0002\ntitle: No status\ndate: 2025-01-01\nsource: x\n---\n\n## Decision\nDo it.\n`;
  const parsed = parseDecision(noStatus, { file: "ADR.md" });
  assert.equal(parsed.record, undefined);
  const missing = parsed.diagnostics.find((diagnostic) => diagnostic.id === "decision.missing-status");
  assert.ok(missing, JSON.stringify(parsed.diagnostics));
  assert.equal(missing?.severity, "error");
  assert.equal(missing?.pos?.file, "ADR.md");
  assert.ok((missing?.pos?.line ?? 0) >= 1);

  const noFrontMatter = parseDecision("# Just a heading\n", { file: "ADR.md" });
  assert.equal(noFrontMatter.record, undefined);
  assert.ok(noFrontMatter.diagnostics.some((diagnostic) => diagnostic.id === "decision.no-front-matter"));
});

test("#1357 a status outside the five, and a date that is not a real day, are refused", () => {
  const badStatus = parseDecision(COMPLETE.replace("status: accepted", "status: maybe"), { file: "ADR.md" });
  assert.ok(badStatus.diagnostics.some((diagnostic) => diagnostic.id === "decision.invalid-status"));
  const badDate = parseDecision(COMPLETE.replace("date: 2025-03-02", "date: 2025-13-40"), { file: "ADR.md" });
  assert.ok(badDate.diagnostics.some((diagnostic) => diagnostic.id === "decision.invalid-date"));
});

test("#1358 context, decision, rationale, and rejected alternatives are structured with the original text", () => {
  const record = parseDecision(COMPLETE, { file: "ADR.md" }).record!;
  assert.equal(record.context?.text, "One answer across workers.");
  assert.equal(record.decision?.text, "Cache in Redis.");
  assert.equal(record.rationale?.text, "Workers shared no memory.");
  assert.equal(record.alternatives.length, 2);
  assert.equal(record.alternatives[0]?.name, "In-memory map");
  assert.match(record.alternatives[0]?.rejectedBecause?.text ?? "", /each worker answered differently/);
  // The text keeps its span, so a citation points at the bytes the author wrote.
  assert.equal(record.rationale?.span.line, 23);
});

test("#1360 a decision names affected pages and behaviors by stable id", () => {
  const record = parseDecision(COMPLETE, { file: "ADR.md" }).record!;
  const ids = record.links.map((link) => `${link.kind}:${link.id}`);
  assert.deepEqual(ids, ["behavior:cache-hit", "page:guide/caching.md"]);
});

test("#1362 evidence is recorded and an unresolved reference stays unknown", () => {
  const withEvidence = COMPLETE.replace(
    "supersedes: []",
    "supersedes: []\ncommits: [abc1234]\ntests: [test/decisions-parse.test.ts]\npullRequests: [https://example.test/pr/1]",
  );
  const record = parseDecision(withEvidence, { file: "ADR.md" }).record!;
  const byKind = new Map(record.evidence.map((entry) => [entry.kind, entry]));
  assert.equal(byKind.get("commit")?.status, "resolved");
  assert.equal(byKind.get("test")?.status, "resolved");
  // A pull-request address cannot be proven by the parser, so it stays unknown rather than assumed.
  assert.equal(byKind.get("pull-request")?.status, "unknown");
});

test("#1360 a link to a page or collection the site lacks is reported, and its edge is not drawn", async () => {
  const root = tree({
    "mizzen.yml": "title: T\ndecisions:\n  dir: docs/decisions\n",
    "index.md": "# Home\n",
    "docs/decisions/0001.md": COMPLETE.replace("pages: [guide/caching.md]", "pages: [guide/missing.md]\ncollections: [nope]"),
  });
  try {
    const { site, diagnostics } = await buildModel(root);
    // The build reports the unresolved links it read.
    assert.ok(diagnostics.some((diagnostic) => diagnostic.id === "decision.link-unresolved"));
    const loaded = await loadDecisions({ root, site, dir: "docs/decisions" });
    const record = loaded.records.find((candidate) => candidate.id === "ADR-0001")!;
    const page = record.links.find((link) => link.kind === "page")!;
    const collection = record.links.find((link) => link.kind === "collection")!;
    assert.equal(page.resolved, false);
    assert.equal(collection.resolved, false);
    assert.ok(loaded.diagnostics.some((diagnostic) => diagnostic.id === "decision.link-unresolved"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1357 a record carries its source span for a citation", () => {
  const record = parseDecision(COMPLETE, { file: "docs/decisions/0001.md" }).record!;
  assert.equal(record.span.file, "docs/decisions/0001.md");
  assert.ok(record.span.line >= 1);
  void span;
});

test("#1357 a site without a decisions folder has none and the build reports nothing", async () => {
  const root = tree({ "mizzen.yml": "title: T\n", "index.md": "# Home\n" });
  try {
    const { site } = await buildModel(root);
    const loaded = await loadDecisions({ root, site, dir: "docs/decisions" });
    assert.equal(loaded.found, false);
    assert.deepEqual(loaded.records, []);
    assert.equal(site.decisions, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1357 an invalid record in a site is a located diagnostic, not a decision", async () => {
  const root = tree({
    "mizzen.yml": "title: T\ndecisions:\n  dir: docs/decisions\n",
    "index.md": "# Home\n",
    "docs/decisions/0001.md": "---\nid: ADR-1\ntitle: T\nstatus: maybe\ndate: 2025-01-01\nsource: x\n---\n\n## Decision\nDo it.\n",
  });
  try {
    const { site, diagnostics } = await buildModel(root);
    const error = diagnostics.find((diagnostic) => diagnostic.id === "decision.invalid-status");
    assert.ok(error, JSON.stringify(diagnostics));
    assert.equal(error?.pos?.file, "docs/decisions/0001.md");
    assert.equal(site.decisions, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
