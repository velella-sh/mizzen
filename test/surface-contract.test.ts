import assert from "node:assert/strict";
import { test } from "node:test";
import type { SurfaceAdapterResult, SurfaceItem } from "../src/contracts/surface.ts";
import {
  adapterResultProblems,
  itemId,
  sortItems,
  SurfaceContractError,
  validateAdapterResult,
} from "../src/surface/contract.ts";

const source = { file: "src/index.ts", line: 3, column: 1, endLine: 3, endColumn: 10 };

function item(overrides: Partial<SurfaceItem> = {}): SurfaceItem {
  return {
    id: itemId("symbol", "buildSite"),
    area: "api",
    kind: "symbol",
    name: "buildSite",
    source,
    stability: "stable",
    ...overrides,
  };
}

function result(overrides: Partial<SurfaceAdapterResult> = {}): SurfaceAdapterResult {
  return { version: 1, area: "api", items: [item()], findings: [], ...overrides };
}

test("a well-formed adapter result validates and keeps every item", () => {
  const value = result();
  const validated = validateAdapterResult(value);
  assert.equal(validated.items.length, 1);
  assert.equal(validated.items[0]?.id, "symbol:buildSite");
  assert.deepEqual(adapterResultProblems(value), []);
});

test("a wrong version, area, or item shape rejects the whole result with every problem", () => {
  const problems = adapterResultProblems({
    version: 2,
    area: "nope",
    items: [item({ id: "" }), { ...item(), stability: "beta" }, { ...item(), source: { file: "a.ts", line: 0, column: 1, endLine: 1, endColumn: 1 } }],
    findings: [],
  });
  const codes = new Set(problems.map((problem) => problem.code));
  assert.ok(codes.has("surface.unsupported-version"));
  assert.ok(codes.has("surface.invalid-area"));
  assert.ok(codes.has("surface.invalid-item"));
  assert.ok(codes.has("surface.invalid-span"));
});

test("a duplicate id is refused, so a match is never ambiguous", () => {
  const problems = adapterResultProblems(result({ items: [item(), item()] }));
  assert.ok(problems.some((problem) => problem.code === "surface.duplicate-id"));
});

test("invalid adapters are never returned partially: validation throws with the problems", () => {
  assert.throws(
    () => validateAdapterResult({ version: 1, area: "api", items: [item(), { ...item(), id: "" }], findings: [] }),
    (error: unknown) => {
      assert.ok(error instanceof SurfaceContractError);
      assert.ok(error.problems.length > 0);
      return true;
    },
  );
});

test("an item without a version is accepted, and one with a version must name its introduction", () => {
  assert.deepEqual(adapterResultProblems(result()), []);
  const missing = adapterResultProblems(result({ items: [item({ version: { introduced: "" } })] }));
  assert.ok(missing.some((problem) => problem.code === "surface.invalid-version"));
});

test("items sort by area then id, and the id is `<kind>:<name>`", () => {
  const sorted = sortItems([
    item({ id: itemId("command", "build"), area: "cli", kind: "command", name: "build" }),
    item({ id: itemId("symbol", "a"), area: "api", name: "a" }),
    item({ id: itemId("symbol", "b"), area: "api", name: "b" }),
  ]);
  assert.deepEqual(sorted.map((entry) => entry.id), ["symbol:a", "symbol:b", "command:build"]);
  assert.equal(itemId("config-key", "title"), "config-key:title");
});

test("a non-object result, a non-list items or findings, and a bad optional field are each refused", () => {
  assert.ok(adapterResultProblems(null).some((problem) => problem.code === "surface.invalid-result"));
  assert.ok(adapterResultProblems("nope").some((problem) => problem.code === "surface.invalid-result"));
  assert.ok(adapterResultProblems({ version: 1, area: "api", items: "x", findings: [] }).some((problem) => problem.code === "surface.invalid-result"));
  assert.ok(adapterResultProblems({ version: 1, area: "api", items: [], findings: 3 }).some((problem) => problem.code === "surface.invalid-result"));
  const badOptional = adapterResultProblems(result({ items: [item({ signature: 5 as never, parent: "" as never, source: { file: "", line: 1, column: 1, endLine: 1, endColumn: 1 } })] }));
  const codes = new Set(badOptional.map((problem) => problem.code));
  assert.ok(codes.has("surface.invalid-item"));
  assert.ok(codes.has("surface.invalid-span"));
  const nonObject = adapterResultProblems({ version: 1, area: "api", items: [null], findings: [] });
  assert.ok(nonObject.some((problem) => problem.code === "surface.invalid-item"));
});

test("a span whose end is before its start is refused, and one that ends on the same point is fine", () => {
  const backwards = adapterResultProblems(result({ items: [item({ source: { file: "a.ts", line: 5, column: 1, endLine: 3, endColumn: 1 } })] }));
  assert.ok(backwards.some((problem) => problem.code === "surface.invalid-span"));
  const point = adapterResultProblems(result({ items: [item({ source: { file: "a.ts", line: 5, column: 1, endLine: 5, endColumn: 1 } })] }));
  assert.deepEqual(point, []);
});
