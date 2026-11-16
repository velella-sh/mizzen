/** The stale-docs workflow recipe parses, only advises, and its list step works on a fixture. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
import { run, site } from "./helpers-stale.ts";

const TEXT = readFileSync(new URL("../recipes/stale-docs.yml", import.meta.url), "utf8");

interface Step { readonly run?: string; readonly uses?: string }
interface Workflow {
  readonly on: Record<string, unknown>;
  readonly env: Record<string, string>;
  readonly jobs: Record<string, { readonly if?: string; readonly steps: Step[] }>;
}
const workflow = parse(TEXT) as Workflow;

test("the recipe runs on pull requests, never fails them, and skips the comment without a match", () => {
  assert.ok("pull_request" in workflow.on);
  const runs = Object.values(workflow.jobs).flatMap((job) => job.steps.map((s) => s.run ?? "")).join("\n");
  assert.match(runs, /mizzen stale --git-diff/);
  assert.match(runs, /\|\| true/);
  assert.doesNotMatch(runs, /--fail|exit 1/);
  assert.match(workflow.jobs.comment!.if!, /found == 'true'/);
  assert.match(TEXT, /<!-- mizzen-stale-docs -->/);
});

test("the list step's output formats as a Markdown list on the fixture", async () => {
  const root = site({
    "mizzen.yml": "title: T\n",
    "a.md": "---\ncovers: [src/*.ts]\n---\n# A\n",
    "src/x.ts": "x",
  });
  const listed = await run(["stale", "--site", root, "--changed", "src/x.ts"]);
  const md = execFileSync("awk", [workflow.env.FORMAT_AWK!], { input: `${listed.logs.join("\n")}\n` }).toString();
  assert.equal(md, "- `a.md`\n  - `src/x.ts`\n");
});
