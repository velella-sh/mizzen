import assert from "node:assert/strict";
import { test } from "node:test";
import { validateAuthoringDraft } from "../src/authoring/draft.ts";
import { cleanup, copyFixture, fixtureDraft, onlyTask, tasksOf, type MutableDraft } from "./authoring-fixture.ts";

/** A minimal draft for a task, with every location and question from the task. */
function draftFor(task: ReturnType<typeof onlyTask>): MutableDraft {
  return {
    version: 1,
    item: task.item,
    pageType: task.pageType.kind,
    title: task.surface.name,
    slug: task.location.url,
    block: task.location.block,
    body: `# ${task.surface.name} {#${task.location.block}}\n\nA description.\n`,
    limitations: [...task.limitations],
    unknowns: [...task.unknowns],
    questions: [...task.questions],
  };
}

test("#1412 the draft must carry every explicit unknown and reviewer question", async () => {
  const root = copyFixture();
  try {
    const { tasks, site } = await tasksOf(root, { items: ["symbol:orphanApi"] });
    const task = onlyTask(tasks, "symbol:orphanApi");
    assert.ok(task.unknowns.some((unknown) => unknown.id === "behavior-contract"));

    const dropped = draftFor(task);
    dropped.unknowns = [];
    dropped.limitations = [];
    const missing = validateAuthoringDraft(dropped, task, site);
    assert.equal(missing.ok, false);
    assert.ok(missing.problems.some((problem) => problem.code === "authoring.unknown-dropped"));
    assert.ok(missing.problems.some((problem) => problem.code === "authoring.limitation-dropped"));

    const kept = draftFor(task);
    const validation = validateAuthoringDraft(kept, task, site);
    assert.equal(validation.ok, true, JSON.stringify(validation.problems));
    assert.deepEqual(validation.unknowns, task.unknowns);
    assert.deepEqual(validation.questions, task.questions);
  } finally {
    cleanup(root);
  }
});

test("#1412 dropping a reviewer question is refused", async () => {
  const root = copyFixture();
  try {
    const { tasks, site } = await tasksOf(root, { items: ["symbol:parseWidget"] });
    const task = onlyTask(tasks);
    const draft = fixtureDraft();
    draft.questions = [];
    const validation = validateAuthoringDraft(draft, task, site);
    assert.equal(validation.ok, false);
    assert.ok(validation.problems.some((problem) => problem.code === "authoring.question-dropped"));
  } finally {
    cleanup(root);
  }
});

test("#1412 a normative claim that cites an unverified behavior is kept out", async () => {
  const root = copyFixture();
  try {
    const { tasks, site } = await tasksOf(root, { items: ["symbol:parseWidget"] });
    const base = onlyTask(tasks);
    const unknown = {
      id: "behavior-parseWidget.returns-id",
      statement: "Behavior `parseWidget.returns-id` is unverified: missing-evidence.",
      evidence: "The tests and evidence the published policy requires.",
    };
    const task = { ...base, unknowns: [...base.unknowns, unknown] };
    const draft = fixtureDraft();
    draft.unknowns = [...draft.unknowns, unknown];
    const validation = validateAuthoringDraft(draft, task, site);
    assert.equal(validation.ok, false);
    assert.ok(validation.problems.some((problem) => problem.code === "authoring.unsupported-claim"));
    assert.ok(validation.uncited.length === 0, "the claim is cited, but to an unverified behavior");
  } finally {
    cleanup(root);
  }
});
