import assert from "node:assert/strict";
import { test } from "node:test";
import {
  finishInteraction,
  recordFeedback,
  type FeedbackInput,
} from "../src/interaction/index.ts";
import { ok, refused, started, TASK_ID, verifyReady } from "./interaction-fixture.ts";

// #1106: human acceptance, rejection, and corrections link to the task and evidence.
test("accepted feedback links the task and the evidence it judges", () => {
  const session = ok(
    recordFeedback(started(), {
      outcome: "accepted",
      evidence: "proof-1",
      principal: "human",
      note: "The install steps match the screenshots.",
    }),
  );

  assert.deepEqual(session.feedback, [
    {
      outcome: "accepted",
      taskId: TASK_ID,
      evidence: "proof-1",
      principal: "human",
      note: "The install steps match the screenshots.",
    },
  ]);
});

test("rejected and modified feedback carry the correction that makes them actionable", () => {
  const rejected = ok(
    recordFeedback(started(), {
      outcome: "rejected",
      evidence: "proof-1",
      principal: "human",
      note: "The version number is wrong.",
    }),
  );
  assert.equal(rejected.feedback[0]?.outcome, "rejected");
  assert.equal(rejected.feedback[0]?.taskId, rejected.taskId);
  assert.equal(rejected.feedback[0]?.evidence, "proof-1");

  const modified = ok(
    recordFeedback(rejected, {
      outcome: "modified",
      evidence: "proof-1",
      principal: "human",
      corrections: [
        {
          field: "docs/install.md#version",
          value: "0.2.6",
          reason: "The candidate version is 0.2.6.",
        },
      ],
    }),
  );
  assert.deepEqual(modified.feedback[1]?.corrections, [
    {
      field: "docs/install.md#version",
      value: "0.2.6",
      reason: "The candidate version is 0.2.6.",
    },
  ]);
});

test("modified feedback needs at least one correction, and an empty link is refused", () => {
  assert.equal(
    refused(
      recordFeedback(started(), {
        outcome: "modified",
        evidence: "proof-1",
        principal: "human",
      }),
    )[0]?.code,
    "interaction.corrections",
  );
  assert.equal(
    refused(recordFeedback(started(), { outcome: "accepted", evidence: " ", principal: "human" }))[0]
      ?.code,
    "interaction.empty",
  );
  assert.equal(
    refused(recordFeedback(started(), { outcome: "accepted", evidence: "proof-1", principal: "" }))[0]
      ?.code,
    "interaction.empty",
  );
  assert.equal(
    refused(
      recordFeedback(started(), {
        outcome: "modified",
        evidence: "proof-1",
        principal: "human",
        corrections: [{ field: "", value: "x", reason: "y" }],
      }),
    )[0]?.code,
    "interaction.empty",
  );
});

test("the public feedback record holds no prompt or model data", () => {
  const input = {
    outcome: "accepted",
    evidence: "proof-1",
    principal: "human",
    prompt: "the hidden prompt",
    model: "some-model",
    messages: ["secret"],
  } as unknown as FeedbackInput;
  const session = ok(recordFeedback(started(), input));

  assert.doesNotMatch(JSON.stringify(session.feedback), /prompt|model|messages|secret/);
  assert.deepEqual(Object.keys(session.feedback[0] ?? {}).sort(), [
    "evidence",
    "outcome",
    "principal",
    "taskId",
  ]);
});

test("feedback can be recorded on a finished task", () => {
  const done = ok(finishInteraction(verifyReady(), { result: "proof-1" }));
  const reviewed = ok(
    recordFeedback(done, {
      outcome: "accepted",
      evidence: "proof-1",
      principal: "human",
    }),
  );

  assert.equal(reviewed.status, "done");
  assert.equal(reviewed.feedback.length, 1);
});
