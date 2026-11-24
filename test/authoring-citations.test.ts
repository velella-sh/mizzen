import assert from "node:assert/strict";
import { test } from "node:test";
import { claimsIn, validateAuthoringDraft } from "../src/authoring/draft.ts";
import { cleanup, copyFixture, fixtureDraft, onlyTask, tasksOf } from "./authoring-fixture.ts";

test("#1411 every normative claim carries a citation and the draft validates", async () => {
  const root = copyFixture();
  try {
    const { tasks, site } = await tasksOf(root, { items: ["symbol:parseWidget"] });
    const task = onlyTask(tasks);
    const validation = validateAuthoringDraft(fixtureDraft(), task, site);
    assert.deepEqual(validation.problems, []);
    assert.deepEqual(validation.uncited, []);
    assert.equal(validation.ok, true);
    assert.ok(validation.claims.some((claim) => claim.normative));
    assert.equal(validation.citations.length, 7);
    assert.ok(validation.citations.some((citation) => citation.kind === "surface" && citation.ref === "symbol:parseWidget"));
    assert.ok(validation.citations.some((citation) => citation.kind === "behavior" && citation.ref === "parseWidget.returns-id"));
    assert.ok(validation.citations.some((citation) => citation.kind === "source" && citation.ref === "src/index.ts:6"));
    assert.ok(validation.citations.some((citation) => citation.kind === "evidence"));
  } finally {
    cleanup(root);
  }
});

test("#1411 an uncited normative claim is flagged before the preview", async () => {
  const root = copyFixture();
  try {
    const { tasks, site } = await tasksOf(root, { items: ["symbol:parseWidget"] });
    const task = onlyTask(tasks);
    const draft = fixtureDraft();
    draft.body = draft.body.replace(" [[surface:symbol:parseWidget]]", "");
    const validation = validateAuthoringDraft(draft, task, site);
    assert.equal(validation.ok, false);
    assert.equal(validation.uncited.length, 1);
    assert.match(validation.uncited[0]?.text ?? "", /returns the lowercase widget id/);
    assert.ok(validation.problems.some((problem) => problem.code === "authoring.uncited-claim"));
  } finally {
    cleanup(root);
  }
});

test("#1411 a citation to evidence the task does not require is refused", async () => {
  const root = copyFixture();
  try {
    const { tasks, site } = await tasksOf(root, { items: ["symbol:parseWidget"] });
    const task = onlyTask(tasks);
    const draft = fixtureDraft();
    draft.body = draft.body.replace("[[surface:symbol:parseWidget]]", "[[surface:symbol:doesNotExist]]");
    const validation = validateAuthoringDraft(draft, task, site);
    assert.equal(validation.ok, false);
    assert.ok(validation.problems.some((problem) => problem.code === "authoring.citation-unknown"));
  } finally {
    cleanup(root);
  }
});

test("#1411 fenced code and headings are not normative claims", () => {
  const claims = claimsIn("# Heading with returns\n\n```js\nreturns always\n```\n\nA plain sentence.\n");
  assert.equal(claims.length, 1);
  assert.equal(claims[0]?.normative, false);
  assert.equal(claims[0]?.text, "A plain sentence.");
});
