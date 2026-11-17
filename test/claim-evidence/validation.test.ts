import assert from "node:assert/strict";
import { test } from "node:test";
import { isMap, isSeq, parseDocument, type Node } from "yaml";
import type { DataRecord, Diagnostic } from "../../src/contracts/index.ts";
import { validateEvidence } from "../../src/data/evidence/validate.ts";
import { fieldPositionsOf, keyText, lineIndex, mappingPairs, nodePos } from "../../src/data/positions.ts";

const FILE = "_data/findings.yml";

/** A record parsed from a one-record YAML fixture, with its evidence node and every finding. */
function check(text: string, field = "claims") {
  const document = parseDocument(text);
  assert.deepEqual(document.errors, []);
  const root = document.contents as Node;
  const item = (isSeq(root) ? root.items[0] : root) as Node;
  assert.ok(isMap(item));
  const index = lineIndex(text);
  const value = document.toJS() as Record<string, unknown> | Record<string, unknown>[];
  const fields = Array.isArray(value) ? value[0]! : value;
  const pair = mappingPairs(item).find((entry) => keyText(entry) === field);
  const record: DataRecord = {
    id: String(fields["id"]),
    fields,
    position: nodePos(index, FILE, item),
    fieldPositions: fieldPositionsOf(index, FILE, item),
  };
  const diagnostics: Diagnostic[] = [];
  const claims = validateEvidence("findings", record, field, pair?.value as Node | undefined, index, diagnostics);
  return { claims, diagnostics, record };
}

test("a record without evidence settings is valid and unchanged", () => {
  const absent = check("- id: one\n  eol: 2025-04-30\n");
  assert.deepEqual(absent.claims, {});
  assert.deepEqual(absent.diagnostics, []);

  const empty = check("- id: one\n  eol: 2025-04-30\n  claims: {}\n");
  assert.deepEqual(empty.claims, {});
  assert.deepEqual(empty.diagnostics, []);

  const emptyList = check("- id: one\n  eol: 2025-04-30\n  claims:\n    eol: []\n");
  assert.deepEqual(emptyList.claims, {});
  assert.deepEqual(emptyList.diagnostics, []);
});

test("sound claims keep only id, title, and url in record field order", () => {
  const { claims, diagnostics, record } = check(
    "- id: ebb-node-18\n" +
      "  statement: Node 18 reaches end of life.\n" +
      "  eol: 2025-04-30\n" +
      "  openWorkflows: 1204\n" +
      "  claims:\n" +
      "    openWorkflows:\n" +
      "      id: workflow-inventory\n" +
      "      title: Workflow inventory, 2026-03-01\n" +
      "      url: https://offing.example.org/runs/2026-03-01/workflows.json\n" +
      "      note: Counted by scripts/inventory.ts; not published.\n" +
      "    eol:\n" +
      "      - id: node-18-schedule\n" +
      "        title: Node.js release schedule\n" +
      "        url: https://nodejs.org/en/about/previous-releases#release-schedule\n" +
      "      - id: node-18-announcement\n" +
      "        title: Node.js 18 release announcement\n" +
      "        url: /findings/node-18\n",
  );

  assert.deepEqual(diagnostics, []);
  assert.deepEqual(Object.keys(claims), ["eol", "openWorkflows"]);
  assert.deepEqual(claims["eol"], [
    {
      id: "node-18-schedule",
      title: "Node.js release schedule",
      url: "https://nodejs.org/en/about/previous-releases#release-schedule",
    },
    {
      id: "node-18-announcement",
      title: "Node.js 18 release announcement",
      url: "/findings/node-18",
    },
  ]);
  assert.deepEqual(claims["openWorkflows"], [
    { id: "workflow-inventory", title: "Workflow inventory, 2026-03-01", url: "https://offing.example.org/runs/2026-03-01/workflows.json" },
  ]);
  assert.equal("note" in claims["openWorkflows"]![0]!, false);
  // The private note and the raw evidence mapping stay in the data file; validation only reads them.
  assert.equal((record.fields["claims"] as { openWorkflows: { note: string } }).openWorkflows.note, "Counted by scripts/inventory.ts; not published.");
});

test("a key that names no top-level field is reported at its key", () => {
  const { claims, diagnostics } = check(
    "- id: one\n  statement: Node.\n  eol: 2025-04-30\n  claims:\n    missing:\n      id: source\n      title: Source\n      url: https://example.com\n",
  );

  assert.deepEqual(claims, {});
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]!.id, "data.evidence-field");
  assert.deepEqual(diagnostics[0]!.pos, { file: FILE, line: 5, column: 5, endLine: 5, endColumn: 11 });
});

test("an evidence field or entry with the wrong shape is reported at its value", () => {
  const field = check("- id: one\n  eol: 2025-04-30\n  claims: nope\n");
  assert.deepEqual(field.claims, {});
  assert.equal(field.diagnostics.length, 1);
  assert.equal(field.diagnostics[0]!.id, "data.evidence-shape");
  assert.deepEqual(field.diagnostics[0]!.pos, { file: FILE, line: 3, column: 11, endLine: 3, endColumn: 14 });

  const entry = check("- id: one\n  eol: 2025-04-30\n  claims:\n    eol: nope\n");
  assert.deepEqual(entry.claims, {});
  assert.equal(entry.diagnostics.length, 1);
  assert.equal(entry.diagnostics[0]!.id, "data.evidence-shape");
  assert.deepEqual(entry.diagnostics[0]!.pos, { file: FILE, line: 4, column: 10, endLine: 4, endColumn: 13 });

  const item = check("- id: one\n  eol: 2025-04-30\n  claims:\n    eol:\n      - nope\n");
  assert.deepEqual(item.claims, {});
  assert.equal(item.diagnostics.length, 1);
  assert.equal(item.diagnostics[0]!.id, "data.evidence-claim");
});

test("a claim without an id or title is reported and left out", () => {
  const { claims, diagnostics } = check(
    "- id: one\n" +
      "  eol: 2025-04-30\n" +
      "  claims:\n" +
      "    eol:\n" +
      '      - title: ""\n' +
      "        url: https://example.com\n" +
      "      - id: sound\n" +
      "        title: Sound\n" +
      "        url: https://example.com/sound\n",
  );

  assert.equal(diagnostics.length, 2);
  assert.deepEqual(
    diagnostics.map((entry) => entry.id),
    ["data.evidence-claim", "data.evidence-claim"],
  );
  assert.deepEqual(diagnostics[0]!.pos, { file: FILE, line: 5, column: 9, endLine: 6, endColumn: 33 });
  assert.deepEqual(diagnostics[1]!.pos, { file: FILE, line: 5, column: 16, endLine: 5, endColumn: 17 });
  assert.deepEqual(claims, { eol: [{ id: "sound", title: "Sound", url: "https://example.com/sound" }] });
});

test("only an absolute https url or a root-relative path is allowed", () => {
  const fixture = (url: string) =>
    `- id: one\n  eol: 2025-04-30\n  claims:\n    eol:\n      id: source\n      title: Source\n      url: ${url}\n`;

  for (const url of ["http://example.com", "javascript:alert(1)", "data:text/plain,x", "file:///tmp/x", "//example.com/x", "reports/x"]) {
    const { claims, diagnostics } = check(fixture(url));
    assert.deepEqual(claims, {}, url);
    assert.equal(diagnostics.length, 1, url);
    assert.equal(diagnostics[0]!.id, "data.evidence-url", url);
  }

  for (const url of ["https://example.com/a", "/reports/2026-03.json"]) {
    const { claims, diagnostics } = check(fixture(url));
    assert.deepEqual(diagnostics, [], url);
    assert.equal(claims["eol"]?.[0]?.url, url);
  }
});

test("a disallowed url points at the url value", () => {
  const { diagnostics } = check(
    "- id: one\n" +
      "  eol: 2025-04-30\n" +
      "  claims:\n" +
      "    eol:\n" +
      "      - id: source\n" +
      "        title: Source\n" +
      "        url: http://example.com\n",
  );

  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]!.id, "data.evidence-url");
  assert.deepEqual(diagnostics[0]!.pos, { file: FILE, line: 7, column: 14, endLine: 7, endColumn: 31 });
  assert.match(diagnostics[0]!.message, /disallowed url "http:\/\/example\.com"/);
});

test("a repeated id is reported at the later id, and ids may repeat across fields", () => {
  const { claims, diagnostics } = check(
    "- id: one\n" +
      "  eol: 2025-04-30\n" +
      "  openWorkflows: 1204\n" +
      "  claims:\n" +
      "    eol:\n" +
      "      - id: same\n" +
      "        title: First\n" +
      "        url: https://example.com/first\n" +
      "      - id: same\n" +
      "        title: Second\n" +
      "        url: https://example.com/second\n" +
      "    openWorkflows:\n" +
      "      id: same\n" +
      "      title: Other field\n" +
      "      url: https://example.com/other\n",
  );

  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]!.id, "data.evidence-duplicate-id");
  assert.deepEqual(diagnostics[0]!.pos, { file: FILE, line: 9, column: 13, endLine: 9, endColumn: 16 });
  assert.match(diagnostics[0]!.message, /first used at _data\/findings\.yml:6:13/);
  assert.deepEqual(claims["eol"], [{ id: "same", title: "First", url: "https://example.com/first" }]);
  assert.deepEqual(claims["openWorkflows"], [{ id: "same", title: "Other field", url: "https://example.com/other" }]);
});
