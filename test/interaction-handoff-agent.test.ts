import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyInteractionEdit,
  finishInteraction,
  handOffInteraction,
  resumeHandoff,
} from "../src/interaction/index.ts";
import {
  EDIT_FILE,
  ok,
  POLICY,
  refused,
  SNAPSHOT,
  verifyReady,
} from "./interaction-fixture.ts";

/** A public agent handoff document, serialized and parsed like a fresh consumer would read it. */
function agentDocument(): Record<string, unknown> {
  const handoff = ok(
    handOffInteraction(verifyReady(), {
      to: "agent",
      diff: "--- a/docs/install.md\n+++ b/docs/install.md\n",
      checks: [{ id: "doctor", status: "passed", evidence: "proof-1" }],
      nextAction: "Verify the install links after the edit.",
    }),
  ).handoff;
  assert.ok(handoff);
  return JSON.parse(JSON.stringify(handoff)) as Record<string, unknown>;
}

// #1105: a fresh agent recovers from the handoff document and the public snapshot alone.
test("a fresh agent resumes from the document with every decision and applied edit", () => {
  const resumed = resumeHandoff(agentDocument(), {
    snapshot: SNAPSHOT,
    policy: POLICY,
    consumer: "agent-2",
  });

  assert.equal(resumed.expired, false);
  const session = ok(resumed);
  assert.equal(session.status, "active");
  assert.equal(session.stage, "edit");
  assert.deepEqual(session.applied, ["edit-1"]);
  assert.deepEqual(session.resumedBy, ["agent-2"]);
  assert.equal(session.question, null);
  assert.equal(session.handoff, null);
  assert.equal(session.result, null);
  assert.ok(session.decisions.some((decision) => decision.subject === "approval:edit"));
});

test("the recovered agent never repeats an applied edit and needs a new approval for more", () => {
  const session = ok(
    resumeHandoff(agentDocument(), {
      snapshot: SNAPSHOT,
      policy: POLICY,
      consumer: "agent-2",
    }),
  );

  assert.equal(
    refused(
      applyInteractionEdit(session, { id: "edit-1", files: [EDIT_FILE], approvalId: "approve-edit" }),
    )[0]?.code,
    "interaction.edit-repeated",
  );
  assert.equal(
    refused(
      applyInteractionEdit(session, { id: "edit-2", files: [EDIT_FILE], approvalId: "approve-edit" }),
    )[0]?.code,
    "interaction.approval-required",
  );
});

test("the public document refuses any unknown key, including model conversation", () => {
  const document = agentDocument();
  const withMessages = {
    ...document,
    messages: [{ role: "user", content: "the previous conversation" }],
  };

  const result = resumeHandoff(withMessages, {
    snapshot: SNAPSHOT,
    policy: POLICY,
    consumer: "agent-2",
  });
  const [problem] = refused(result);
  assert.equal(problem?.code, "interaction.unknown-key");
  assert.equal(problem?.path, "/messages");
  assert.match(problem?.message ?? "", /no prompt, model, or conversation data/);

  const decisions = document.decisions as Record<string, unknown>[];
  const first = decisions[0];
  assert.ok(first);
  const nested = { ...document, decisions: [{ ...first, prompt: "hidden" }] };
  assert.equal(
    refused(
      resumeHandoff(nested, { snapshot: SNAPSHOT, policy: POLICY, consumer: "agent-2" }),
    )[0]?.path,
    "/decisions/0/prompt",
  );
});

test("a malformed handoff is refused with the field that is wrong", () => {
  const document = agentDocument();
  for (const [field, value, code] of [
    ["version", 2, "interaction.version"],
    ["nextAction", " ", "interaction.empty"],
    ["taskId", "not-a-hash", "interaction.task-id"],
    ["snapshot", "not-a-hash", "interaction.snapshot"],
  ] as const) {
    const broken = { ...document, [field]: value };
    const result = resumeHandoff(broken, {
      snapshot: SNAPSHOT,
      policy: POLICY,
      consumer: "agent-2",
    });
    assert.equal(refused(result)[0]?.code, code, field);
  }

  const [empty] = refused(
    resumeHandoff(document, { snapshot: SNAPSHOT, policy: POLICY, consumer: " " }),
  );
  assert.equal(empty?.code, "interaction.empty");
});

test("a handoff of finished work resumes done and keeps its single result", () => {
  const done = ok(finishInteraction(verifyReady(), { result: "proof-1" }));
  const handoff = ok(
    handOffInteraction(done, {
      to: "agent",
      diff: "",
      checks: [],
      nextAction: "Report the result.",
    }),
  ).handoff;
  assert.ok(handoff);

  const resumed = ok(
    resumeHandoff(JSON.parse(JSON.stringify(handoff)), {
      snapshot: SNAPSHOT,
      policy: POLICY,
      consumer: "agent-2",
    }),
  );
  assert.equal(resumed.status, "done");
  assert.equal(resumed.stage, "done");
  assert.equal(resumed.result, "proof-1");
  assert.equal(ok(finishInteraction(resumed, { result: "proof-1" })).result, "proof-1");
  assert.equal(
    refused(finishInteraction(resumed, { result: "proof-2" }))[0]?.code,
    "interaction.result-conflict",
  );
});

test("resuming a handoff without a result cannot start in done", () => {
  const result = resumeHandoff(agentDocument(), {
    snapshot: SNAPSHOT,
    policy: POLICY,
    consumer: "agent-2",
    stage: "done",
  });
  assert.equal(refused(result)[0]?.code, "interaction.stage");
});
