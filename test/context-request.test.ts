/**
 * #1121: a task contract becomes one structured context request.
 *
 * The goal is the ranking sentence, every scope reference is an include hint, page and file
 * references are required evidence, acceptance statements contribute their inline references, and
 * the change type is chosen by an explicit option or a fixed keyword rule. Constraints and the
 * budget come from the task and the caller, never from a model or a clock.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { changeTypeOf, requestForTask } from "../src/context/request.ts";
import { task } from "./context-fixture.ts";

test("task goal and scope become the request query and hints", () => {
  const converted = requestForTask(
    task({
      scope: {
        pages: ["/guide/install/", "guide/install.md"],
        blocks: ["install-steps"],
        collections: ["blog"],
        symbols: ["build"],
        files: ["guide/setup.md"],
      },
    }),
  );
  assert.ok("request" in converted);
  assert.equal(converted.request.task.goal, "Update the install guide for Node 24");
  assert.equal(converted.request.task.kind, "implement");
  assert.deepEqual(converted.request.include, [
    "/guide/install/",
    "guide/install.md",
    "install-steps",
    "blog",
    "build",
    "guide/setup.md",
  ]);
  assert.deepEqual(converted.request.requiredEvidence.refs, ["/guide/install/", "guide/install.md", "guide/setup.md"]);
  assert.equal(converted.request.budget.maxTokens, 4000);
  assert.equal(converted.request.requiredEvidence.source, true);
  assert.equal(converted.request.requiredEvidence.dependencies, true);
});

test("an acceptance statement contributes its inline references to the query", () => {
  const converted = requestForTask(
    task({
      acceptance: [
        { id: "block", statement: "The `install-steps` block names Node 24.", review: true },
        { id: "file", statement: "`guide/install.md` documents the new flag.", review: true },
      ],
    }),
  );
  assert.ok("request" in converted);
  assert.ok(converted.request.include.includes("install-steps"));
  assert.ok(converted.request.include.includes("guide/install.md"));
  assert.deepEqual(converted.evidence.map((entry) => entry.criterion), ["block", "file"]);
  assert.deepEqual(converted.evidence[0]?.refs, ["install-steps"]);
});

test("the change type is explicit, keyword-derived, or review-only", () => {
  assert.equal(changeTypeOf(task({ goal: "Something" }), "debug"), "debug");
  assert.equal(changeTypeOf(task({ goal: "Debug the failed deploy" })), "debug");
  assert.equal(changeTypeOf(task({ goal: "Migrate to Node 24" })), "migrate");
  assert.equal(changeTypeOf(task({ goal: "Update the install guide" })), "implement");
  assert.equal(
    changeTypeOf(task({ goal: "The release", acceptance: [{ id: "r", statement: "A person looks", review: true }] })),
    "review",
  );
  assert.equal(changeTypeOf(task({ goal: "The release" })), "other");
});

test("locale and version constraints reach the request, lower-cased and parsed", () => {
  const converted = requestForTask(task(), { locale: "EN-us", version: { min: "v1", max: "v2" } });
  assert.ok("request" in converted);
  assert.equal(converted.request.constraints.locale, "en-us");
  assert.deepEqual(converted.request.constraints.version, { min: "v1", max: "v2" });
});

test("a reserve at or above the budget is clamped below it", () => {
  const converted = requestForTask(task({ budget: { contextTokens: 100, toolCalls: 1, timeMs: 1 } }), {
    reservedTokens: 500,
  });
  assert.ok("request" in converted);
  assert.equal(converted.request.budget.reservedTokens, 99);
});
