import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readEvalCase } from "../src/evals/case.ts";
import { liveRunner } from "../examples/evals/live-runner.ts";

const SUITE = fileURLToPath(new URL("../fixtures/evals", import.meta.url));
const PACKAGE = fileURLToPath(new URL("..", import.meta.url));

/** A shipped case, so the adapter sees the real request shape. */
async function shippedCase() {
  const read = await readEvalCase(join(SUITE, "cases/discovery.json"));
  assert.ok(read.case);
  return read.case;
}

test("the live adapter starts the configured program and parses its output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mizzen-eval-live-"));
  try {
    const agent = join(dir, "agent.mjs");
    writeFileSync(
      agent,
      `let input = "";\nprocess.stdin.setEncoding("utf8");\nprocess.stdin.on("data", (chunk) => { input += chunk; });\nprocess.stdin.on("end", () => {\n  const request = JSON.parse(input);\n  process.stdout.write(JSON.stringify({\n    pages: request.case.expected.pages,\n    symbols: [],\n    toolCalls: [{ name: "context", version: "1", ok: true }],\n    usage: { inputTokens: 10, outputTokens: 2 },\n  }));\n});\n`,
    );
    const runner = liveRunner({ command: process.execPath, args: [agent], model: "example-model" });
    assert.equal(runner.id, "live");
    assert.equal(runner.model, "example-model");
    const output = await runner.run({
      case: await shippedCase(),
      fixtureRoot: join(SUITE, "site"),
      suiteRoot: SUITE,
    });
    assert.deepEqual(output.pages, ["guide/install.md"]);
    assert.equal(output.usage.inputTokens, 10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a live adapter without a configured program refuses before a case runs", () => {
  const previous = process.env["MIZZEN_EVAL_AGENT"];
  delete process.env["MIZZEN_EVAL_AGENT"];
  try {
    assert.throws(() => liveRunner(), /MIZZEN_EVAL_AGENT/u);
  } finally {
    if (previous !== undefined) process.env["MIZZEN_EVAL_AGENT"] = previous;
  }
});

test("the default test command, CI, and the engine never reach the live example", () => {
  const scripts = JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8")).scripts as Record<string, string>;
  assert.doesNotMatch(scripts["test"] ?? "", /examples\/evals/u);
  assert.doesNotMatch(readFileSync(join(PACKAGE, ".github/workflows/ci.yml"), "utf8"), /evals-live|examples\/evals/u);
  assert.doesNotMatch(readFileSync(join(PACKAGE, "src/evals/index.ts"), "utf8"), /examples\//u);
  assert.match(
    readFileSync(join(PACKAGE, ".github/workflows/evals-live.yml"), "utf8"),
    /workflow_dispatch:[\s\S]*schedule:[\s\S]*MIZZEN_EVAL_LIVE/u,
  );
});
