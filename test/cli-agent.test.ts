/**
 * The agent CLI end to end through `main`: capabilities, schemas, registration from a file and stdin,
 * an invalid document that writes nothing, one run that is idempotent, structured events, pure JSON
 * stdout, a dry run that leaves every file hash unchanged, resume and cancel conflicts, and the cost
 * and budget report.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { main } from "../src/cli/index.ts";

type Doc = Record<string, any>;

/** A temporary tree holding `files`. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "cli-agent-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** A small site whose page the fixture task names. */
function site(): string {
  return tree({
    "mizzen.yml": "title: Agent demo\n",
    "index.md": "# Home\n\nWelcome to the agent demo.\n",
    "guide/install.md": "# Install\n\nInstall the engine with Node 24 and a terminal.\n\n## Steps\n\nRun the installer and follow the prompts.\n",
  });
}

/** The valid contract every test starts from. */
function contract(extra: Record<string, unknown> = {}): Doc {
  return {
    version: 1,
    idempotencyKey: "agent-install-guide",
    goal: "Update the install guide for Node 24",
    scope: { pages: ["/guide/install/"], blocks: [], collections: [], symbols: [], files: ["guide/install.md"] },
    snapshot: {
      content: "a".repeat(64),
      data: "b".repeat(64),
      config: "c".repeat(64),
      tooling: "d".repeat(64),
    },
    budget: { contextTokens: 6000, toolCalls: 20, timeMs: 60000 },
    permissions: { read: ["*"], write: ["agent"], check: ["agent"] },
    acceptance: [
      { id: "doctor", statement: "The doctor passes", check: "doctor" },
      { id: "review", statement: "A person reviewed the wording", review: true },
    ],
    ...extra,
  };
}

/** The streams a command writes, and a stdin the test controls. */
function capture(stdin = "") {
  const writes: string[] = [];
  const errors: string[] = [];
  const logs: string[] = [];
  return {
    writes,
    errors,
    logs,
    io: {
      write: (text: string) => {
        writes.push(text);
      },
      error: (message: string) => {
        errors.push(message);
      },
      log: (message: string) => {
        logs.push(message);
      },
      readStdin: async () => stdin,
    },
  };
}

/** Parses the one document a command wrote to stdout. */
function document(writes: readonly string[]): Doc {
  assert.equal(writes.length, 1, `one stdout document: ${writes.join("\n").slice(0, 200)}`);
  return JSON.parse(writes[0]!) as Doc;
}

/** Registers a task from stdin and returns its document. */
async function register(root: string, value: Doc = contract()): Promise<Doc> {
  const c = capture(JSON.stringify(value));
  const code = await main(["agent", "task", "register", root, "--stdin"], c.io);
  assert.equal(code, 0, c.errors.join("\n"));
  return document(c.writes);
}

/** SHA-256 of every file under `root`, keyed by a path relative to it. */
function hashes(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else out[relative(root, path)] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  walk(root);
  return out;
}

/** True when every stdout line is one JSON document. */
function lines(text: string): Doc[] {
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Doc);
}

test("capabilities are versioned, ordered, and name an explicit fallback for eval", async () => {
  const c = capture();
  assert.equal(await main(["agent", "capabilities"], c.io), 0);
  assert.deepEqual(c.errors, []);
  const caps = document(c.writes);
  assert.equal(caps.version, 1);
  assert.equal(caps.ok, true);
  assert.equal(caps.command, "agent.capabilities");
  assert.equal(typeof caps.package, "string");
  assert.deepEqual(caps.capabilities.map((entry: Doc) => entry.name), ["task", "pack", "edit", "verify", "replay", "eval"]);
  const available = caps.capabilities.filter((entry: Doc) => entry.available);
  assert.equal(available.length, 5);
  assert.ok(available.every((entry: Doc) => entry.fallback === null && entry.commands.length > 0));
  const evalCapability = caps.capabilities.find((entry: Doc) => entry.name === "eval");
  assert.equal(evalCapability.available, false);
  assert.deepEqual(evalCapability.commands, []);
  assert.match(evalCapability.fallback, /No eval command is installed/);
});

test("a command's input, output, and exit codes are available without help text", async () => {
  const list = capture();
  assert.equal(await main(["agent", "schema"], list.io), 0);
  const names = document(list.writes).commands.map((entry: Doc) => entry.name);
  assert.ok(names.includes("agent.task.register"));
  assert.ok(names.includes("pack"));
  assert.ok(names.includes("trace.replay"));

  for (const name of ["agent.task.register", "agent.task.run", "pack"]) {
    const c = capture();
    assert.equal(await main(["agent", "schema", name], c.io), 0, c.errors.join("\n"));
    const schema = document(c.writes);
    assert.equal(schema.version, 1);
    assert.equal(schema.name, name);
    assert.equal(typeof schema.cli, "string");
    assert.equal(schema.input.type, "object");
    assert.equal(schema.output.type, "object");
    assert.equal(schema.exitCodes["0"].startsWith("success"), true);
  }

  const unknown = capture();
  assert.equal(await main(["agent", "schema", "agent.nope"], unknown.io), 2);
  const failure = document(unknown.writes);
  assert.equal(failure.ok, false);
  assert.equal(failure.problems[0].code, "agent.schema-unknown");
  assert.match(unknown.errors.join("\n"), /agent\.schema-unknown/);
});

test("register reads the same contract from a file and stdin and writes one deterministic task", async () => {
  const root = site();
  const fileRoot = site();
  try {
    const taskFile = join(fileRoot, "task.json");
    writeFileSync(taskFile, JSON.stringify(contract()));

    const fromFile = capture();
    assert.equal(await main(["agent", "task", "register", root, "--file", taskFile], fromFile.io), 0, fromFile.errors.join("\n"));
    const first = document(fromFile.writes);
    assert.equal(first.created, true);
    assert.equal(first.state, "draft");
    assert.deepEqual(first.writes, [`.mizzen/agent/tasks/${first.taskId}.json`]);
    assert.equal(existsSync(join(root, first.writes[0]!)), true);

    const fromStdin = capture(JSON.stringify(contract()));
    assert.equal(await main(["agent", "task", "register", fileRoot, "--stdin"], fromStdin.io), 0, fromStdin.errors.join("\n"));
    const second = document(fromStdin.writes);
    assert.equal(JSON.stringify(second.task), JSON.stringify(first.task), "file and stdin register the same bytes");
    assert.equal(second.writes.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(fileRoot, { recursive: true, force: true });
  }
});

test("an invalid contract names its field path and writes no state", async () => {
  const root = site();
  try {
    const broken = contract({ goal: 5 });
    const c = capture(JSON.stringify(broken));
    assert.equal(await main(["agent", "task", "register", root, "--stdin"], c.io), 2);
    const failure = document(c.writes);
    assert.equal(failure.ok, false);
    assert.ok(failure.problems.some((problem: Doc) => problem.path === "/goal"), JSON.stringify(failure.problems));
    assert.equal(existsSync(join(root, ".mizzen")), false, "nothing was written");
    assert.match(c.errors.join("\n"), /\/goal/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the same key with different content is a conflict and writes no second task", async () => {
  const root = site();
  try {
    const first = await register(root);
    const before = hashes(root);
    const changed = contract({ goal: "A different goal" });

    const c = capture(JSON.stringify(changed));
    assert.equal(await main(["agent", "task", "register", root, "--stdin"], c.io), 1);
    const failure = document(c.writes);
    assert.equal(failure.ok, false);
    assert.equal(failure.problems[0].code, "task.idempotency-conflict");
    assert.deepEqual(hashes(root), before, "a conflict changes no file");
    assert.deepEqual(readdirSync(join(root, ".mizzen", "agent", "tasks")), [`${first.taskId}.json`]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a run pauses for review, emits ordered events, and repeats without a second task or edit", async () => {
  const root = site();
  try {
    const task = await register(root);
    const first = capture();
    assert.equal(await main(["agent", "task", "run", task.taskId, root], first.io), 0, first.errors.join("\n"));
    assert.deepEqual(first.errors, [], "a successful JSON run writes no diagnostics");
    const run = document(first.writes);
    assert.equal(run.ok, true);
    assert.equal(run.outcome, "awaiting-approval");
    assert.equal(run.task.state, "waiting");
    assert.deepEqual(run.progress.events.map((event: Doc) => event.type), ["start", "progress", "approval-required", "finish"]);
    assert.deepEqual(run.progress.events.map((event: Doc) => event.sequence), [0, 1, 2, 3]);
    assert.ok(run.progress.events.every((event: Doc) => event.version === 1 && event.taskId === task.taskId));
    assert.equal(run.cost.estimated, true);
    assert.equal(run.cost.toolCalls, 1);
    assert.deepEqual(run.budget.stops, []);
    assert.equal(run.stopReason, null);
    assert.deepEqual(run.writes, [`.mizzen/agent/tasks/${task.taskId}.json`, `.mizzen/agent/runs/${task.taskId}.json`]);

    const before = hashes(root);
    const second = capture();
    assert.equal(await main(["agent", "task", "run", task.taskId, root], second.io), 0);
    const repeat = document(second.writes);
    assert.equal(repeat.reused, true);
    assert.equal(repeat.outcome, "awaiting-approval");
    assert.deepEqual(repeat.progress.events, run.progress.events);
    assert.deepEqual(repeat.task.events, run.task.events);
    assert.deepEqual(hashes(root), before, "a repeat writes nothing");

    const approve = capture();
    assert.equal(await main(["agent", "task", "resume", task.taskId, root, "--approve", "all"], approve.io), 0, approve.errors.join("\n"));
    const resumed = document(approve.writes);
    assert.equal(resumed.task.state, "ready");
    assert.deepEqual(resumed.approvals, ["review"]);

    const prepared = capture();
    assert.equal(await main(["agent", "task", "run", task.taskId, root], prepared.io), 0, prepared.errors.join("\n"));
    const preparedRun = document(prepared.writes);
    assert.equal(preparedRun.outcome, "prepared");
    assert.equal(preparedRun.task.state, "verify");
    assert.match(preparedRun.resultRef, /^context:[0-9a-f]{64}$/);
    assert.deepEqual(preparedRun.progress.events.map((event: Doc) => event.type), ["start", "progress", "finish"]);

    const status = capture();
    assert.equal(await main(["agent", "task", "status", task.taskId, root], status.io), 0);
    const report = document(status.writes);
    assert.equal(report.task.state, "verify");
    assert.equal(report.run.outcome, "prepared");
    assert.deepEqual(report.approvals, ["review"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("json stdout stays one document while diagnostics stay on stderr", async () => {
  const root = site();
  try {
    const task = await register(root);
    const failedBudget = contract({ idempotencyKey: "budget-small", budget: { contextTokens: 10, toolCalls: 20, timeMs: 60000 } });
    await register(root, failedBudget);

    const c = capture();
    assert.equal(await main(["agent", "task", "run", task.taskId, root, "--format", "json"], c.io), 0);
    assert.equal(c.writes.length, 1);
    assert.doesNotThrow(() => JSON.parse(c.writes[0]!));
    assert.deepEqual(c.errors, []);

    const ndjson = capture();
    assert.equal(await main(["agent", "task", "run", task.taskId, root, "--format", "ndjson"], ndjson.io), 0);
    const parsed = lines(ndjson.writes.join(""));
    assert.equal(parsed.at(-1)?.type, "result");
    assert.deepEqual(parsed.slice(0, -1).map((event) => event.type), ["start", "progress", "approval-required", "finish"]);
    assert.deepEqual(ndjson.errors, [], "events are data, not diagnostics");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a dry run and a preview report changes, checks, and outputs without changing one hash", async () => {
  const root = site();
  const parent = mkdtempSync(join(tmpdir(), "cli-agent-task-"));
  try {
    const taskFile = join(parent, "task.json");
    writeFileSync(taskFile, JSON.stringify(contract()));
    const before = hashes(root);

    const preview = capture();
    assert.equal(await main(["agent", "task", "preview", root, "--file", taskFile], preview.io), 0, preview.errors.join("\n"));
    const plan = document(preview.writes);
    assert.equal(plan.dryRun, true);
    assert.deepEqual(plan.task.goal, "Update the install guide for Node 24");
    assert.ok(plan.proposedChanges.some((change: Doc) => change.kind === "page" && change.ref === "/guide/install/"));
    assert.ok(plan.proposedChanges.some((change: Doc) => change.kind === "file" && change.ref === "guide/install.md"));
    assert.deepEqual(plan.requiredChecks.map((check: Doc) => check.kind), ["check", "review"]);
    assert.ok(plan.affectedOutputs.includes("/guide/install/"));
    assert.ok(plan.affectedOutputs.includes("guide/install.md"));
    assert.deepEqual(plan.writes, []);
    assert.deepEqual(hashes(root), before, "preview changes no project file");

    const task = await register(root);
    const registered = hashes(root);
    const dry = capture();
    assert.equal(await main(["agent", "task", "run", task.taskId, root, "--dry-run"], dry.io), 0, dry.errors.join("\n"));
    const dryRun = document(dry.writes);
    assert.equal(dryRun.dryRun, true);
    assert.deepEqual(dryRun.writes, []);
    assert.deepEqual(dryRun.proposedChanges, plan.proposedChanges);
    assert.deepEqual(hashes(root), registered, "run --dry-run changes no file, including the task store");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a budget stop names the limit and reports what the run cost", async () => {
  const root = site();
  try {
    const small = contract({ idempotencyKey: "budget-small", budget: { contextTokens: 10, toolCalls: 20, timeMs: 60000 } });
    const task = await register(root, small);
    const c = capture();
    assert.equal(await main(["agent", "task", "run", task.taskId, root], c.io), 1);
    const report = document(c.writes);
    assert.equal(report.ok, false);
    assert.equal(report.outcome, "budget-exceeded");
    assert.match(report.stopReason, /Context tokens spent \(\d+\) exceed the limit \(10\)/);
    assert.equal(report.budget.stops[0].status, "context-tokens-exceeded");
    assert.equal(report.budget.remaining.contextTokens, 0);
    assert.equal(report.cost.contextTokens > 10, true);
    assert.equal(report.cost.toolCalls, 1);
    assert.equal(report.cost.timeMs >= 1, true);
    assert.equal(report.task.state, "failed");
    assert.equal(report.progress.events.at(-1).type, "failure");
    assert.match(c.errors.join("\n"), /stopped on budget/);

    const repeat = capture();
    assert.equal(await main(["agent", "task", "run", task.taskId, root], repeat.io), 1);
    assert.equal(document(repeat.writes).reused, true);
    assert.equal(document(repeat.writes).stopReason, report.stopReason);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancel and resume on a finished task return the same conflict every time", async () => {
  const root = site();
  try {
    const task = await register(root, contract({
      idempotencyKey: "no-review",
      acceptance: [{ id: "doctor", statement: "The doctor passes", check: "doctor" }],
    }));
    assert.equal(await main(["agent", "task", "run", task.taskId, root], capture().io), 0);
    assert.equal(await main(["agent", "task", "cancel", task.taskId, root], capture().io), 0);
    const before = hashes(root);

    const first = capture();
    assert.equal(await main(["agent", "task", "cancel", task.taskId, root], first.io), 1);
    const second = capture();
    assert.equal(await main(["agent", "task", "cancel", task.taskId, root], second.io), 1);
    assert.equal(first.writes[0], second.writes[0], "the conflict document is byte-identical");
    assert.equal(document(first.writes).problems[0].code, "task.transition");
    assert.deepEqual(hashes(root), before, "a refused cancel writes nothing");

    const resume = capture();
    assert.equal(await main(["agent", "task", "resume", task.taskId, root], resume.io), 1);
    const resumeAgain = capture();
    assert.equal(await main(["agent", "task", "resume", task.taskId, root], resumeAgain.io), 1);
    assert.equal(resume.writes[0], resumeAgain.writes[0]);

    const rerun = capture();
    assert.equal(await main(["agent", "task", "run", task.taskId, root], rerun.io), 1);
    assert.equal(document(rerun.writes).problems[0].code, "task.transition");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
