import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { authoringPreview } from "../src/authoring/preview.ts";
import { writeAuthoringDraft } from "../src/authoring/write.ts";
import { approvalFor, cleanup, copyFixture, fixtureDraft, onlyTask, tasksOf, themeRootOf, writePolicy } from "./authoring-fixture.ts";

test("#1414 the preview shows the built page, its diff, and every citation", async () => {
  const root = copyFixture();
  try {
    const { tasks, site } = await tasksOf(root, { items: ["symbol:parseWidget"] });
    const task = onlyTask(tasks);
    const preview = await authoringPreview({
      root,
      site,
      task,
      draft: fixtureDraft(),
      themeRoot: themeRootOf(root),
      version: "0.2.7",
    });
    assert.equal(preview.write, "requires-approval");
    assert.match(preview.writeReason, /a person must approve/);
    assert.equal(preview.uncited.length, 0);
    assert.equal(preview.citations.length, 7);
    assert.ok(preview.page !== undefined, "the page is built");
    assert.match(preview.page!.html, /parseWidget/);
    assert.match(preview.page!.html, /returns the lowercase widget id/);
    assert.match(preview.diff, /\+# parseWidget \{#parse-widget\}/);
    assert.deepEqual(preview.problems, []);
  } finally {
    cleanup(root);
  }
});

test("#1414 a policy decides the write gate and an approval unlocks it", async () => {
  const root = copyFixture();
  try {
    const { tasks, site } = await tasksOf(root, { items: ["symbol:parseWidget"] });
    const task = onlyTask(tasks);
    const policy = writePolicy();
    const draft = fixtureDraft();
    const unapproved = await authoringPreview({
      root,
      site,
      task,
      draft,
      themeRoot: themeRootOf(root),
      policy,
      version: "0.2.7",
    });
    assert.equal(unapproved.write, "requires-approval");
    assert.match(unapproved.writeReason, /requires an approval/);

    const approved = await authoringPreview({
      root,
      site,
      task,
      draft,
      themeRoot: themeRootOf(root),
      policy,
      approval: approvalFor(policy, task.task.snapshot.id),
      version: "0.2.7",
    });
    assert.equal(approved.write, "allowed");

    const deniedPolicy = writePolicy({ capabilities: { read: true, write: false, execute: false, network: false, publish: false } });
    const denied = await authoringPreview({
      root,
      site,
      task,
      draft,
      themeRoot: themeRootOf(root),
      policy: deniedPolicy,
      version: "0.2.7",
    });
    assert.equal(denied.write, "denied");
  } finally {
    cleanup(root);
  }
});

test("#1414 an uncited claim blocks the preview before the page is built", async () => {
  const root = copyFixture();
  try {
    const { tasks, site } = await tasksOf(root, { items: ["symbol:parseWidget"] });
    const task = onlyTask(tasks);
    const draft = fixtureDraft();
    draft.body = draft.body.replace(" [[surface:symbol:parseWidget]]", "");
    const preview = await authoringPreview({
      root,
      site,
      task,
      draft,
      themeRoot: themeRootOf(root),
      version: "0.2.7",
    });
    assert.equal(preview.page, undefined);
    assert.equal(preview.write, "denied");
    assert.equal(preview.uncited.length, 1);
    assert.ok(preview.problems.some((problem) => problem.code === "authoring.uncited-claim"));
  } finally {
    cleanup(root);
  }
});

test("#1414 writing needs the approval and leaves the tree untouched without it", async () => {
  const root = copyFixture();
  try {
    const { tasks, site } = await tasksOf(root, { items: ["symbol:parseWidget"] });
    const task = onlyTask(tasks);
    const policy = writePolicy();
    const draft = fixtureDraft();
    const page = join(root, task.location.source);

    const refused = await writeAuthoringDraft({
      root,
      site,
      task,
      draft,
      themeRoot: themeRootOf(root),
      policy,
      version: "0.2.7",
    });
    assert.equal(refused.written, false);
    assert.equal(refused.gate, "requires-approval");
    assert.ok(!existsSync(page), "an unapproved write changes nothing");

    const written = await writeAuthoringDraft({
      root,
      site,
      task,
      draft,
      themeRoot: themeRootOf(root),
      policy,
      approval: approvalFor(policy, task.task.snapshot.id),
      version: "0.2.7",
    });
    assert.equal(written.written, true);
    assert.equal(written.path, "docs/reference/parse-widget.md");
    assert.ok(existsSync(page));
    assert.match(readFileSync(page, "utf8"), /\{#parse-widget\}/);
  } finally {
    cleanup(root);
  }
});
