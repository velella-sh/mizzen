import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyInteractionEdit,
  decideApproval,
  isApproved,
  requestApproval,
} from "../src/interaction/index.ts";
import {
  atStage,
  EDIT_FILE,
  editReady,
  ok,
  POLICY,
  refused,
  SNAPSHOT,
  started,
} from "./interaction-fixture.ts";

// #1101: an approval names the files, action, and effect, and covers only its own stage.
test("a request records its stage, action, files, effect, snapshot, and policy", () => {
  const requested = ok(
    requestApproval(started(), {
      id: "approve-edit",
      action: "edit",
      files: ["docs/a.md", "docs/b.md"],
      effect: "Only the two install pages change.",
    }),
  );

  assert.equal(requested.status, "awaiting-approval");
  assert.deepEqual(requested.approvalRequests, [
    {
      id: "approve-edit",
      stage: "context",
      action: "edit",
      files: ["docs/a.md", "docs/b.md"],
      effect: "Only the two install pages change.",
      snapshot: SNAPSHOT,
      policy: POLICY,
    },
  ]);
});

test("a request needs at least one relative file and a unique id", () => {
  const noFiles = refused(
    requestApproval(started(), {
      id: "approve-edit",
      action: "edit",
      files: [],
      effect: "Nothing.",
    }),
  );
  assert.equal(noFiles[0]?.code, "interaction.empty");

  const absolute = refused(
    requestApproval(started(), {
      id: "approve-edit",
      action: "edit",
      files: ["/etc/passwd"],
      effect: "Nothing.",
    }),
  );
  assert.equal(absolute[0]?.code, "interaction.file");

  const duplicate = refused(
    requestApproval(started(), {
      id: "approve-edit",
      action: "edit",
      files: ["docs/a.md", "docs/a.md"],
      effect: "Nothing.",
    }),
  );
  assert.equal(duplicate[0]?.code, "interaction.duplicate");

  const requested = ok(
    requestApproval(started(), {
      id: "approve-edit",
      action: "edit",
      files: ["docs/a.md"],
      effect: "One page changes.",
    }),
  );
  const answered = ok(
    decideApproval(requested, {
      requestId: "approve-edit",
      principal: "human",
      decision: "approved",
      reason: "Reviewed.",
    }),
  );
  const repeated = refused(
    requestApproval(answered, {
      id: "approve-edit",
      action: "edit",
      files: ["docs/b.md"],
      effect: "Another page changes.",
    }),
  );
  assert.equal(repeated[0]?.code, "interaction.approval-duplicate");
});

test("an approval in one stage never carries into another stage", () => {
  const context = ok(
    requestApproval(started(), {
      id: "approve-preview",
      action: "preview",
      files: [EDIT_FILE],
      effect: "Show the proposed diff.",
    }),
  );
  const approved = ok(
    decideApproval(context, {
      requestId: "approve-preview",
      principal: "human",
      decision: "approved",
      reason: "The preview is safe to see.",
    }),
  );
  const edit = atStage(approved, "edit");

  assert.equal(isApproved(edit, { stage: "edit", action: "preview", files: [EDIT_FILE] }), false);
  const [problem] = refused(
    applyInteractionEdit(edit, { id: "edit-1", files: [EDIT_FILE], approvalId: "approve-preview" }),
  );
  assert.equal(problem?.code, "interaction.approval-scope");
  assert.match(problem?.message ?? "", /stage `context`/);
});

test("an approval covers only the files and action it names", () => {
  const { session, approvalId } = editReady();

  assert.equal(isApproved(session, { stage: "edit", action: "edit", files: [EDIT_FILE] }), true);
  assert.equal(isApproved(session, { stage: "edit", action: "edit", files: ["docs/other.md"] }), false);

  const other = refused(
    applyInteractionEdit(session, {
      id: "edit-1",
      files: ["docs/other.md"],
      approvalId,
    }),
  );
  assert.equal(other[0]?.code, "interaction.approval-scope");

  const mixed = refused(
    applyInteractionEdit(session, {
      id: "edit-1",
      files: [EDIT_FILE, "docs/other.md"],
      approvalId,
    }),
  );
  assert.equal(mixed[0]?.code, "interaction.approval-scope");
  assert.match(mixed[0]?.message ?? "", /docs\/other\.md/);
});

test("a rejected request refuses the action and explains why", () => {
  const requested = ok(
    requestApproval(atStage(started(), "edit"), {
      id: "approve-edit",
      action: "edit",
      files: [EDIT_FILE],
      effect: "Only the install page changes.",
    }),
  );
  const rejected = ok(
    decideApproval(requested, {
      requestId: "approve-edit",
      principal: "human",
      decision: "rejected",
      reason: "The changelog must change too.",
    }),
  );

  assert.equal(isApproved(rejected, { stage: "edit", action: "edit", files: [EDIT_FILE] }), false);
  const [problem] = refused(
    applyInteractionEdit(rejected, { id: "edit-1", files: [EDIT_FILE], approvalId: "approve-edit" }),
  );
  assert.equal(problem?.code, "interaction.approval-rejected");
  assert.match(problem?.message ?? "", /changelog/);
});

test("an unknown request is refused, and a pending one cannot be used", () => {
  const requested = ok(
    requestApproval(atStage(started(), "edit"), {
      id: "approve-edit",
      action: "edit",
      files: [EDIT_FILE],
      effect: "Only the install page changes.",
    }),
  );

  const unknown = refused(
    decideApproval(requested, {
      requestId: "approve-other",
      principal: "human",
      decision: "approved",
      reason: "Reviewed.",
    }),
  );
  assert.equal(unknown[0]?.code, "interaction.approval-unknown");

  const [pending] = refused(
    applyInteractionEdit(requested, { id: "edit-1", files: [EDIT_FILE], approvalId: "approve-edit" }),
  );
  assert.equal(pending?.code, "interaction.status");
});
