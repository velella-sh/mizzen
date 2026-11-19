import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  answerClarification,
  applyInteractionEdit,
  clarifyInteraction,
} from "../src/interaction/index.ts";
import { ok, refused, started, verifyReady } from "./interaction-fixture.ts";

const incomplete = JSON.parse(
  readFileSync(new URL("./fixtures/interaction/incomplete-task.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

/** A contract draft with one field removed. */
function without(key: string): Record<string, unknown> {
  const copy = { ...incomplete, goal: "Update the install guide" } as Record<string, unknown>;
  delete copy[key];
  return copy;
}

// #1099: an incomplete task asks one specific question before any edit.
test("an incomplete task asks one question with the missing field, and no edit can run first", () => {
  const asked = ok(clarifyInteraction(started(), incomplete, { checks: ["doctor", "test"] }));

  assert.equal(asked.status, "clarifying");
  assert.ok(asked.question);
  assert.equal(asked.question.field, "/goal");
  assert.deepEqual(asked.question.choices, []);
  assert.match(asked.question.question, /`\/goal`/);
  assert.equal((asked.question.question.match(/\?/g) ?? []).length, 1, "exactly one question");
  assert.deepEqual(asked.applied, []);

  const edit = refused(
    applyInteractionEdit(asked, {
      id: "edit-1",
      files: ["docs/install.md"],
      approvalId: "approve-edit",
    }),
  );
  assert.equal(edit[0]?.code, "interaction.status");
  assert.match(edit[0]?.message ?? "", /clarifying/);
});

test("a choice question names the field and its allowed answers", () => {
  const asked = ok(
    clarifyInteraction(started(), without("scope"), {
      checks: ["doctor", "test"],
      choices: { "/scope": ["/guide/install/", "/guide/upgrade/"] },
    }),
  );

  assert.equal(asked.question?.field, "/scope");
  assert.deepEqual(asked.question?.choices, ["/guide/install/", "/guide/upgrade/"]);
  assert.match(asked.question?.question ?? "", /^Which value should `\/scope` use\?$/);
});

test("answering the question records the answer and returns to active", () => {
  const asked = ok(clarifyInteraction(started(), incomplete, { checks: ["doctor", "test"] }));
  const answered = ok(answerClarification(asked, "Update the install guide"));

  assert.equal(answered.status, "active");
  assert.equal(answered.question, null);
  assert.deepEqual(answered.decisions, [
    {
      subject: "/goal",
      choice: "Update the install guide",
      reason: "Answered the open clarification question.",
    },
  ]);
  assert.deepEqual(refused(answerClarification(answered, "again"))[0]?.code, "interaction.status");
});

test("a complete task is not asked a question, and a late clarification is refused", () => {
  const complete = refused(
    clarifyInteraction(
      started(),
      { ...incomplete, goal: "Update the install guide" },
      { checks: ["doctor", "test"] },
    ),
  );
  assert.equal(complete[0]?.code, "interaction.task-complete");

  const late = refused(clarifyInteraction(verifyReady(), incomplete, { checks: ["doctor", "test"] }));
  assert.equal(late[0]?.code, "interaction.clarification-late");
});
