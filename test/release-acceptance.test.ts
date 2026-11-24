/**
 * The release acceptance gate's rules: a scope that names every shipped feature's case, a deferred entry kept out of the
 * changelog, and a release run tied to one candidate and one tarball. The cases themselves run in `scripts/acceptance.ts`
 * from the workflow; these checks prove the gate fails closed before it runs them.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { CASES } from "../scripts/acceptance/cases.ts";
import { digestOf, parseScope, releaseProblems, summaryOf, validateScope, type Scope } from "../scripts/acceptance.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CASE_IDS = CASES.map((entry) => entry.id);
const CHANGELOG = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");

function scope(features: Scope["features"]): Scope {
  return { version: "0.2.4", features };
}

test("the committed scope names a known case for every shipped feature and every case runs", () => {
  const parsed = parseScope(readFileSync(join(ROOT, "release/scope.json"), "utf8"));
  assert.deepEqual(parsed.problems, []);
  assert.ok(parsed.scope);
  assert.deepEqual(validateScope(parsed.scope, CASE_IDS, CHANGELOG), []);
});

test("a feature without a status, or a shipped feature without a case, is refused", () => {
  const missingStatus = scope([{ id: "blog", title: "Blog" } as never]);
  assert.match(validateScope(missingStatus, CASE_IDS, CHANGELOG).join("\n"), /status must be shipped or deferred/);
  const missingCase = scope([{ id: "blog", title: "Blog", status: "shipped" }]);
  assert.match(validateScope(missingCase, CASE_IDS, CHANGELOG).join("\n"), /needs a case id/);
});

test("an unknown case and a case no feature runs are both refused", () => {
  const unknown = scope([{ id: "blog", title: "Blog", status: "shipped", case: "not-a-case" }]);
  assert.match(validateScope(unknown, CASE_IDS, CHANGELOG).join("\n"), /unknown case not-a-case/);
  const partial = scope([{ id: "blog", title: "Blog", status: "shipped", case: "blog" }]);
  const problems = validateScope(partial, CASE_IDS, CHANGELOG);
  assert.ok(problems.some((problem) => /no shipped feature runs it/.test(problem)), "an unrun case fails");
});

test("a deferred feature needs a reason and cannot appear in the release changelog", () => {
  const noReason = scope([{ id: "blog", title: "Blog", status: "deferred" }]);
  assert.match(validateScope(noReason, [], "## Unreleased\n").join("\n"), /needs a reason/);
  const announced = scope([{ id: "blog", title: "Blog routes", status: "deferred", reason: "not ready" }]);
  const problems = validateScope(announced, [], "## Unreleased\n\n- **Blog routes** publish posts.\n");
  assert.match(problems.join("\n"), /appears in the changelog as shipped/);
  const absent = scope([{ id: "blog", title: "Blog routes", status: "deferred", reason: "not ready" }]);
  assert.deepEqual(validateScope(absent, [], "## Unreleased\n\n- **Data feeds** publish.\n"), []);
});

test("a duplicate id is refused", () => {
  const twice = scope([
    { id: "blog", title: "Blog", status: "shipped", case: "blog" },
    { id: "blog", title: "Blog again", status: "shipped", case: "blog" },
  ]);
  assert.match(validateScope(twice, ["blog"], CHANGELOG).join("\n"), /appears twice/);
});

test("a release run needs a candidate, the exact tarball digest, and the release version", () => {
  const dir = mkdtempSync(join(tmpdir(), "acceptance-digest-"));
  try {
    const tarball = join(dir, "package.tgz");
    writeFileSync(tarball, "the one tarball");
    const digest = createHash("sha256").update("the one tarball").digest("hex");
    assert.equal(digestOf(tarball), digest);
    assert.deepEqual(releaseProblems({ release: false, scopeVersion: "0.2.4" }), []);
    const missing = releaseProblems({ release: true, scopeVersion: "0.2.4", packageVersion: "0.2.4" });
    assert.ok(missing.some((problem) => /--candidate/.test(problem)));
    assert.ok(missing.some((problem) => /--digest/.test(problem)));
    assert.ok(missing.some((problem) => /--tarball/.test(problem)));
    const mismatch = releaseProblems({
      release: true,
      candidate: "a".repeat(40),
      digest: "b".repeat(64),
      tarball,
      scopeVersion: "0.2.4",
      packageVersion: "0.2.4",
    });
    assert.match(mismatch.join("\n"), /not the candidate digest/);
    const version = releaseProblems({ release: true, candidate: "a".repeat(40), digest, tarball, scopeVersion: "0.2.4", packageVersion: "0.2.3" });
    assert.match(version.join("\n"), /package\.json is 0\.2\.3/);
    assert.deepEqual(
      releaseProblems({ release: true, candidate: "a".repeat(40), digest, tarball, scopeVersion: "0.2.4", packageVersion: "0.2.4" }),
      [],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the summary names the candidate, the digest, every case, and its result", () => {
  const text = summaryOf({
    scope: scope([{ id: "blog", title: "Blog", status: "shipped", case: "blog" }]),
    candidate: "c".repeat(40),
    digest: "d".repeat(64),
    results: [
      { id: "blog", ok: true },
      { id: "diff", ok: false, detail: "the paragraph edit was not reported" },
    ],
    problems: ["case diff failed: the paragraph edit was not reported"],
  });
  assert.match(text, /Candidate: `c{40}`/);
  assert.match(text, /Tarball SHA-256: `d{64}`/);
  assert.match(text, /\| `blog` \| pass \|/);
  assert.match(text, /\| `diff` \| fail \| the paragraph edit was not reported \|/);
  assert.match(text, /case diff failed/);
});

test("a shipped library feature needs an existing test file, not a guess", () => {
  const known = new Set(["test/tasks-e2e.test.ts"]);
  const missing = scope([{ id: "tasks", title: "Tasks", status: "shipped", test: "test/no-such.test.ts" }]);
  assert.match(validateScope(missing, [], "## Unreleased\n", known).join("\n"), /missing test file/);
  const outside = scope([{ id: "tasks", title: "Tasks", status: "shipped", test: "src/tasks.ts" }]);
  assert.match(validateScope(outside, [], "## Unreleased\n", known).join("\n"), /must name a committed file under test\//);
  const neither = scope([{ id: "tasks", title: "Tasks", status: "shipped" }]);
  assert.match(validateScope(neither, [], "## Unreleased\n", known).join("\n"), /needs a case id or a test file/);
  const present = scope([{ id: "tasks", title: "Tasks", status: "shipped", test: "test/tasks-e2e.test.ts" }]);
  assert.deepEqual(validateScope(present, [], "## Unreleased\n", known), []);
});

test("the committed scope records all 272 release issues with a proof", () => {
  const parsed = parseScope(readFileSync(join(ROOT, "release/scope.json"), "utf8"));
  assert.ok(parsed.scope);
  const mapped = parsed.scope.features.filter((feature) => feature.issue !== undefined);
  assert.equal(mapped.length, 272);
  const files = new Set(readdirSync(join(ROOT, "test")).filter((name) => name.endsWith(".test.ts")).map((name) => `test/${name}`));
  assert.deepEqual(validateScope(parsed.scope, CASE_IDS, CHANGELOG, files), []);
});
