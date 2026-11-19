import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runTwoAgentDemo } from "../src/coordination/demo.ts";

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/coordination/two-agent.json", import.meta.url), "utf8"),
) as unknown;

test("two agents edit a guide and an example in parallel and merge to the serial result", () => {
  const demo = runTwoAgentDemo();
  assert.deepEqual(demo, fixture);
  assert.equal(demo.match, true);
  assert.deepEqual(demo.parallel.files, demo.serial.files);
  assert.equal(demo.order.length, 2);
});

test("the deliberate conflict is rejected before the second writer starts", () => {
  const demo = runTwoAgentDemo();
  assert.equal(demo.conflict.blocked, true);
  assert.equal(demo.conflict.code, "coordination.scope-overlap");
  assert.equal(demo.conflict.subtasks.length, 2);
  assert.match(demo.conflict.message, /both write page "guide\/install"/);
});

test("the demo is byte-identical on a second run", () => {
  assert.deepEqual(runTwoAgentDemo(), runTwoAgentDemo());
});
