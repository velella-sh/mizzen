import assert from "node:assert/strict";
import { test } from "node:test";
import { authoringExportOf } from "../src/authoring/export.ts";
import { parseAuthoringDraft } from "../src/authoring/draft.ts";
import { cleanup, copyFixture, fixtureDraft, onlyTask, tasksOf } from "./authoring-fixture.ts";

test("#1410 a task exports with its context pack and no model output", async () => {
  const root = copyFixture();
  try {
    const { tasks, site } = await tasksOf(root, { items: ["symbol:parseWidget"] });
    const task = onlyTask(tasks);
    const first = await authoringExportOf({ task, site, root });
    assert.deepEqual(first.problems, []);
    assert.ok(first.exported !== undefined);
    const exported = first.exported!;
    assert.equal(exported.version, 1);
    assert.equal(exported.task.item, "symbol:parseWidget");
    assert.equal(exported.pack.accounting.requested, 12000);
    assert.ok(exported.pack.accounting.used > 0);
    assert.ok(exported.pack.markdown.includes("Task context"));
    assert.ok(!exported.pack.markdown.includes(root), "the pack leaks no absolute path");
    assert.ok(exported.pack.fragments.length > 0, "the pack carries sourced fragments");
    assert.ok(exported.pack.fragments.every((fragment) => fragment.source.file !== "" && fragment.source.span !== ""));
    assert.ok(
      exported.pack.evidence.some((entry) => entry.kind === "surface" && entry.file === "src/index.ts" && (entry.content ?? "").includes("parseWidget")),
      "the declaration source is in the evidence",
    );
    assert.ok(
      exported.pack.evidence.some((entry) => entry.kind === "source" && entry.ref === "src/index.ts:6"),
      "the declaration span is in the evidence",
    );
    assert.ok(
      exported.pack.evidence.some((entry) => entry.kind === "test" && entry.file === "tests/parse-widget.test.mjs"),
      "the test is in the evidence",
    );
    assert.ok(
      exported.pack.requests.some((request) => request.kind === "evidence" || request.kind === "scope"),
      "a missing page is named as a request, not invented",
    );

    const second = await authoringExportOf({ task, site, root });
    assert.deepEqual(second.exported, exported, "the same task and site give the same export");

    // The draft is validated through the same public parser an external agent's file goes through.
    const parsed = parseAuthoringDraft(fixtureDraft());
    assert.deepEqual(parsed.problems, []);
    assert.equal(parsed.draft?.item, exported.task.item);
  } finally {
    cleanup(root);
  }
});
