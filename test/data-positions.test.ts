import assert from "node:assert/strict";
import { test } from "node:test";
import { isMap, isSeq, parseDocument, LineCounter } from "yaml";
import { fieldPositionsOf, lineIndex, nodePos } from "../src/data/positions.ts";

/** Parses `text` and returns its root node. */
function rootOf(text: string) {
  return parseDocument(text, { lineCounter: new LineCounter() }).contents!;
}

test("block YAML keeps the record and each field's exact span", () => {
  const text = "- slug: button\n  name: Button\n- slug: dialog\n  name: Dialog\n";
  const root = rootOf(text);
  assert.ok(isSeq(root));
  const index = lineIndex(text);
  const first = root.items[0]!;
  assert.deepEqual(nodePos(index, "items.yml", first), {
    file: "items.yml",
    startLine: 1,
    startColumn: 3,
    endLine: 2,
    endColumn: 15,
  });
  assert.deepEqual(fieldPositionsOf(index, "items.yml", first), {
    slug: { file: "items.yml", startLine: 1, startColumn: 9, endLine: 1, endColumn: 14 },
    name: { file: "items.yml", startLine: 2, startColumn: 9, endLine: 2, endColumn: 14 },
  });
});

test("flow YAML keeps the value span inside braces and brackets", () => {
  const text = "{a: 1, b: [x, y]}\n";
  const root = rootOf(text);
  assert.ok(isMap(root));
  const index = lineIndex(text);
  assert.deepEqual(nodePos(index, "flow.yml", root), {
    file: "flow.yml",
    startLine: 1,
    startColumn: 1,
    endLine: 1,
    endColumn: 17,
  });
  assert.deepEqual(fieldPositionsOf(index, "flow.yml", root), {
    a: { file: "flow.yml", startLine: 1, startColumn: 5, endLine: 1, endColumn: 5 },
    b: { file: "flow.yml", startLine: 1, startColumn: 11, endLine: 1, endColumn: 16 },
  });
});

test("JSON positions come from the parser, not from re-serializing", () => {
  const text = '{"a": {"x": 1}}';
  const root = rootOf(text);
  assert.ok(isMap(root));
  const index = lineIndex(text);
  const value = root.items[0]!.value!;
  assert.deepEqual(nodePos(index, "data.json", value), {
    file: "data.json",
    startLine: 1,
    startColumn: 7,
    endLine: 1,
    endColumn: 14,
  });
});

test("a CRLF file counts columns from the content, not from the carriage return", () => {
  const text = "a: 1\r\nb: 2\r\n";
  const root = rootOf(text);
  assert.ok(isMap(root));
  const index = lineIndex(text);
  assert.deepEqual(fieldPositionsOf(index, "crlf.yml", root).b, {
    file: "crlf.yml",
    startLine: 2,
    startColumn: 4,
    endLine: 2,
    endColumn: 4,
  });
});
