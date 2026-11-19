import assert from "node:assert/strict";
import { test } from "node:test";
import {
  atStage,
  ok,
  refused,
  started,
} from "./interaction-fixture.ts";
import { decideApproval, recordDefault, requestApproval } from "../src/interaction/index.ts";

// #1100: nonessential ambiguity gets a recorded default with its reason.
test("a low-risk default is recorded with the reason it applies", () => {
  const result = recordDefault(started(), {
    field: "/layout",
    value: "doc",
    reason: "Every other page uses the doc layout.",
    risk: "low",
  });
  const session = ok(result);

  assert.deepEqual(result.suggested, {
    subject: "/layout",
    choice: "doc",
    reason: "Every other page uses the doc layout.",
  });
  assert.deepEqual(session.decisions, [result.suggested]);
});

test("a risky default is not adopted without an approval, but its suggestion is returned", () => {
  const result = recordDefault(started(), {
    field: "/search",
    value: "off",
    reason: "Search would index drafts.",
    risk: "high",
  });

  const [problem] = refused(result);
  assert.equal(problem?.code, "interaction.approval-required");
  assert.match(problem?.message ?? "", /off/);
  assert.match(problem?.message ?? "", /Search would index drafts/);
  assert.deepEqual(result.suggested, {
    subject: "/search",
    choice: "off",
    reason: "Search would index drafts.",
  });
});

test("a risky default is adopted under an approval for action default in the same stage", () => {
  const requested = ok(
    requestApproval(started(), {
      id: "approve-search",
      action: "default",
      files: ["mizzen.yml"],
      effect: "Search stays off for this site.",
    }),
  );
  const decided = ok(
    decideApproval(requested, {
      requestId: "approve-search",
      principal: "human",
      decision: "approved",
      reason: "Drafts never become public.",
    }),
  );

  const adopted = ok(
    recordDefault(decided, {
      field: "/search",
      value: "off",
      reason: "Search would index drafts.",
      risk: "high",
      approvalId: "approve-search",
    }),
  );
  assert.deepEqual(adopted.decisions.at(-1), {
    subject: "/search",
    choice: "off",
    reason: "Search would index drafts.",
  });
});

test("a risky default keeps its stage scope and is refused elsewhere", () => {
  const requested = ok(
    requestApproval(started(), {
      id: "approve-search",
      action: "default",
      files: ["mizzen.yml"],
      effect: "Search stays off for this site.",
    }),
  );
  const decided = ok(
    decideApproval(requested, {
      requestId: "approve-search",
      principal: "human",
      decision: "approved",
      reason: "Drafts never become public.",
    }),
  );
  const later = atStage(decided, "edit");

  const [problem] = refused(
    recordDefault(later, {
      field: "/search",
      value: "off",
      reason: "Search would index drafts.",
      risk: "high",
      approvalId: "approve-search",
    }),
  );
  assert.equal(problem?.code, "interaction.approval-scope");
  assert.match(problem?.message ?? "", /stage `context`/);
});

test("a pending approval cannot adopt a risky default", () => {
  const pending = ok(
    requestApproval(started(), {
      id: "approve-search",
      action: "default",
      files: ["mizzen.yml"],
      effect: "Search stays off for this site.",
    }),
  );

  const [problem] = refused(
    recordDefault(pending, {
      field: "/search",
      value: "off",
      reason: "Search would index drafts.",
      risk: "high",
      approvalId: "approve-search",
    }),
  );
  assert.equal(problem?.code, "interaction.status");
});

test("a default needs a field, a value, and a reason", () => {
  for (const input of [
    { field: "", value: "doc", reason: "Why.", risk: "low" as const },
    { field: "/layout", value: " ", reason: "Why.", risk: "low" as const },
    { field: "/layout", value: "doc", reason: "", risk: "low" as const },
  ]) {
    assert.equal(refused(recordDefault(started(), input))[0]?.code, "interaction.empty");
  }
});
