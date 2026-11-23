/**
 * #1367 and #1368: the knowledge status taxonomy and its declaration in Markdown and collections.
 *
 * The five statuses have distinct meanings and distinct schema values, and a subject that declares nothing is
 * `missing`, which is not one of them. A declaration is read from page front matter and a collection field, keeps its
 * exact source span, and is refused at its span when a value is invalid.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import { KNOWLEDGE_STATUSES, parseKnowledge } from "../src/knowledge/parse.ts";
import { knowledgeReportOf } from "../src/knowledge/report.ts";
import { buildModel } from "../src/model/build.ts";

const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;
const statusSchema = createRequire(import.meta.url)("../schema/knowledge-status.schema.json") as object;
const reportSchema = JSON.parse(
  (await import("node:fs")).readFileSync(new URL("../schema/knowledge-report.schema.json", import.meta.url), "utf8"),
) as object;

/** A temporary site holding `files`. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "knowledge-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const span = { file: "a.md", line: 2, column: 1, endLine: 6, endColumn: 1 };

test("#1367 the five statuses are distinct schema values and missing is not one of them", () => {
  assert.deepEqual([...KNOWLEDGE_STATUSES], ["unknown", "unsupported", "unverified", "not-applicable", "out-of-scope"]);
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(statusSchema);
  for (const status of KNOWLEDGE_STATUSES) {
    assert.equal(validate({ status }), true, status);
  }
  for (const bad of ["missing", "unknowns", "verified", "", "UNKNOWN"]) {
    assert.equal(validate({ status: bad }), false, bad);
  }
  // A value with no status is read as `unknown`, never as the absent sentinel `missing`.
  const parsed = parseKnowledge({ rationale: "no status written" }, { file: "a.md", span });
  assert.deepEqual(parsed.diagnostics, []);
  assert.equal(parsed.declaration?.status, "unknown");
});

test("#1367 an absent declaration is missing, kept apart from every status", async () => {
  const root = tree({
    "mizzen.yml": "title: T\n",
    "a.md": "---\ntitle: A\n---\n\n# A\n",
    "b.md": "---\ntitle: B\nknowledge:\n  status: not-applicable\n---\n\n# B\n",
  });
  try {
    const { site } = await buildModel(root);
    const report = knowledgeReportOf(site);
    assert.equal(report.entries.find((entry) => entry.subject.id === "a.md")?.declaration, undefined);
    assert.equal(report.counts.missing, 1);
    assert.equal(report.counts["not-applicable"], 1);
    assert.equal(report.counts.unknown, 0);
    const gap = report.gaps.find((entry) => entry.subject.id === "a.md");
    assert.equal(gap?.kind, "documentation-gap");
    assert.equal(gap?.status, "missing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1368 a page declaration keeps its exact source span and scope", async () => {
  const root = tree({
    "mizzen.yml": "title: T\n",
    "a.md": "---\ntitle: A\nknowledge:\n  status: unknown\n  scope: [platform:windows, version:v2]\n  rationale: Because the vendor never said.\n  public: true\n---\n\n# A\n",
  });
  try {
    const { site } = await buildModel(root);
    const page = site.pages.find((candidate) => candidate.source.file === "a.md");
    assert.equal(page?.knowledge?.status, "unknown");
    assert.deepEqual(page?.knowledge?.scope, [
      { kind: "platform", value: "windows" },
      { kind: "version", value: "v2" },
    ]);
    // The span begins at the `knowledge` key, not the whole file.
    assert.equal(page?.knowledge?.span.line, 3);
    assert.equal(page?.knowledge?.span.column, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1368 an invalid status is refused at the declaration's span", async () => {
  const root = tree({
    "mizzen.yml": "title: T\n",
    "a.md": "---\ntitle: A\nknowledge:\n  status: maybe\n---\n\n# A\n",
  });
  try {
    const { site, diagnostics } = await buildModel(root);
    const error = diagnostics.find((diagnostic) => diagnostic.id === "page.knowledge.invalid-status");
    assert.ok(error, "an invalid status is reported");
    assert.equal(error?.severity, "error");
    assert.equal(error?.pos?.file, "a.md");
    assert.ok((error?.pos?.line ?? 0) >= 3, "the diagnostic points at the knowledge key");
    assert.equal(site.pages.find((page) => page.source.file === "a.md")?.knowledge, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1368 a collection field declares knowledge and is refused when invalid", async () => {
  const root = tree({
    "mizzen.yml": "title: T\ncollections:\n  items:\n    source: _data/items.yml\n    knowledge: know\n",
    "_data/items.yml": "- id: one\n  title: One\n  know:\n    status: unverified\n    rationale: Unconfirmed by anyone.\n- id: two\n  title: Two\n  know:\n    status: bogus\n",
  });
  try {
    const { site, diagnostics } = await buildModel(root);
    const items = site.collections.items;
    assert.ok(items, "the collection is loaded");
    assert.equal(items.records.find((record) => record.id === "one")?.knowledge?.status, "unverified");
    // The raw field is dropped, so no output can publish it.
    assert.equal(Object.hasOwn(items.records.find((record) => record.id === "one")!.fields, "know"), false);
    assert.ok(diagnostics.some((diagnostic) => diagnostic.id === "collection.items.knowledge.invalid-status"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1367 and #1368 the report conforms to its schema and carries no private value", async () => {
  const root = tree({
    "mizzen.yml": "title: T\n",
    "a.md": "---\ntitle: A\nknowledge:\n  status: unknown\n  rationale: private-only-898\n  citation: https://secret.example/898\n---\n\n# A\n",
  });
  try {
    const { site } = await buildModel(root);
    const report = knowledgeReportOf(site);
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(reportSchema);
    assert.equal(validate(report), true, JSON.stringify(validate.errors));
    const text = JSON.stringify(report);
    assert.doesNotMatch(text, /private-only-898|secret\.example/);
    assert.match(text, /\[rationale withheld\]/);
    assert.match(text, /\[citation withheld\]/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
