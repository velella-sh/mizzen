import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyInteractionEdit,
  finishInteraction,
  recoverInteraction,
  refuseInteraction,
} from "../src/interaction/index.ts";
import { EDIT_FILE, ok, refused, started, verifyReady } from "./interaction-fixture.ts";

// #1102: every refusal names its source, a reason code, and the action that recovers.
test("permission, context, and check refusals all return code, source, and recovery", () => {
  for (const source of ["permission", "context", "check"] as const) {
    const code = `interaction.${source}-refused`;
    const refusedSession = ok(
      refuseInteraction(started(), {
        source,
        code,
        detail: `The ${source} step did not pass.`,
        action: `Fix the ${source} step and retry.`,
        evidence: `${source}:evidence-1`,
      }),
    );

    assert.equal(refusedSession.status, "refused");
    assert.deepEqual(refusedSession.refusal, {
      source,
      code,
      detail: `The ${source} step did not pass.`,
      action: `Fix the ${source} step and retry.`,
      evidence: `${source}:evidence-1`,
    });
    assert.notEqual(refusedSession.refusal?.source, undefined);
    assert.notEqual(refusedSession.refusal?.action, "");
  }
});

test("a refusal without a code, detail, or recovery action is refused", () => {
  const base = {
    source: "permission" as const,
    code: "interaction.permission-refused",
    detail: "The agent may not write.",
    action: "Ask for write access.",
  };

  for (const input of [
    { ...base, code: " " },
    { ...base, detail: "" },
    { ...base, action: " " },
  ]) {
    assert.equal(refused(refuseInteraction(started(), input))[0]?.code, "interaction.empty");
  }

  const unknown = refused(
    refuseInteraction(started(), {
      ...base,
      source: "network" as unknown as "permission",
    }),
  );
  assert.equal(unknown[0]?.code, "interaction.refusal-source");
});

test("a refused session cannot edit until its recovery action is recorded", () => {
  const refusedSession = ok(
    refuseInteraction(started(), {
      source: "permission",
      code: "interaction.permission-refused",
      detail: "The agent may not write to the install page.",
      action: "Ask the maintainer for write access.",
    }),
  );
  assert.equal(
    refused(applyInteractionEdit(refusedSession, { id: "edit-1", files: [EDIT_FILE], approvalId: "a" }))[0]
      ?.code,
    "interaction.status",
  );

  const recovered = ok(recoverInteraction(refusedSession, { reason: "The maintainer granted access." }));
  assert.equal(recovered.status, "active");
  assert.ok(recovered.refusal, "the refusal stays for audit");
  assert.deepEqual(recovered.decisions.at(-1), {
    subject: "refusal",
    choice: "interaction.permission-refused",
    reason: "The maintainer granted access.",
  });
  assert.equal(refused(recoverInteraction(recovered, { reason: "again" }))[0]?.code, "interaction.status");
});

test("a finished task records feedback instead of a new refusal", () => {
  const done = ok(finishInteraction(verifyReady(), { result: "proof-1" }));
  const [problem] = refused(
    refuseInteraction(done, {
      source: "check",
      code: "interaction.check-refused",
      detail: "A check failed after finishing.",
      action: "Rerun the check.",
    }),
  );
  assert.equal(problem?.code, "interaction.status");
  assert.match(problem?.message ?? "", /feedback/);
});

test("a refusal is never reduced to an unexplained failure", () => {
  const refusedSession = ok(
    refuseInteraction(started(), {
      source: "check",
      code: "interaction.check-failed",
      detail: "The link check found one broken link.",
      action: "Fix `/guide/install/#setup` and rerun the link check.",
      evidence: "links",
    }),
  );
  const refusal = refusedSession.refusal;
  assert.ok(refusal);
  assert.equal(refusal.code, "interaction.check-failed");
  assert.equal(refusal.source, "check");
  assert.equal(refusal.evidence, "links");
  assert.match(refusal.action, /rerun the link check/);
});
