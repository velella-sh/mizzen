import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildModel } from "../src/model/build.ts";
import { parseTaskContract } from "../src/tasks/contract.ts";
import { compileMaintenanceContext } from "../src/maintenance/context.ts";

const FIXTURE = fileURLToPath(new URL("../fixtures/context-compiler", import.meta.url));

function task(acceptance: Record<string, unknown> = { id: "page", statement: "The install page names the current installer.", check: "site" }) {
  const raw = JSON.parse(readFileSync(`${FIXTURE}/task.json`, "utf8")) as Record<string, unknown>;
  raw.scope = {
    pages: ["/guide/install/"],
    blocks: [],
    collections: [],
    symbols: [],
    files: ["guide/install.md"],
  };
  raw.acceptance = [acceptance];
  const parsed = parseTaskContract(raw);
  assert.ok(parsed.contract !== undefined, parsed.problems.map((problem) => problem.message).join(" "));
  return parsed.contract;
}

test("maintenance context names changed sources, affected pages, checks, and every omission", async () => {
  const { site } = await buildModel(FIXTURE);
  const compiled = await compileMaintenanceContext(site, task(), { maxTokens: 400 });

  assert.equal(compiled.version, 1);
  assert.deepEqual(compiled.changedSources, ["guide/install.md"]);
  assert.deepEqual(compiled.affectedPages, ["/guide/install/"]);
  assert.deepEqual(compiled.requiredChecks, ["site"]);
  assert.ok(compiled.accounting.used <= 400, `${compiled.accounting.used} tokens`);
  assert.match(compiled.markdown, /install/i);
  assert.ok(compiled.omissions.length > 0, "a 400-token budget leaves something out");
  for (const omission of compiled.omissions) {
    assert.ok(["budget", "permission", "scope", "irrelevance"].includes(omission.reason));
    assert.notEqual(omission.detail.trim(), "");
  }
  assert.equal(compiled.compiled.omitted.length, compiled.omissions.length);
});

test("an ample budget includes the required evidence with no omission of it", async () => {
  const { site } = await buildModel(FIXTURE);
  const compiled = await compileMaintenanceContext(
    site,
    task({ id: "page", statement: "A person reads the updated install page.", review: true }),
    { maxTokens: 12_000 },
  );
  assert.deepEqual(compiled.requiredChecks, []);
  assert.equal(compiled.answerability.complete, true);
  assert.ok(compiled.compiled.fragments.some((fragment) => fragment.source.file === "guide/install.md"));
});
