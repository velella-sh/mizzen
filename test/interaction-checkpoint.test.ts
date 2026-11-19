import assert from "node:assert/strict";
import { test } from "node:test";
import type { InteractionCheckpoint } from "../src/contracts/index.ts";
import {
  applyInteractionEdit,
  pauseInteraction,
  resumeInteraction,
} from "../src/interaction/index.ts";
import {
  atStage,
  CHANGED_SNAPSHOT,
  EDIT_FILE,
  editReady,
  ok,
  POLICY,
  refused,
  SNAPSHOT,
  started,
  TASK_ID,
} from "./interaction-fixture.ts";

/** The checkpoint a paused context session holds. */
function contextCheckpoint(): InteractionCheckpoint {
  return {
    taskId: TASK_ID,
    snapshot: SNAPSHOT,
    policy: POLICY,
    stage: "context",
    evidence: "pack-1",
    next: "Read the compiled context.",
    applied: [],
  };
}

// #1103: pausing after context or preview creates a checkpoint that resumes cleanly.
test("a context pause records a valid checkpoint and resumes with a consumer", () => {
  const paused = ok(
    pauseInteraction(started(), {
      evidence: "pack-1",
      next: "Read the compiled context.",
    }),
  );

  assert.equal(paused.status, "paused");
  assert.deepEqual(paused.checkpoint, contextCheckpoint());

  const resumed = ok(resumeInteraction(paused, { consumer: "cli" }));
  assert.equal(resumed.status, "active");
  assert.equal(resumed.stage, "context");
  assert.deepEqual(resumed.resumedBy, ["cli"]);
  assert.deepEqual(resumed.checkpoint, contextCheckpoint());
});

test("a preview pause resumes from the checkpoint a second consumer holds", () => {
  const preview = atStage(started(), "preview");
  const paused = ok(
    pauseInteraction(preview, { evidence: "diff-1", next: "Approve the proposed edit." }),
  );
  const checkpoint = paused.checkpoint;
  assert.ok(checkpoint);
  assert.equal(checkpoint.stage, "preview");

  const resumed = ok(
    resumeInteraction(paused, { checkpoint: { ...checkpoint }, consumer: "mcp" }),
  );
  assert.equal(resumed.status, "active");
  assert.deepEqual(resumed.resumedBy, ["mcp"]);
});

test("resuming does not repeat an edit that already ran", () => {
  const { session, approvalId } = editReady();
  const edited = ok(
    applyInteractionEdit(session, { id: "edit-1", files: [EDIT_FILE], approvalId }),
  );
  assert.deepEqual(edited.applied, ["edit-1"]);

  const [problem] = refused(
    applyInteractionEdit(edited, { id: "edit-1", files: [EDIT_FILE], approvalId }),
  );
  assert.equal(problem?.code, "interaction.edit-repeated");
  assert.deepEqual(edited.applied, ["edit-1"]);
});

test("a stale checkpoint that predates an edit is refused instead of replaying it", () => {
  const { session, approvalId } = editReady();
  const edited = ok(
    applyInteractionEdit(session, { id: "edit-1", files: [EDIT_FILE], approvalId }),
  );
  const checkpoint = { ...contextCheckpoint(), stage: "preview" as const, evidence: "diff-1" };
  const paused = { ...edited, status: "paused" as const, checkpoint };

  const [problem] = refused(resumeInteraction(paused, { checkpoint, consumer: "cli" }));
  assert.equal(problem?.code, "interaction.checkpoint-stale");
  assert.match(problem?.message ?? "", /session has 1/);
  assert.match(problem?.message ?? "", /would repeat an edit/);
});

test("a checkpoint from another snapshot, policy, or task is expired", () => {
  const paused = ok(pauseInteraction(started(), { evidence: "pack-1", next: "Read it." }));
  assert.ok(paused.checkpoint);

  const cases = [
    { checkpoint: { ...paused.checkpoint, snapshot: CHANGED_SNAPSHOT }, code: "interaction.checkpoint-expired" },
    { checkpoint: { ...paused.checkpoint, policy: "policy-v2" }, code: "interaction.checkpoint-expired" },
    { checkpoint: { ...paused.checkpoint, taskId: "d".repeat(64) }, code: "interaction.checkpoint-task" },
    { checkpoint: { ...paused.checkpoint, stage: "edit" as const }, code: "interaction.checkpoint-stage" },
  ];
  for (const { checkpoint, code } of cases) {
    const [problem] = refused(resumeInteraction(paused, { checkpoint, consumer: "cli" }));
    assert.equal(problem?.code, code, code);
  }
});

test("a checkpoint is taken only after context or preview, and only by a paused consumer", () => {
  const [stage] = refused(
    pauseInteraction(atStage(started(), "edit"), { evidence: "diff-1", next: "Review." }),
  );
  assert.equal(stage?.code, "interaction.pause-stage");

  const paused = ok(pauseInteraction(started(), { evidence: "pack-1", next: "Read it." }));
  const resumed = ok(resumeInteraction(paused, { consumer: "cli" }));
  const [status] = refused(resumeInteraction(resumed, { consumer: "cli" }));
  assert.equal(status?.code, "interaction.status");

  assert.equal(refused(pauseInteraction(resumed, { evidence: "", next: "x" }))[0]?.code, "interaction.empty");
});
