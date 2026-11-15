import assert from "node:assert/strict";
import { test } from "node:test";
import type { Diagnostic, DiagnosticFix, RecordPos, SourcePos } from "../src/contracts/index.ts";
import { sliceSpan } from "../src/source/spans.ts";
import { idsOf, loadSite } from "./data-schema-tree.ts";

/** A record position as a diagnostic span. */
function spanOf(pos: RecordPos): SourcePos {
  return {
    file: pos.file,
    line: pos.startLine,
    column: pos.startColumn,
    endLine: pos.endLine,
    endColumn: pos.endColumn,
  };
}

/** The offset of a 1-based line and code-point column in `text`. */
function offsetOf(lines: readonly string[], line: number, column: number): number {
  let offset = 0;
  for (let index = 0; index < line - 1; index++) offset += (lines[index] ?? "").length + 1;
  return offset + [...(lines[line - 1] ?? "")].slice(0, column - 1).join("").length;
}

/** Applies one fix to the text, the way an editor would: replace the named span, change nothing else. */
function applyFix(text: string, fix: DiagnosticFix): string {
  const lines = text.split("\n");
  const start = offsetOf(lines, fix.line, fix.column);
  const end = offsetOf(lines, fix.endLine, fix.endColumn + 1);
  return `${text.slice(0, start)}${fix.text}${text.slice(end)}`;
}

/** Applies many fixes bottom-up, so an earlier replacement never moves a later span. */
function applyFixes(text: string, fixes: readonly DiagnosticFix[]): string {
  return [...fixes]
    .sort((a, b) => b.line - a.line || b.column - a.column)
    .reduce((current, fix) => applyFix(current, fix), text);
}

const schema = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "object", properties, ...extra });

const CONFIG = "collections:\n  items:\n    source: _data/items.yml\n    schema: _data/items.schema.json\n";

/** The findings of a reloaded site that are about a record. */
function invalidRecords(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return diagnostics.filter((diagnostic) => diagnostic.id === "data.record-invalid");
}

test("a near-miss YAML enum replaces the value with a quoted string that stays a string", async () => {
  const source = "- id: one\n  status: stabel\n";
  const files = {
    "mizzen.yml": CONFIG,
    "_data/items.schema.json": schema({ id: { type: "string" }, status: { type: "string", enum: ["stable", "beta"] } }),
    "_data/items.yml": source,
  };
  const first = await loadSite(files);
  const found = invalidRecords(first.diagnostics)[0]!;
  assert.equal(found.help, 'Did you mean "stable"?');
  assert.ok(found.fix, "a safe enum replacement is offered");
  assert.equal(sliceSpan(source, spanOf({ file: "_data/items.yml", startLine: 2, startColumn: 11, endLine: 2, endColumn: 16 })), "stabel");

  const fixed = applyFix(source, found.fix!);
  assert.equal(fixed, '- id: one\n  status: "stable"\n');
  const reloaded = await loadSite({ ...files, "_data/items.yml": fixed });
  assert.deepEqual(idsOf(reloaded), []);
  assert.equal(reloaded.collections["items"]!.records[0]!.fields["status"], "stable");
});

test("YAML enum values that a bare word would retype stay strings after the fix", async () => {
  const source =
    "- id: one\n  status: ture\n- id: two\n  status: flase\n- id: three\n  status: nul\n- id: four\n  status: \"11\"\n";
  const files = {
    "mizzen.yml": CONFIG,
    "_data/items.schema.json": schema({
      id: { type: "string" },
      status: { type: "string", enum: ["true", "false", "null", "1"] },
    }),
    "_data/items.yml": source,
  };
  const first = await loadSite(files);
  const fixes = invalidRecords(first.diagnostics).flatMap((finding) => (finding.fix === undefined ? [] : [finding.fix]));
  assert.equal(fixes.length, 4, "each value has a fix");
  assert.deepEqual(fixes.map((fix) => fix.text), ['"true"', '"false"', '"null"', '"1"']);

  const fixed = applyFixes(source, fixes);
  const reloaded = await loadSite({ ...files, "_data/items.yml": fixed });
  assert.deepEqual(idsOf(reloaded), []);
  assert.deepEqual(
    reloaded.collections["items"]!.records.map((record) => [record.fields["status"], typeof record.fields["status"]]),
    [
      ["true", "string"],
      ["false", "string"],
      ["null", "string"],
      ["1", "string"],
    ],
  );
});

test("a YAML number and boolean written as strings are fixed only because the record validates again", async () => {
  const source = "- id: one\n  count: \"42\"\n- id: two\n  published: \"true\"\n";
  const files = {
    "mizzen.yml": CONFIG,
    "_data/items.schema.json": schema({
      id: { type: "string" },
      count: { type: "integer" },
      published: { type: "boolean" },
    }),
    "_data/items.yml": source,
  };
  const first = await loadSite(files);
  const findings = invalidRecords(first.diagnostics);
  const fixes = findings.flatMap((finding) => (finding.fix === undefined ? [] : [finding.fix]));
  assert.deepEqual(fixes.map((fix) => fix.text), ["42", "true"]);

  const fixed = applyFixes(source, fixes);
  const reloaded = await loadSite({ ...files, "_data/items.yml": fixed });
  assert.deepEqual(idsOf(reloaded), []);
  assert.deepEqual(
    [
      reloaded.collections["items"]!.records[0]!.fields["count"],
      reloaded.collections["items"]!.records[1]!.fields["published"],
    ],
    [42, true],
  );
});

test("a JSON enum keeps its quotes, so the fix neither breaks the file nor changes the value's type", async () => {
  const source = '[{"id":"one","status":"ture"},{"id":"two","status":"nul"},{"id":"three","status":"11"}]';
  const files = {
    "mizzen.yml": "collections:\n  items:\n    source: _data/items.json\n    schema: _data/items.schema.json\n",
    "_data/items.schema.json": schema({
      id: { type: "string" },
      status: { type: "string", enum: ["true", "null", "1"] },
    }),
    "_data/items.json": source,
  };
  const first = await loadSite(files);
  const fixes = invalidRecords(first.diagnostics).flatMap((finding) => (finding.fix === undefined ? [] : [finding.fix]));
  assert.deepEqual(fixes.map((fix) => fix.text), ['"true"', '"null"', '"1"'], "a JSON string replacement is quoted");

  const fixed = applyFixes(source, fixes);
  assert.doesNotThrow(() => JSON.parse(fixed), "the fixed file is still JSON");
  const reloaded = await loadSite({ ...files, "_data/items.json": fixed });
  assert.deepEqual(idsOf(reloaded), []);
  assert.deepEqual(
    reloaded.collections["items"]!.records.map((record) => [record.fields["status"], typeof record.fields["status"]]),
    [
      ["true", "string"],
      ["null", "string"],
      ["1", "string"],
    ],
  );
});

test("a JSON number written as a string is fixed to a number and the record validates", async () => {
  const source = '[{"id":"one","count":"42"}]';
  const files = {
    "mizzen.yml": "collections:\n  items:\n    source: _data/items.json\n    schema: _data/items.schema.json\n",
    "_data/items.schema.json": schema({ id: { type: "string" }, count: { type: "integer" } }),
    "_data/items.json": source,
  };
  const found = invalidRecords((await loadSite(files)).diagnostics)[0]!;
  const fixed = applyFix(source, found.fix!);
  assert.deepEqual(JSON.parse(fixed), [{ id: "one", count: 42 }]);
  const reloaded = await loadSite({ ...files, "_data/items.json": fixed });
  assert.deepEqual(idsOf(reloaded), []);
  assert.equal(reloaded.collections["items"]!.records[0]!.fields["count"], 42);
});

test("a CSV cell is always text, so a number written in it gets prose and no fix", async () => {
  const result = await loadSite({
    "mizzen.yml": "collections:\n  items:\n    source: _data/items.csv\n    schema: _data/items.schema.json\n",
    "_data/items.schema.json": schema({ id: { type: "string" }, count: { type: "integer" } }),
    "_data/items.csv": "id,count\none,42\n",
  });
  const found = invalidRecords(result.diagnostics)[0]!;
  assert.equal("fix" in found, false);
  assert.match(found.help ?? "", /Write the value as an integer\./);
});

test("a conversion is not offered when another field still fails, because the record would not validate", async () => {
  const result = await loadSite({
    "mizzen.yml": CONFIG,
    "_data/items.schema.json": schema({
      id: { type: "string" },
      count: { type: "integer" },
      name: { type: "string" },
    }),
    "_data/items.yml": '- id: one\n  count: "42"\n  name: 5\n',
  });
  const count = invalidRecords(result.diagnostics).find((finding) => finding.message.includes('"count"'))!;
  assert.match(count.help ?? "", /Write the number without quotes: 42\./);
  assert.equal("fix" in count, false, "the record still has a bad name, so the whole record is not proven");
});

test("a near-miss YAML field name is renamed at the key, and the record becomes valid", async () => {
  const source = "- id: one\n  titel: First\n";
  const files = {
    "mizzen.yml": CONFIG,
    "_data/items.schema.json": schema({ id: { type: "string" }, title: { type: "string" } }, { additionalProperties: false }),
    "_data/items.yml": source,
  };
  const found = invalidRecords((await loadSite(files)).diagnostics)[0]!;
  assert.equal(found.help, 'Did you mean "title"?');
  assert.ok(found.fix);
  assert.equal(sliceSpan(source, spanOf({ file: "_data/items.yml", startLine: 2, startColumn: 3, endLine: 2, endColumn: 7 })), "titel");

  const fixed = applyFix(source, found.fix!);
  assert.equal(fixed, "- id: one\n  title: First\n");
  const reloaded = await loadSite({ ...files, "_data/items.yml": fixed });
  assert.deepEqual(idsOf(reloaded), []);
  assert.equal(reloaded.collections["items"]!.records[0]!.fields["title"], "First");
});

test("a near-miss JSON field name is renamed at the quoted key, and the file stays JSON", async () => {
  const source = '[{"id":"one","titel":"First"}]';
  const files = {
    "mizzen.yml": "collections:\n  items:\n    source: _data/items.json\n    schema: _data/items.schema.json\n",
    "_data/items.schema.json": schema({ id: { type: "string" }, title: { type: "string" } }, { additionalProperties: false }),
    "_data/items.json": source,
  };
  const found = invalidRecords((await loadSite(files)).diagnostics)[0]!;
  assert.equal(found.fix?.text, '"title"');
  const fixed = applyFix(source, found.fix!);
  assert.doesNotThrow(() => JSON.parse(fixed));
  assert.deepEqual(JSON.parse(fixed), [{ id: "one", title: "First" }]);
  const reloaded = await loadSite({ ...files, "_data/items.json": fixed });
  assert.deepEqual(idsOf(reloaded), []);
  assert.equal(reloaded.collections["items"]!.records[0]!.fields["title"], "First");
});

test("a near-miss CSV header is renamed once, and every row becomes valid", async () => {
  const source = "id,titel\none,First\ntwo,Second\n";
  const files = {
    "mizzen.yml": "collections:\n  items:\n    source: _data/items.csv\n    schema: _data/items.schema.json\n",
    "_data/items.schema.json": schema({ id: { type: "string" }, title: { type: "string" } }, { additionalProperties: false }),
    "_data/items.csv": source,
  };
  const first = await loadSite(files);
  const findings = invalidRecords(first.diagnostics);
  assert.equal(findings.length, 2, "each row reports the header it inherited");
  const offers = findings.filter((finding) => finding.fix !== undefined);
  assert.equal(offers.length, 1, "the shared header cell is offered once");
  assert.equal(offers[0]!.fix?.line, 1);
  assert.equal(offers[0]!.fix?.column, 4);

  const fixed = applyFix(source, offers[0]!.fix!);
  assert.equal(fixed, "id,title\none,First\ntwo,Second\n");
  const reloaded = await loadSite({ ...files, "_data/items.csv": fixed });
  assert.deepEqual(idsOf(reloaded), []);
  assert.deepEqual(reloaded.collections["items"]!.records.map((record) => record.fields["title"]), ["First", "Second"]);
});

test("a missing root field states type and example, while a nested one gets no suggestion", async () => {
  const root = await loadSite({
    "mizzen.yml": CONFIG,
    "_data/items.schema.json": schema({ title: { type: "string" } }, { required: ["title"] }),
    "_data/items.yml": "- id: one\n",
  });
  assert.equal(invalidRecords(root.diagnostics)[0]!.help, 'Add a "title" field (a string), such as `title: Example`.');

  const nested = await loadSite({
    "mizzen.yml": CONFIG,
    "_data/items.schema.json": JSON.stringify({
      type: "object",
      properties: {
        id: { type: "string" },
        author: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      },
    }),
    "_data/items.yml": "- id: one\n  author: {}\n",
  });
  const found = invalidRecords(nested.diagnostics)[0]!;
  assert.match(found.message, /Field "author\.name" of record "one" in "items" is required\./);
  assert.equal("help" in found, false, "the root schema cannot name a nested field's type, so nothing is suggested");
  assert.equal("fix" in found, false);
});

test("a finding with no safe suggestion carries neither help nor fix", async () => {
  const result = await loadSite({
    "mizzen.yml": CONFIG,
    "_data/items.schema.json": schema({ id: { type: "string" }, code: { type: "string", pattern: "^[0-9]+$" } }),
    "_data/items.yml": "- id: one\n  code: abc\n",
  });
  const found = invalidRecords(result.diagnostics)[0]!;
  assert.equal("help" in found, false);
  assert.equal("fix" in found, false);
});

test("a nested unknown field is named but never renamed with the parent's span", async () => {
  const source = "- id: one\n  author:\n    titel: First\n";
  const result = await loadSite({
    "mizzen.yml": CONFIG,
    "_data/items.schema.json": JSON.stringify({
      type: "object",
      properties: {
        id: { type: "string" },
        author: {
          type: "object",
          properties: { title: { type: "string" } },
          additionalProperties: false,
        },
      },
    }),
    "_data/items.yml": source,
  });
  const found = invalidRecords(result.diagnostics)[0]!;
  assert.match(found.message, /Field "author\.titel" of record "one" in "items"/);
  assert.equal("fix" in found, false, "the root key is not the field that needs renaming");
  assert.equal("help" in found, false);
});
