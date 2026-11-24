import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuthoringSurfaceItem } from "../src/contracts/authoring.ts";
import { defaultPurpose, recommendPageType } from "../src/authoring/type.ts";

/** One surface item for a rule test. */
function item(kind: AuthoringSurfaceItem["kind"], name: string): AuthoringSurfaceItem {
  return {
    id: `${kind}:${name}`,
    area: kind === "command" ? "cli" : "api",
    kind,
    name,
    stability: "stable",
    source: { file: "src/index.ts", line: 1, column: 1, endLine: 1, endColumn: 1 },
    introduced: "0.2.7",
  };
}

test("#1408 a lookup surface recommends a reference and records the rule", () => {
  const choice = recommendPageType(item("symbol", "parseWidget"), "undocumented");
  assert.equal(choice.kind, "reference");
  assert.equal(choice.purpose, "lookup");
  assert.deepEqual(choice.rules, ["surface.lookup-kind", "purpose.derived", "page-type.lookup"]);
  assert.match(choice.reason, /symbol:parseWidget/);
  assert.match(choice.reason, /a reader looks this item up by name/);
  assert.match(choice.reason, /reference page is recommended/);
});

test("#1408 an operational command recommends a runbook", () => {
  const derived = defaultPurpose(item("command", "build"), "undocumented");
  assert.equal(derived.purpose, "operate");
  const choice = recommendPageType(item("command", "build"), "undocumented");
  assert.equal(choice.kind, "runbook");
  assert.deepEqual(choice.rules, ["surface.command", "command.operational", "purpose.derived", "page-type.operate"]);
});

test("#1408 an explicit purpose wins and is recorded", () => {
  const demonstrate = recommendPageType(item("command", "build"), "undocumented", "demonstrate");
  assert.equal(demonstrate.kind, "example");
  assert.equal(demonstrate.purpose, "demonstrate");
  assert.deepEqual(demonstrate.rules, ["surface.command", "command.operational", "purpose.explicit", "page-type.demonstrate"]);
});

test("#1408 a partial gap recommends a guide", () => {
  const choice = recommendPageType(item("symbol", "parseWidget"), "partial");
  assert.equal(choice.kind, "guide");
  assert.equal(choice.purpose, "describe");
  assert.deepEqual(choice.rules, ["gap.partial", "purpose.derived", "page-type.describe"]);
  assert.match(choice.reason, /needs the item explained in context/);
});
