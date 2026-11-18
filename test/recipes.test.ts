/** The workflow recipes parse, and the network recipe's own command works against a fixture and never pushes to the default branch. */
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { runNetwork } from "../src/cli/network.ts";

const DIR = new URL("../docs/recipes/", import.meta.url);

interface Step { readonly run?: string; readonly uses?: string; readonly if?: string }
interface Workflow {
  readonly on: Record<string, unknown>;
  readonly permissions: Record<string, string>;
  readonly concurrency?: { readonly group: string; readonly "cancel-in-progress": boolean };
  readonly jobs: Record<string, { readonly needs?: string | string[]; readonly permissions?: Record<string, string>; readonly steps: Step[] }>;
}

test("every recipe is valid YAML with a trigger and jobs", () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".yml"));
  assert.ok(files.includes("network-update.yml"));
  for (const file of files) {
    const workflow = parse(readFileSync(new URL(file, DIR), "utf8")) as Workflow;
    assert.ok(workflow.on, file);
    assert.ok(Object.keys(workflow.jobs).length > 0, file);
  }
});

test("the network recipe is scheduled, opens a pull request, and never pushes to the main branch", () => {
  const text = readFileSync(new URL("network-update.yml", DIR), "utf8");
  const workflow = parse(text) as Workflow;
  assert.ok("schedule" in workflow.on);
  const runs = Object.values(workflow.jobs).flatMap((job) => job.steps.map((step) => step.run ?? ""));
  assert.ok(runs.some((run) => run.includes("mizzen network update")));
  assert.ok(runs.some((run) => run.includes("gh pr create")));
  for (const run of runs) {
    for (const line of run.split("\n").filter((l) => l.includes("git push"))) {
      assert.match(line, /origin "\$branch"/, line);
      assert.doesNotMatch(line, /\b(main|master)\b/, line);
    }
  }
});

test("the recipe's update command writes a lock in a fixture, and the lock then compares equal", async () => {
  const workflow = parse(readFileSync(new URL("network-update.yml", DIR), "utf8")) as Workflow;
  const step = Object.values(workflow.jobs).flatMap((job) => job.steps).find((s) => s.run?.includes("mizzen network update"));
  const args = step!.run!.split("|")[0]!.trim().split(/\s+/).slice(2); // npx mizzen network update -> network update
  assert.deepEqual(args.slice(0, 2), ["network", "update"]);

  const root = mkdtempSync(join(tmpdir(), "mizzen-recipe-"));
  const shared = join(root, "org");
  cpSync(new URL("../test/fixtures/network/org/", import.meta.url), shared, { recursive: true });
  const site = join(root, "site");
  cpSync(new URL("../test/fixtures/network/site/", import.meta.url), site, { recursive: true });
  writeFileSync(join(site, "mizzen.yml"), `title: Demo\nnetwork:\n  source: ${join(shared, "network.json")}\n  project: docs\n`);

  const out: string[] = [];
  const io = { log: (m: string) => out.push(m), error: (m: string) => out.push(`error: ${m}`) };
  assert.equal(await runNetwork([...args.slice(1), site], io), 0, out.join("\n"));
  assert.ok(out.some((l) => l.includes("wrote network.lock.json")));
  assert.equal(await runNetwork([...args.slice(1), site, "--check"], io), 0);
});

test("the refresh recipe separates read and write jobs, serializes runs, and creates one review pull request", () => {
  const text = readFileSync(new URL("refresh-data.yml", DIR), "utf8");
  const workflow = parse(text) as Workflow;
  assert.ok("schedule" in workflow.on);
  assert.ok("workflow_dispatch" in workflow.on);
  assert.match(text, /inputs\.collections/, "the manual filter is passed to the command");
  assert.ok(workflow.concurrency);
  assert.match(workflow.concurrency.group, /\$\{\{ github\.repository \}\}/);
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.deepEqual(workflow.jobs.refresh!.permissions, { contents: "read" });
  assert.deepEqual(workflow.jobs.build!.permissions, { contents: "read" });
  assert.deepEqual(workflow.jobs.propose!.permissions, { contents: "write", "pull-requests": "write" });

  const refreshRuns = workflow.jobs.refresh!.steps.map((step) => step.run ?? "");
  assert.ok(refreshRuns.some((run) => run.includes("mizzen data refresh") && run.includes("--collections")));
  assert.ok(refreshRuns.some((run) => run.includes("mizzen inputs export")));
  assert.ok(workflow.jobs.refresh!.steps.some((step) => step.uses?.includes("upload-artifact") && step.if === "always()"));

  const buildRuns = workflow.jobs.build!.steps.map((step) => step.run ?? "");
  assert.ok(buildRuns.some((run) => run.includes("mizzen build")));
  assert.ok(buildRuns.some((run) => run.includes("mizzen inputs import")));
  assert.ok(buildRuns.some((run) => run.includes("mizzen diff")));

  const proposeRuns = workflow.jobs.propose!.steps.map((step) => step.run ?? "");
  assert.ok(proposeRuns.some((run) => run.includes("git add -- mizzen.lock.json") && run.includes(".mizzen/data")));
  assert.ok(proposeRuns.some((run) => run.includes("gh pr create") && run.includes("gh pr edit")));
  for (const run of proposeRuns) {
    for (const line of run.split("\n").filter((entry) => entry.includes("git push"))) {
      assert.doesNotMatch(line, /\b(main|master)\b/, line);
    }
  }
});

test("the rebuild-daily recipe is scheduled, builds as of today, and publishes only a new hash", () => {
  const text = readFileSync(new URL("rebuild-daily.yml", DIR), "utf8");
  const workflow = parse(text) as Workflow;
  assert.ok("schedule" in workflow.on);
  assert.ok("workflow_dispatch" in workflow.on);
  const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);
  const runs = steps.map((step) => step.run ?? "");
  assert.ok(runs.some((run) => run.includes("mizzen build") && run.includes("--as-of today")));
  assert.ok(runs.some((run) => run.includes("GITHUB_STEP_SUMMARY") && run.includes("manifest.build.hash") && run.includes("asOf")));
  const publish = steps.filter((step) => ["upload-pages-artifact", "deploy-pages"].some((name) => step.uses?.includes(name)));
  assert.equal(publish.length, 2);
  for (const step of publish) {
    assert.match(step.if ?? "", /steps\.build\.outputs\.previous != steps\.build\.outputs\.hash/, step.uses ?? "publish");
  }
});
