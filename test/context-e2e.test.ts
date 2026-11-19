/**
 * #1136: a real task compiles from a fixture site within 12,000 tokens, and removing the evidence it
 * needs turns the pack incomplete with a precise request instead of a confident answer.
 */
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { TaskContract } from "../src/contracts/index.ts";
import { readBlocksLock } from "../src/blocks/lock.ts";
import { compileTaskContext } from "../src/context/compile.ts";
import { buildModel } from "../src/model/build.ts";
import { parseTaskContract } from "../src/tasks/contract.ts";

const FIXTURE = fileURLToPath(new URL("../fixtures/context-compiler", import.meta.url));

/** The fixture's task contract, parsed the way the CLI parses it. */
function contract(): TaskContract {
  const parsed = parseTaskContract(JSON.parse(readFileSync(join(FIXTURE, "task.json"), "utf8")));
  assert.ok(parsed.contract !== undefined, parsed.problems?.map((problem) => problem.message).join(" "));
  return parsed.contract;
}

test("the fixture provides every required evidence within 12,000 tokens", async () => {
  const { site } = await buildModel(FIXTURE);
  const { lock } = await readBlocksLock(FIXTURE);
  const compiled = await compileTaskContext(site, contract(), { lock });
  assert.ok(compiled.accounting.used <= 12_000, `${compiled.accounting.used} tokens`);
  assert.equal(compiled.answerability.complete, true);
  assert.deepEqual(compiled.answerability.shortages, []);
  assert.deepEqual(compiled.requests, []);
  assert.ok(compiled.fragments.some((fragment) => fragment.source.block === "install-steps"));
});

test("removing the install steps makes the pack incomplete and names the missing evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "context-compiler-"));
  try {
    cpSync(FIXTURE, root, { recursive: true });
    const page = join(root, "guide/install.md");
    const text = readFileSync(page, "utf8");
    writeFileSync(
      page,
      text.slice(0, text.indexOf("## Run the installer")) + text.slice(text.indexOf("## Troubleshooting")),
    );
    const { site } = await buildModel(root);
    const { lock } = await readBlocksLock(root);
    const compiled = await compileTaskContext(site, contract(), { lock });
    assert.equal(compiled.answerability.complete, false);
    assert.ok(compiled.answerability.shortages.includes("install-steps"));
    assert.ok(compiled.removedReferences.includes("install-steps"));
    const request = compiled.requests.find((entry) => entry.ref === "install-steps");
    assert.ok(request, compiled.requests.map((entry) => entry.ref).join(", "));
    assert.match(request.action, /install-steps/);
    assert.equal(compiled.fragments.some((fragment) => fragment.source.block === "install-steps"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
