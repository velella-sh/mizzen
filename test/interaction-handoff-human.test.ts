import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  applyInteractionEdit,
  clarifyInteraction,
  finishInteraction,
  handOffInteraction,
  recordDefault,
} from "../src/interaction/index.ts";
import {
  atStage,
  EDIT_FILE,
  editReady,
  ok,
  refused,
  started,
  verifyReady,
} from "./interaction-fixture.ts";

const incomplete = JSON.parse(
  readFileSync(new URL("./fixtures/interaction/incomplete-task.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

/** A verified session with one decision, one approval, and one applied edit. */
function workedSession() {
  const { session, approvalId } = editReady();
  const defaulted = ok(
    recordDefault(session, {
      field: "/layout",
      value: "doc",
      reason: "Every other page uses the doc layout.",
      risk: "low",
    }),
  );
  const edited = ok(
    applyInteractionEdit(defaulted, { id: "edit-1", files: [EDIT_FILE], approvalId }),
  );
  return atStage(edited, "verify");
}

// #1104: a human handoff summarizes decisions, diff, checks, questions, and the next action.
test("a human handoff carries every decision, the diff, checks, questions, and the next action", () => {
  const handed = ok(
    handOffInteraction(workedSession(), {
      to: "human",
      diff: "--- a/docs/install.md\n+++ b/docs/install.md\n",
      checks: [
        { id: "doctor", status: "passed", evidence: "proof-1" },
        { id: "links", status: "skipped" },
      ],
      questions: [
        {
          field: "/version",
          question: "Which version should the note name?",
          detail: "The site has two versions.",
          choices: ["v1", "v2"],
        },
      ],
      nextAction: "Review the diff and accept it.",
    }),
  );

  assert.equal(handed.status, "handed-off");
  const handoff = handed.handoff;
  assert.ok(handoff);
  assert.equal(handoff.to, "human");
  assert.equal(handoff.nextAction, "Review the diff and accept it.");
  assert.match(handoff.diff, /docs\/install\.md/);
  assert.deepEqual(handoff.checks, [
    { id: "doctor", status: "passed", evidence: "proof-1" },
    { id: "links", status: "skipped" },
  ]);
  assert.deepEqual(handoff.questions.map((question) => question.field), ["/version"]);
  assert.deepEqual(handoff.applied, ["edit-1"]);
  assert.equal(handoff.result, null);
  assert.ok(handoff.decisions.some((decision) => decision.subject === "/layout"));
  assert.ok(handoff.decisions.some((decision) => decision.subject === "approval:edit"));
  assert.equal(handoff.snapshot, started().snapshot);
});

test("the public handoff has a closed shape and no model conversation", () => {
  const handoff = ok(
    handOffInteraction(workedSession(), {
      to: "human",
      diff: "",
      checks: [],
      nextAction: "Review the change.",
    }),
  ).handoff;
  assert.ok(handoff);

  assert.deepEqual(Object.keys(handoff).sort(), [
    "applied",
    "checks",
    "decisions",
    "diff",
    "goal",
    "nextAction",
    "policy",
    "questions",
    "result",
    "snapshot",
    "taskId",
    "to",
    "version",
  ]);
  assert.doesNotMatch(JSON.stringify(handoff), /"(messages|prompt|model|conversation|history|transcript)"/);
});

test("a pending clarification becomes an open question in the handoff", () => {
  const asked = ok(clarifyInteraction(started(), incomplete, { checks: ["doctor"] }));
  assert.ok(asked.question);

  const handoff = ok(
    handOffInteraction(asked, {
      to: "human",
      diff: "",
      checks: [],
      nextAction: "Answer the open question.",
    }),
  ).handoff;
  assert.deepEqual(handoff?.questions, [asked.question]);
});

test("a handoff of finished work records its single result", () => {
  const done = ok(finishInteraction(verifyReady(), { result: "proof-1" }));
  const handed = ok(
    handOffInteraction(done, {
      to: "human",
      diff: "",
      checks: [{ id: "doctor", status: "passed" }],
      nextAction: "Accept the result.",
    }),
  );

  assert.equal(handed.status, "done");
  assert.equal(handed.handoff?.result, "proof-1");
});

test("a handoff needs a next action, a valid target, and valid checks", () => {
  const session = workedSession();
  assert.equal(
    refused(handOffInteraction(session, { to: "human", diff: "", checks: [], nextAction: " " }))[0]
      ?.code,
    "interaction.empty",
  );
  assert.equal(
    refused(
      handOffInteraction(session, {
        to: "robot" as unknown as "human",
        diff: "",
        checks: [],
        nextAction: "Continue.",
      }),
    )[0]?.code,
    "interaction.handoff-target",
  );
  assert.equal(
    refused(
      handOffInteraction(session, {
        to: "human",
        diff: "",
        checks: [{ id: "doctor", status: "unknown" as unknown as "passed" }],
        nextAction: "Continue.",
      }),
    )[0]?.code,
    "interaction.check-status",
  );
});

test("a session produces one handoff; a second needs a resumed session", () => {
  const handed = ok(
    handOffInteraction(workedSession(), {
      to: "human",
      diff: "",
      checks: [],
      nextAction: "Review it.",
    }),
  );
  assert.equal(
    refused(
      handOffInteraction(handed, {
        to: "human",
        diff: "",
        checks: [],
        nextAction: "Review it again.",
      }),
    )[0]?.code,
    "interaction.handoff-exists",
  );
});
