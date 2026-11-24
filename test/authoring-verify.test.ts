import assert from "node:assert/strict";
import { test } from "node:test";
import { authoringPreview } from "../src/authoring/preview.ts";
import { authoringProposalOf } from "../src/authoring/proposal.ts";
import { authoringVerify } from "../src/authoring/verify.ts";
import { cleanup, copyFixture, fixtureDraft, onlyTask, tasksOf, themeRootOf } from "./authoring-fixture.ts";

test("#1415 verification proves examples, behaviors, links, coverage, and the build", async () => {
  const root = copyFixture();
  try {
    const { tasks, site } = await tasksOf(root, { items: ["symbol:parseWidget"] });
    const task = onlyTask(tasks);
    const verification = await authoringVerify({
      root,
      site,
      task,
      draft: fixtureDraft(),
      themeRoot: themeRootOf(root),
      version: "0.2.7",
    });
    assert.equal(verification.verdict, "proved");
    assert.equal(verification.ready, true);
    assert.deepEqual(verification.failures, []);
    assert.deepEqual(verification.checks.map((check) => [check.id, check.status]), [
      ["authoring-citations", "passed"],
      ["authoring-examples", "passed"],
      ["authoring-behaviors", "passed"],
      ["authoring-links", "passed"],
      ["authoring-coverage", "passed"],
      ["authoring-build", "passed"],
    ]);
    assert.match(verification.proof?.hash ?? "", /^[0-9a-f]{64}$/);
    assert.equal(verification.proof?.gapClosed, true);
    assert.equal(verification.remainingUnknowns.length, 0);
    assert.equal(verification.remainingQuestions.length, 1);
  } finally {
    cleanup(root);
  }
});

test("#1415 the proposal is prepared only with a proof and lists the remaining unknowns", async () => {
  const root = copyFixture();
  try {
    const { tasks, site } = await tasksOf(root, { items: ["symbol:parseWidget"] });
    const task = onlyTask(tasks);
    const draft = fixtureDraft();
    const preview = await authoringPreview({ root, site, task, draft, themeRoot: themeRootOf(root), version: "0.2.7" });
    const verification = await authoringVerify({ root, site, task, draft, themeRoot: themeRootOf(root), version: "0.2.7" });
    const proposal = authoringProposalOf(task, verification, draft, preview);
    assert.equal(proposal.noop, false);
    assert.equal(proposal.files.length, 1);
    assert.equal(proposal.files[0]?.path, "docs/reference/parse-widget.md");
    assert.match(proposal.files[0]?.sha256 ?? "", /^[0-9a-f]{64}$/);
    assert.deepEqual(proposal.permissions, { contents: "write", pullRequests: "write", publish: false, merge: false });
    assert.deepEqual(proposal.checks, [
      "authoring-behaviors",
      "authoring-build",
      "authoring-citations",
      "authoring-coverage",
      "authoring-examples",
      "authoring-links",
    ]);
    assert.equal(proposal.proofHash, verification.proof?.hash);
    assert.match(proposal.body, /#### Citations/);
    assert.match(proposal.body, /#### Checks/);
    assert.match(proposal.body, /#### Explicit unknowns/);
    assert.match(proposal.body, /#### Reviewer questions/);
    assert.ok(proposal.body.includes("audience-version"));
    assert.ok(!proposal.body.includes("#### Publish"));
  } finally {
    cleanup(root);
  }
});

test("#1415 a failing example withholds the proof and makes the proposal a no-op", async () => {
  const root = copyFixture();
  try {
    const { tasks, site } = await tasksOf(root, { items: ["symbol:parseWidget"] });
    const task = onlyTask(tasks);
    const draft = fixtureDraft();
    draft.body = draft.body.replace("```output\nbolt\n```", "```output\nwidget\n```");
    const verification = await authoringVerify({ root, site, task, draft, themeRoot: themeRootOf(root), version: "0.2.7" });
    assert.equal(verification.verdict, "failed");
    assert.equal(verification.ready, false);
    assert.equal(verification.proof, undefined);
    assert.equal(verification.checks.find((check) => check.kind === "examples")?.status, "failed");
    assert.ok(verification.failures.some((failure) => failure.includes("printed")));

    const preview = await authoringPreview({ root, site, task, draft, themeRoot: themeRootOf(root), version: "0.2.7" });
    const proposal = authoringProposalOf(task, verification, draft, preview);
    assert.equal(proposal.noop, true);
    assert.deepEqual(proposal.files, []);
    assert.match(proposal.noopReason ?? "", /not proved/);
  } finally {
    cleanup(root);
  }
});

test("#1415 a broken site link fails the link check", async () => {
  const root = copyFixture();
  try {
    const { tasks, site } = await tasksOf(root, { items: ["symbol:parseWidget"] });
    const task = onlyTask(tasks);
    const draft = fixtureDraft();
    draft.body = `${draft.body.replace(/\s+$/u, "")}\n\nSee [the missing page](/does-not-exist/).\n`;
    const verification = await authoringVerify({ root, site, task, draft, themeRoot: themeRootOf(root), version: "0.2.7" });
    assert.equal(verification.verdict, "failed");
    assert.equal(verification.checks.find((check) => check.kind === "links")?.status, "failed");
    assert.match(verification.checks.find((check) => check.kind === "links")?.detail ?? "", /names no page/);
  } finally {
    cleanup(root);
  }
});
