import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

interface Step {
  readonly run?: string;
  readonly uses?: string;
  readonly with?: Record<string, unknown>;
}
interface Job {
  readonly if?: string;
  readonly needs?: string[];
  readonly uses?: string;
  readonly with?: Record<string, unknown>;
  readonly strategy?: { readonly matrix: { readonly shard: number[] } };
  readonly steps?: Step[];
}
interface Workflow {
  readonly on: Record<string, unknown>;
  readonly concurrency?: { readonly group: string; readonly "cancel-in-progress": string };
  readonly jobs: Record<string, Job>;
}

const workflow = (name: string): Workflow =>
  parse(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8")) as Workflow;

test("PR checks cover the full suite in two shards and cancel only superseded PR runs", () => {
  const ci = workflow("ci");
  assert.deepEqual(ci.jobs.test!.strategy!.matrix.shard, [1, 2]);
  assert.ok(ci.jobs.test!.steps!.some((step) => step.run === 'node --test --test-concurrency=4 --test-shard=${{ matrix.shard }}/2 "test/**/*.test.ts"'));
  assert.equal(ci.concurrency!["cancel-in-progress"], "${{ github.event_name == 'pull_request' }}");
  assert.match(ci.concurrency!.group, /github\.run_id/);
  assert.deepEqual(ci.jobs["ci-required"]!.needs, ["static", "test", "package", "social-images"]);
  assert.equal(ci.jobs["ci-required"]!.if, "always()");
  assert.equal(ci.jobs.coverage!.if, "github.event_name == 'push' && github.ref == 'refs/heads/main'");
  assert.ok(!("bench" in ci.jobs));
});

test("the required check refuses failed, cancelled, or skipped dependencies", () => {
  const gate = workflow("ci").jobs["ci-required"]!;
  const command = gate.steps![0]!.run!;
  const script = /^node -e '(.+)'$/.exec(command.trim())![1]!;
  for (const result of ["success", "failure", "cancelled", "skipped"]) {
    const results = Object.fromEntries(gate.needs!.map((name) => [name, { result: "success" }]));
    results.test = { result };
    const child = spawnSync(process.execPath, ["-e", script], {
      env: { ...process.env, RESULTS: JSON.stringify(results) },
      encoding: "utf8",
    });
    assert.equal(child.status, result === "success" ? 0 : 1, child.stderr);
  }
});

test("full benchmarks are scheduled, manual, and gate publishing at the exact release ref", () => {
  const bench = workflow("benchmark");
  assert.deepEqual(Object.keys(bench.on).sort(), ["schedule", "workflow_call", "workflow_dispatch"]);
  assert.ok(bench.jobs.bench!.steps!.some((step) => step.run === "node scripts/bench-data.ts --check bench/budget.json > bench-data.json"));
  assert.equal(bench.jobs.bench!.steps![0]!.with!.ref, "${{ inputs.ref || github.sha }}");
  const release = workflow("release");
  assert.deepEqual(release.jobs.publish!.needs, ["verify", "performance"]);
  assert.equal(release.jobs.performance!.uses, "./.github/workflows/benchmark.yml");
  assert.equal(release.jobs.performance!.needs, undefined, "benchmark runs alongside verification");
  assert.equal(release.jobs.performance!.with!.ref, "refs/tags/${{ github.event.release.tag_name || inputs.tag || github.ref_name }}");
  assert.ok(release.jobs.verify!.steps!.some((step) => step.run === "npm run test:coverage"));
  const githubRelease = release.jobs["github-release"]!;
  assert.deepEqual(githubRelease.needs, ["verify", "publish"]);
  assert.match(githubRelease.if!, /needs\.publish\.result == 'success'/);
  assert.match(githubRelease.if!, /needs\.verify\.outputs\.published == 'true'/);
  assert.match(githubRelease.steps![0]!.run!, /gh release create "\$TAG" --verify-tag .*--generate-notes/);
  assert.match(githubRelease.steps![0]!.run!, /--prerelease/);
  assert.match(githubRelease.steps![0]!.run!, /--latest=false/);
  assert.doesNotMatch(githubRelease.steps![0]!.run!, /--latest(?:\s|$)/);
});

test("the release tests, checksums, and publishes one tarball", () => {
  const release = workflow("release");
  const verify = release.jobs.verify!;
  const runs = verify.steps!.map((step) => step.run ?? "").join("\n");
  assert.match(runs, /npm pack --silent --pack-destination "\$RUNNER_TEMP\/dist"/);
  assert.match(runs, /sha256sum \.\/\*\.tgz > SHA256SUMS/);
  const smoke = verify.steps!.find((step) => step.run?.includes("smoke-package.sh"))!;
  assert.match(smoke.run!, /--mizzen-tarball "\$RUNNER_TEMP"\/dist/);
  assert.match(smoke.run!, /--lateen-tarball "\$RUNNER_TEMP"\/theme/);
  const compat = verify.steps!.find((step) => step.run?.includes("release-compat.ts"))!;
  assert.match(compat.run!, /--candidate "\$RUNNER_TEMP"\/dist/);
  assert.ok(release.jobs.publish!.steps!.some((step) => /sha256sum -c SHA256SUMS/.test(step.run ?? "")));
});

test("nightly failures notify without executing code or artifacts from the failed run", () => {
  const alert = workflow("benchmark-alert");
  assert.ok("workflow_run" in alert.on);
  assert.match(alert.jobs.notify!.if!, /event == 'schedule'/);
  assert.match(alert.jobs.notify!.if!, /conclusion != 'success'/);
  assert.ok(alert.jobs.notify!.steps!.every((step) => !step.uses));
  assert.match(alert.jobs.notify!.steps![0]!.run!, /gh issue create/);
  assert.match(alert.jobs.notify!.steps![0]!.run!, /gh issue comment/);
});

test("engine checks test Lateen main, while a release tests its pinned theme, with npm download caching", () => {
  for (const name of ["ci", "benchmark", "release"]) {
    for (const job of Object.values(workflow(name).jobs)) {
      for (const step of job.steps ?? []) {
        if (step.with?.repository === "velella-sh/lateen") {
          assert.equal(step.with.ref, name === "release" ? "v${{ env.LATEEN_VERSION }}" : "main");
        }
        if (step.uses?.startsWith("actions/setup-node@") && step.with?.["registry-url"] === undefined) {
          assert.equal(step.with?.cache, "npm", name);
        }
      }
    }
  }
});
