import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyInteractionEdit,
  approvalValidity,
  handoffValidity,
  handOffInteraction,
  isApproved,
  resumeHandoff,
} from "../src/interaction/index.ts";
import {
  CHANGED_SNAPSHOT,
  EDIT_FILE,
  editReady,
  ok,
  POLICY,
  refused,
  SNAPSHOT,
  verifyReady,
} from "./interaction-fixture.ts";

/** A public agent handoff document built from a verified session. */
function document(): Record<string, unknown> {
  const handoff = ok(
    handOffInteraction(verifyReady(), {
      to: "agent",
      diff: "",
      checks: [{ id: "doctor", status: "passed" }],
      nextAction: "Verify the install links.",
    }),
  ).handoff;
  assert.ok(handoff);
  return JSON.parse(JSON.stringify(handoff)) as Record<string, unknown>;
}

// #1107: a changed snapshot or policy expires approvals and handoffs.
test("an approval expires when the snapshot or policy changes", () => {
  const { session, approvalId } = editReady();
  const approval = session.approvals[0];
  assert.ok(approval);

  assert.deepEqual(approvalValidity(approval, SNAPSHOT, POLICY), { valid: true });
  const snapshotChange = approvalValidity(approval, CHANGED_SNAPSHOT, POLICY);
  assert.equal(snapshotChange.valid, false);
  assert.match(snapshotChange.reason ?? "", /snapshot/);
  const policyChange = approvalValidity(approval, SNAPSHOT, "policy-v2");
  assert.equal(policyChange.valid, false);
  assert.match(policyChange.reason ?? "", /policy/);

  const changedSnapshot = { ...session, snapshot: CHANGED_SNAPSHOT };
  assert.equal(
    isApproved(changedSnapshot, { stage: "edit", action: "edit", files: [EDIT_FILE] }),
    false,
  );
  const [problem] = refused(
    applyInteractionEdit(changedSnapshot, {
      id: "edit-1",
      files: [EDIT_FILE],
      approvalId,
    }),
  );
  assert.equal(problem?.code, "interaction.approval-expired");
  assert.match(problem?.message ?? "", /snapshot/);

  const changedPolicy = { ...session, policy: "policy-v2" };
  assert.equal(
    refused(
      applyInteractionEdit(changedPolicy, { id: "edit-1", files: [EDIT_FILE], approvalId }),
    )[0]?.code,
    "interaction.approval-expired",
  );
});

test("a handoff expires with the snapshot, and resuming without a reason is refused", () => {
  const handoff = ok(
    handOffInteraction(verifyReady(), {
      to: "agent",
      diff: "",
      checks: [],
      nextAction: "Continue.",
    }),
  ).handoff;
  assert.ok(handoff);

  const validity = handoffValidity(handoff, CHANGED_SNAPSHOT, POLICY);
  assert.equal(validity.valid, false);
  assert.match(validity.reason ?? "", /snapshot/);

  const result = resumeHandoff(document(), {
    snapshot: CHANGED_SNAPSHOT,
    policy: POLICY,
    consumer: "cli",
  });
  assert.equal(result.expired, true);
  assert.equal(result.session, undefined);
  assert.equal(refused(result)[0]?.code, "interaction.handoff-expired");
});

test("an expired handoff resumes with a recorded reason and the current snapshot", () => {
  const reason = "The install page changed after the handoff; recheck that section.";
  const result = resumeHandoff(document(), {
    snapshot: CHANGED_SNAPSHOT,
    policy: POLICY,
    consumer: "agent-2",
    reason,
  });

  assert.equal(result.expired, true);
  const session = ok(result);
  assert.equal(session.status, "active");
  assert.equal(session.snapshot, CHANGED_SNAPSHOT);
  assert.equal(session.resumeReason, reason);
  assert.deepEqual(session.applied, ["edit-1"]);
  assert.deepEqual(session.resumedBy, ["agent-2"]);
});

test("a policy change also expires the handoff and a normal resume records no reason", () => {
  const policyChange = resumeHandoff(document(), {
    snapshot: SNAPSHOT,
    policy: "policy-v2",
    consumer: "agent-2",
  });
  assert.equal(policyChange.expired, true);
  assert.match(refused(policyChange)[0]?.message ?? "", /policy/);

  const normal = resumeHandoff(document(), {
    snapshot: SNAPSHOT,
    policy: POLICY,
    consumer: "agent-2",
  });
  assert.equal(normal.expired, false);
  assert.equal(ok(normal).resumeReason, null);
});

test("old approvals do not travel with the handoff into the new session", () => {
  const resumed = ok(
    resumeHandoff(document(), { snapshot: SNAPSHOT, policy: POLICY, consumer: "agent-2" }),
  );
  assert.deepEqual(resumed.approvals, []);

  const [problem] = refused(
    applyInteractionEdit(resumed, {
      id: "edit-2",
      files: [EDIT_FILE],
      approvalId: "approve-edit",
    }),
  );
  assert.equal(problem?.code, "interaction.approval-required");
});
