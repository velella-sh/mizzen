import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { authoringExportOf } from "../src/authoring/export.ts";
import { parseAuthoringDraft, validateAuthoringDraft } from "../src/authoring/draft.ts";
import { authoringPreview } from "../src/authoring/preview.ts";
import { authoringProposalOf } from "../src/authoring/proposal.ts";
import { authoringVerify } from "../src/authoring/verify.ts";
import { writeAuthoringDraft } from "../src/authoring/write.ts";
import { build } from "../src/pipeline/build.ts";
import { approvalFor, cleanup, copyFixture, fixtureDraft, onlyTask, reportOf, tasksOf, themeRootOf, writePolicy } from "./authoring-fixture.ts";

test("#1416 an undocumented API goes from gap to citation, example, proposal, and closed coverage", async () => {
  const root = copyFixture();
  try {
    const { site, report: before } = await reportOf(root);
    const initial = before.matches.find((match) => match.item === "symbol:parseWidget");
    assert.equal(initial?.state, "missing", "the fixture starts with the API undocumented");
    assert.ok(before.gaps.some((gap) => gap.item === "symbol:parseWidget"));

    const { tasks } = await tasksOf(root, { items: ["symbol:parseWidget"] });
    const task = onlyTask(tasks);
    const exported = await authoringExportOf({ task, site, root });
    assert.deepEqual(exported.problems, []);
    assert.ok((exported.exported?.pack.markdown.length ?? 0) > 0);

    const parsed = parseAuthoringDraft(fixtureDraft());
    assert.deepEqual(parsed.problems, []);
    const draft = parsed.draft!;
    const validation = validateAuthoringDraft(draft, task, site);
    assert.equal(validation.ok, true, JSON.stringify(validation.problems));
    assert.equal(validation.uncited.length, 0);
    assert.ok(validation.citations.length > 0);

    const preview = await authoringPreview({ root, site, task, draft, themeRoot: themeRootOf(root), version: "0.2.7" });
    assert.ok(preview.page !== undefined);
    assert.match(preview.page!.html, /returns the lowercase widget id/);
    assert.equal(preview.write, "requires-approval");

    const verification = await authoringVerify({ root, site, task, draft, themeRoot: themeRootOf(root), version: "0.2.7" });
    assert.equal(verification.verdict, "proved", verification.failures.join(" "));
    assert.equal(verification.proof?.gapClosed, true);

    const proposal = authoringProposalOf(task, verification, draft, preview);
    assert.equal(proposal.noop, false);
    assert.deepEqual(proposal.files.map((file) => file.path), ["docs/reference/parse-widget.md"]);
    assert.match(proposal.body, /Closes|authoring|Proof/);
    assert.ok(proposal.remainingQuestions.some((question) => question.id === "audience-version"));

    const policy = writePolicy();
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
    const page = join(root, "docs/reference/parse-widget.md");
    assert.ok(existsSync(page));
    assert.equal(readFileSync(page, "utf8"), proposal.files[0]?.content);

    // The simulated merge: the page is in the site now, so the next surface report has no gap for it.
    const { site: afterSite, report: after } = await reportOf(root);
    assert.equal(after.matches.find((match) => match.item === "symbol:parseWidget")?.state, "complete");
    assert.ok(!after.gaps.some((gap) => gap.item === "symbol:parseWidget"));
    assert.ok(after.coverage.counts.documented > before.coverage.counts.documented);

    const out = join(root, "_site");
    const built = await build({ root, out, themeRoot: themeRootOf(root), defaultLayout: "doc" });
    assert.deepEqual(built.diagnostics.filter((diagnostic) => diagnostic.severity === "error"), []);
    assert.ok(existsSync(join(out, "reference/parse-widget/index.html")));
    assert.ok(afterSite.pages.some((entry) => entry.source.file === "docs/reference/parse-widget.md"));
  } finally {
    cleanup(root);
  }
});
