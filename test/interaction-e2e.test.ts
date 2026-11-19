import assert from "node:assert/strict";
import { test } from "node:test";
import type { InteractionSession } from "../src/contracts/index.ts";
import {
  advanceInteraction,
  applyInteractionEdit,
  decideApproval,
  finishInteraction,
  pauseInteraction,
  requestApproval,
  resumeInteraction,
  startInteraction,
} from "../src/interaction/index.ts";
import { EDIT_FILE, ok, POLICY, refused } from "./interaction-fixture.ts";
import { registered } from "./tasks-fixture.ts";

/** Moves a session that must allow the move. */
function moved(session: InteractionSession, stage: "preview" | "edit" | "verify"): InteractionSession {
  return ok(advanceInteraction(session, { stage, reason: `Advanced to ${stage}.` }));
}

// #1108: the public interaction entry pauses twice, two consumers resume, one result is produced.
test("two consumers resume a task paused twice and produce exactly one final result", () => {
  const task = registered();
  const start = ok(
    startInteraction({
      taskId: task.id,
      snapshot: task.snapshot.id,
      policy: POLICY,
      goal: task.goal,
    }),
  );
  assert.equal(start.stage, "context");

  const contextPause = ok(
    pauseInteraction(start, {
      evidence: "context:pack-1",
      next: "Read the compiled install context.",
    }),
  );
  const cli = ok(resumeInteraction(contextPause, { consumer: "cli" }));
  assert.deepEqual(cli.resumedBy, ["cli"]);

  const preview = moved(cli, "preview");
  const previewPause = ok(
    pauseInteraction(preview, {
      evidence: "preview:diff-1",
      next: "Approve the proposed install edit.",
    }),
  );
  const mcp = ok(resumeInteraction(previewPause, { consumer: "mcp" }));
  assert.deepEqual(mcp.resumedBy, ["cli", "mcp"]);

  const edit = moved(mcp, "edit");
  const requested = ok(
    requestApproval(edit, {
      id: "approve-edit",
      action: "edit",
      files: [EDIT_FILE],
      effect: "Only the install page changes.",
    }),
  );
  const approved = ok(
    decideApproval(requested, {
      requestId: "approve-edit",
      principal: "human",
      decision: "approved",
      reason: "The diff is limited to the install page.",
    }),
  );
  const edited = ok(
    applyInteractionEdit(approved, {
      id: "edit-1",
      files: [EDIT_FILE],
      approvalId: "approve-edit",
    }),
  );
  assert.deepEqual(edited.applied, ["edit-1"]);

  const verify = moved(edited, "verify");
  const finished = ok(finishInteraction(verify, { result: "proof-1" }));
  const again = ok(finishInteraction(finished, { result: "proof-1" }));

  assert.equal(finished.status, "done");
  assert.equal(finished.taskId, task.id);
  assert.equal(finished.snapshot, task.snapshot.id);
  assert.equal(finished.result, "proof-1");
  assert.deepEqual(finished.applied, ["edit-1"]);
  assert.deepEqual(again, finished, "a repeated finish is idempotent");
  assert.equal(
    (JSON.stringify(finished).match(/"result":"proof-1"/g) ?? []).length,
    1,
    "exactly one final result",
  );
  assert.equal(
    refused(finishInteraction(again, { result: "proof-2" }))[0]?.code,
    "interaction.result-conflict",
  );
  assert.equal(
    refused(
      applyInteractionEdit(again, {
        id: "edit-2",
        files: [EDIT_FILE],
        approvalId: "approve-edit",
      }),
    )[0]?.code,
    "interaction.status",
  );
  assert.equal(JSON.stringify(JSON.parse(JSON.stringify(finished))), JSON.stringify(finished));
});
