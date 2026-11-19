import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeExampleOutput, verifyExample } from "../src/verification/examples.ts";
import { verificationTask } from "./verification-fixture.ts";

const SPAN = { line: 3, column: 1, endLine: 3, endColumn: 20 };

test("a broken sample fails with its source span, and the corrected run passes under the same check", async () => {
  const task = verificationTask([{ id: "example", statement: "The install example prints 2.", check: "test" }]);
  const broken = await verifyExample({
    id: "install-example",
    task: task.id,
    snapshot: task.snapshot.id,
    commit: "abc1234",
    file: "docs/install.md",
    span: SPAN,
    lang: "js",
    code: "console.log(1 + 1);\n",
    expected: "3\n",
  });
  assert.equal(broken.passed, false);
  assert.equal(broken.check.status, "failed");
  assert.deepEqual(broken.check.span, { ...SPAN, file: "docs/install.md" });
  assert.match(broken.check.detail ?? "", /different output/u);
  assert.equal(broken.check.task, task.id);
  assert.equal(broken.check.commit, "abc1234");

  const fixed = await verifyExample({
    id: "install-example",
    task: task.id,
    snapshot: task.snapshot.id,
    commit: "abc1234",
    file: "docs/install.md",
    span: SPAN,
    lang: "js",
    code: "console.log(1 + 1);\n",
    expected: "2\n",
  });
  assert.equal(fixed.passed, true);
  assert.equal(fixed.check.status, "passed");
  assert.equal(fixed.check.id, broken.check.id);
  assert.equal(fixed.check.span, undefined);
  assert.equal(fixed.check.limits.network, "deny");
  assert.notEqual(fixed.check.expectedHash, broken.check.expectedHash);
});

test("example output comparison normalizes line endings and trailing spaces", () => {
  assert.equal(normalizeExampleOutput("a\r\nb  \r\n"), "a\nb");
  assert.equal(normalizeExampleOutput("a\nb\n"), "a\nb");
});

test("a sample that runs too long is a timed-out check with its span", async () => {
  const task = verificationTask([{ id: "example", statement: "The example finishes.", check: "test" }]);
  const result = await verifyExample({
    id: "slow",
    task: task.id,
    snapshot: task.snapshot.id,
    commit: "abc1234",
    file: "docs/slow.md",
    span: SPAN,
    lang: "js",
    code: "for (;;) {}\n",
    expected: "",
    timeoutMs: 50,
  });
  assert.equal(result.check.status, "timed-out");
  assert.deepEqual(result.check.span, { ...SPAN, file: "docs/slow.md" });
  assert.equal(result.check.limits.timeoutMs, 50);
});
