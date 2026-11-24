import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { cleanup, copyFixture, onlyTask, reportOf, tasksOf } from "./authoring-fixture.ts";

const ITEM = "symbol:parseWidget";

test("#1407 a gap becomes one authoring task with its surface, version, and required evidence", async () => {
  const root = copyFixture();
  try {
    const { tasks } = await tasksOf(root, { items: [ITEM] });
    assert.equal(tasks.tasks.length, 1, "one gap makes one task");
    assert.deepEqual(tasks.skipped, []);
    const task = onlyTask(tasks);
    assert.equal(task.item, ITEM);
    assert.equal(task.surface.id, ITEM);
    assert.equal(task.surface.name, "parseWidget");
    assert.equal(task.surface.introduced, "0.2.7");
    assert.equal(task.surface.source.file, "src/index.ts");
    assert.equal(task.surface.source.line, 6);
    assert.equal(task.gap, "undocumented");
    assert.equal(task.task.state, "draft");
    assert.equal(task.task.idempotencyKey, `authoring:${ITEM}:${task.task.snapshot.id}`);
    assert.equal(task.task.snapshot.tooling.length, 64, "the tooling hash is a SHA-256");
    assert.deepEqual(task.task.acceptance.map((criterion) => criterion.check), [
      "authoring-citations",
      "authoring-examples",
      "authoring-behaviors",
      "authoring-links",
      "authoring-coverage",
      "authoring-build",
    ]);
    const kinds = new Set(task.requiredEvidence.map((entry) => entry.kind));
    for (const kind of ["surface", "behavior", "test", "evidence", "source"]) {
      assert.ok(kinds.has(kind as never), `required evidence includes ${kind}`);
    }
    assert.ok(task.requiredEvidence.some((entry) => entry.ref === ITEM));
    assert.ok(task.requiredEvidence.some((entry) => entry.ref === "parseWidget.returns-id"));
    assert.ok(task.requiredEvidence.some((entry) => entry.ref === "src/index.ts:6"));
    assert.deepEqual(task.conflicts, []);
  } finally {
    cleanup(root);
  }
});

test("#1407 a documented exclusion produces no task and keeps the author's reason", async () => {
  const root = copyFixture();
  try {
    writeFileSync(
      join(root, "mizzen.yml"),
      [
        "title: Authoring fixture",
        "url: https://example.org",
        "theme:",
        "  name: theme",
        "surface:",
        "  package: src/index.ts",
        "  docs: [docs]",
        "  exclude:",
        `    - id: ${ITEM}`,
        "      reason: Internal during the preview.",
        "",
      ].join("\n"),
    );
    const { report } = await reportOf(root);
    assert.ok(!report.gaps.some((gap) => gap.item === ITEM), "an exclusion is not a gap");
    const { tasks } = await tasksOf(root, { items: [ITEM] });
    assert.deepEqual(tasks.tasks, []);
    assert.equal(tasks.skipped.length, 1);
    assert.equal(tasks.skipped[0]?.item, ITEM);
    assert.match(tasks.skipped[0]?.reason ?? "", /Documented exclusion: Internal during the preview\./);
  } finally {
    cleanup(root);
  }
});

test("#1407 a documented item produces no task", async () => {
  const root = copyFixture();
  try {
    const { tasks } = await tasksOf(root, { items: ["symbol:documented"] });
    assert.deepEqual(tasks.tasks, []);
    assert.equal(tasks.skipped[0]?.item, "symbol:documented");
    assert.match(tasks.skipped[0]?.reason ?? "", /already completely documented/);
  } finally {
    cleanup(root);
  }
});
