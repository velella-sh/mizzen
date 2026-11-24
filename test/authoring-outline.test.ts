import assert from "node:assert/strict";
import { test } from "node:test";
import { sectionsNeedingEvidence } from "../src/authoring/outline.ts";
import { cleanup, copyFixture, onlyTask, tasksOf } from "./authoring-fixture.ts";

test("#1409 the outline includes behavior, prerequisites, an example, limitations, and references", async () => {
  const root = copyFixture();
  try {
    const { tasks } = await tasksOf(root, { items: ["symbol:parseWidget"] });
    const task = onlyTask(tasks);
    assert.deepEqual(task.outline.map((section) => section.kind), [
      "behavior",
      "prerequisites",
      "example",
      "limitations",
      "references",
    ]);
    const behavior = task.outline[0]!;
    assert.equal(behavior.needsEvidence, false, "a verified behavior contract supplies the behavior section");
    assert.ok(behavior.points.includes("parseWidget requires a non-empty name and returns its lowercase id."));
    assert.deepEqual(behavior.evidence.map((entry) => entry.ref), ["parseWidget.returns-id"]);
    const prerequisites = task.outline[1]!;
    assert.match(prerequisites.points[0] ?? "", /package is installed/);
    const example = task.outline[2]!;
    assert.equal(example.needsEvidence, false);
    assert.ok(example.evidence.some((entry) => entry.kind === "test" && entry.ref === "tests/parse-widget.test.mjs"));
    const references = task.outline[4]!;
    assert.ok(references.points.some((point) => point.includes("src/index.ts:6:17-6:27")));
    assert.ok(references.evidence.some((entry) => entry.kind === "surface" && entry.ref === "symbol:parseWidget"));
    assert.deepEqual(sectionsNeedingEvidence(task.outline), []);
  } finally {
    cleanup(root);
  }
});

test("#1409 sections with no evidence say what still has to be established", async () => {
  const root = copyFixture();
  try {
    const { tasks } = await tasksOf(root, { items: ["symbol:orphanApi"] });
    const task = onlyTask(tasks, "symbol:orphanApi");
    assert.deepEqual(task.outline.map((section) => section.kind), [
      "behavior",
      "prerequisites",
      "example",
      "limitations",
      "references",
    ]);
    const needs = sectionsNeedingEvidence(task.outline).map((section) => section.kind);
    assert.deepEqual(needs, ["behavior", "example", "limitations"]);
    assert.match(task.outline[0]?.needsEvidenceReason ?? "", /No behavior contract links/);
    assert.match(task.outline[2]?.needsEvidenceReason ?? "", /No test or example is linked/);
    assert.ok(task.outline[3]?.points.some((point) => point.includes("No behavior contract links")));
  } finally {
    cleanup(root);
  }
});
