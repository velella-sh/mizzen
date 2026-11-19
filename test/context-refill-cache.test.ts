/**
 * #1132-#1134: incremental refill, pack diff, and deterministic cache/refresh.
 *
 * A refill with unchanged docs and task inputs is empty; a changed build returns only fragments
 * whose bytes changed, with the dependency reason. A diff names added, removed, and changed
 * fragments by id and hash and never copies either pack's text. A cache key that repeats returns
 * the same bytes as a full build, and invalidation follows the files a pack read, so an unrelated
 * page edit does not rebuild every pack.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compileTaskContext,
  contextJson,
  diffContextPacks,
  invalidatedContexts,
  refillContext,
  refreshContext,
} from "../src/context/compile.ts";
import { blockPage, page, site, task } from "./context-fixture.ts";

const INSTALL = "# Install\n\nRun the installer.\n\n## Steps\n\nRun the installer once.\n\n## Troubleshooting\n\nRead the log.\n";
const DEPLOY = "# Deploy\n\nShip the built folder.\n\n## Rollback\n\nRestore the release.\n";

function model(install = INSTALL): ReturnType<typeof site> {
  return site([
    blockPage("/guide/install/", install, "Install", "guide/install.md", [["install-steps", 5]]),
    page("/guide/deploy/", DEPLOY, "Deploy", "guide/deploy.md"),
  ]);
}

function installTask() {
  return task({
    goal: "install",
    scope: { pages: ["/guide/install/"], blocks: [], collections: [], symbols: [], files: [] },
  });
}

test("an unchanged build and task refill nothing and reuse the identical bytes", async () => {
  const first = await compileTaskContext(model(), installTask(), { maxTokens: 4000 });
  const second = await compileTaskContext(model(), installTask(), { maxTokens: 4000 });
  const refill = refillContext(first, second);
  assert.equal(refill.unchanged, true);
  assert.deepEqual(refill.fragments, []);
  assert.deepEqual(refill.reasons, []);

  const refreshed = refreshContext(first, second);
  assert.equal(refreshed.reused, true);
  assert.equal(contextJson(refreshed.context), contextJson(second));
  assert.equal(first.cache.key, second.cache.key);
});

test("a changed build refills only the fragments whose bytes changed, with reasons", async () => {
  const first = await compileTaskContext(model(), installTask(), { maxTokens: 4000 });
  const changed = INSTALL.replace("Run the installer once.", "Run the installer twice.");
  const second = await compileTaskContext(model(changed), installTask(), { maxTokens: 4000 });
  const refill = refillContext(first, second);
  assert.equal(refill.unchanged, false);
  assert.ok(refill.fragments.length > 0);
  assert.ok(refill.fragments.every((fragment) => !first.fragments.some((old) => old.id === fragment.id && old.content === fragment.content)));
  assert.ok(refill.reasons.every((reason) => reason.reason !== ""));
  assert.notEqual(first.cache.key, second.cache.key);
});

test("a diff reports added, removed, and changed fragments without copying text", async () => {
  const before = await compileTaskContext(model(INSTALL), installTask(), { maxTokens: 4000 });
  const after = await compileTaskContext(
    model(`${INSTALL.replace("Run the installer once.", "Run the installer twice.")}## Verify\n\nCheck the version.\n`),
    installTask(),
    { maxTokens: 4000 },
  );
  const diff = diffContextPacks(before, after);
  assert.ok(diff.changed.some((entry) => entry.title === "Steps"));
  assert.ok(diff.added.some((entry) => entry.title === "Verify"));
  assert.ok(diffContextPacks(after, before).removed.some((entry) => entry.title === "Verify"));
  assert.ok([...diff.added, ...diff.changed, ...diff.removed].every((entry) => entry.reasons.includes("snapshot")));
  const text = JSON.stringify(diff);
  assert.doesNotMatch(text, /Run the installer|Read the log|Check the version/);
});

test("only packs whose dependencies include the changed file are invalidated", async () => {
  const install = await compileTaskContext(model(), installTask(), { maxTokens: 4000 });
  const deploy = await compileTaskContext(
    model(),
    task({ goal: "deploy", scope: { pages: ["/guide/deploy/"], blocks: [], collections: [], symbols: [], files: [] } }),
    { maxTokens: 4000 },
  );
  const keys = invalidatedContexts([install.cache, deploy.cache], ["guide/deploy.md"]);
  assert.deepEqual(keys, [deploy.cache.key]);
  const both = invalidatedContexts([install.cache, deploy.cache], ["guide/install.md", "guide/deploy.md"]);
  assert.deepEqual(both, [install.cache.key, deploy.cache.key].sort());
});
