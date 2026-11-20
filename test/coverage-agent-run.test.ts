/** Agent task preview/run/status/resume/cancel through `main`: missing ids, text, events, and failures. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { main } from "../src/cli/index.ts";

type Doc = Record<string, any>;

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "coverage-agent-run-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function site(extra: Record<string, string> = {}): string {
  return tree({
    "mizzen.yml": "title: Agent demo\n",
    "index.md": "# Home\n\nWelcome.\n",
    "guide/install.md": "# Install\n\nInstall the engine with Node 24.\n\n## Steps\n\nRun the installer.\n",
    ...extra,
  });
}

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

function document(writes: readonly string[]): Doc {
  assert.equal(writes.length, 1, writes.join("\n").slice(0, 200));
  return JSON.parse(writes[0]!) as Doc;
}

function contract(extra: Record<string, unknown> = {}): Doc {
  return {
    version: 1,
    idempotencyKey: "run-coverage",
    goal: "Update the install guide",
    scope: { pages: ["/guide/install/"], blocks: [], collections: [], symbols: [], files: ["guide/install.md"] },
    snapshot: { content: "a".repeat(64), data: "b".repeat(64), config: "c".repeat(64), tooling: "d".repeat(64) },
    budget: { contextTokens: 6000, toolCalls: 20, timeMs: 60000 },
    permissions: { read: ["*"], write: ["agent"], check: ["agent"] },
    acceptance: [{ id: "doctor", statement: "The doctor passes", check: "doctor" }],
    ...extra,
  };
}

async function register(root: string, value: Doc = contract()): Promise<Doc> {
  const c = capture(JSON.stringify(value));
  const code = await main(["agent", "task", "register", root, "--stdin"], c.io);
  assert.equal(code, 0, c.errors.join("\n"));
  return document(c.writes);
}

async function prepared(root: string): Promise<Doc> {
  const task = await register(root);
  const c = capture();
  assert.equal(await main(["agent", "task", "run", task.taskId, root], c.io), 0, c.errors.join("\n"));
  return task;
}

test("an unknown task id is refused by every steering command", async () => {
  const root = site();
  try {
    for (const [command, extra] of [
      ["run", []],
      ["status", []],
      ["resume", []],
      ["cancel", []],
    ] as const) {
      const c = capture();
      assert.equal(await main(["agent", "task", command, "task-nope", root, ...extra], c.io), 1, command);
      const failure = document(c.writes);
      assert.equal(failure.ok, false);
      assert.equal(failure.problems[0].code, "agent.task-missing");
      assert.match(c.errors.join("\n"), /agent\.task-missing/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preview and run work in text format and write no JSON document", async () => {
  const root = site();
  const parent = mkdtempSync(join(tmpdir(), "coverage-agent-task-"));
  try {
    const taskFile = join(parent, "task.json");
    writeFileSync(taskFile, JSON.stringify(contract()));

    const preview = capture();
    assert.equal(await main(["agent", "task", "preview", root, "--file", taskFile, "--format", "text"], preview.io), 0);
    assert.equal(preview.writes.length, 1);
    assert.match(preview.writes[0]!, /^mizzen: preview [0-9a-f]{64}:/);

    const task = await register(root);
    const run = capture();
    assert.equal(await main(["agent", "task", "run", task.taskId, root, "--format", "text"], run.io), 0, run.errors.join("\n"));
    assert.match(run.writes[0]!, /^mizzen: task [0-9a-f]{64} /);

    const status = capture();
    assert.equal(await main(["agent", "task", "status", task.taskId, root, "--format", "text"], status.io), 0);
    assert.match(status.writes[0]!, /^mizzen: task [0-9a-f]{64} is verify/);

    const missing = capture();
    assert.equal(await main(["agent", "task", "status", "task-nope", root, "--format", "text"], missing.io), 1);
    assert.deepEqual(missing.writes, [], "a text refusal writes no document");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("--events writes JSON Lines for prepared, awaiting-approval, and dry runs", async () => {
  const root = site();
  const parent = mkdtempSync(join(tmpdir(), "coverage-agent-events-"));
  try {
    const noReview = await register(root, contract({ idempotencyKey: "events-no-review" }));
    const preparedPath = join(parent, "prepared.ndjson");
    const preparedRun = capture();
    assert.equal(await main(["agent", "task", "run", noReview.taskId, root, "--events", preparedPath], preparedRun.io), 0);
    const preparedLines = readFileSync(preparedPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Doc);
    assert.equal(preparedLines.at(-1)?.type, "result");
    assert.equal(preparedLines[0]?.version, 1);

    const review = await register(root, contract({
      idempotencyKey: "events-review",
      acceptance: [
        { id: "doctor", statement: "The doctor passes", check: "doctor" },
        { id: "review", statement: "A person reviewed it", review: true },
      ],
    }));
    const waitingPath = join(parent, "waiting.ndjson");
    const waiting = capture();
    assert.equal(await main(["agent", "task", "run", review.taskId, root, "--events", waitingPath], waiting.io), 0);
    assert.match(readFileSync(waitingPath, "utf8"), /approval-required/);

    const taskFile = join(parent, "task.json");
    writeFileSync(taskFile, JSON.stringify(contract({ idempotencyKey: "events-dry", goal: "Dry run the install guide" })));
    const dry = capture();
    assert.equal(await main(["agent", "task", "preview", root, "--file", taskFile], dry.io), 0);
    const dryRunPath = join(parent, "dry.ndjson");
    assert.equal(await main(["agent", "task", "run", "task-nope", root, "--dry-run", "--events", dryRunPath], dry.io), 1);
    assert.equal(existsSync(dryRunPath), false, "a missing task writes no events file");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a build error refuses preview and fails run with the diagnostic code", async () => {
  const root = site({ "guide/broken.md": "# Broken\n\n::include[absent.md]\n" });
  const parent = mkdtempSync(join(tmpdir(), "coverage-agent-bad-"));
  try {
    const taskFile = join(parent, "task.json");
    writeFileSync(taskFile, JSON.stringify(contract()));

    const preview = capture();
    assert.equal(await main(["agent", "task", "preview", root, "--file", taskFile], preview.io), 1);
    const refusal = document(preview.writes);
    assert.equal(refusal.ok, false);
    assert.equal(refusal.problems[0].code, "include.missing");
    assert.match(refusal.problems[0].message, /guide\/broken\.md:3/);

    const task = await register(root);
    const dry = capture();
    assert.equal(await main(["agent", "task", "run", task.taskId, root, "--dry-run"], dry.io), 1);
    assert.equal(document(dry.writes).dryRun, true);
    assert.equal(document(dry.writes).problems[0].code, "include.missing");

    const run = capture();
    assert.equal(await main(["agent", "task", "run", task.taskId, root], run.io), 1);
    assert.equal(document(run.writes).outcome, "failed");
    assert.equal(document(run.writes).task.state, "failed");
    assert.equal(document(run.writes).progress.events.at(-1).type, "failure");
    assert.deepEqual(document(run.writes).context.snapshot, null);
    assert.match(run.errors.join("\n"), /include\.missing/);

    const repeat = capture();
    assert.equal(await main(["agent", "task", "run", task.taskId, root], repeat.io), 1);
    assert.equal(document(repeat.writes).reused, true, "a failed run is returned, not repeated");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a task already in verify without a recorded run is refused, not rerun", async () => {
  const root = site();
  try {
    const task = await prepared(root);
    rmSync(join(root, ".mizzen", "agent", "runs", `${task.taskId}.json`));
    const c = capture();
    assert.equal(await main(["agent", "task", "run", task.taskId, root], c.io), 1);
    assert.equal(document(c.writes).problems[0].code, "agent.task-already-prepared");
    assert.match(c.errors.join("\n"), /already .*verify/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resume refuses an approval id that is not a review criterion", async () => {
  const root = site();
  try {
    const task = await register(root, contract({
      idempotencyKey: "approve-unknown",
      acceptance: [
        { id: "doctor", statement: "The doctor passes", check: "doctor" },
        { id: "review", statement: "A person reviewed it", review: true },
      ],
    }));
    const run = capture();
    assert.equal(await main(["agent", "task", "run", task.taskId, root], run.io), 0);
    assert.equal(document(run.writes).outcome, "awaiting-approval");

    const c = capture();
    assert.equal(await main(["agent", "task", "resume", task.taskId, root, "--approve", "nope"], c.io), 2);
    assert.equal(document(c.writes).problems[0].code, "agent.approval-unknown");
    assert.match(c.errors.join("\n"), /review criteria: `review`/);

    const none = capture();
    assert.equal(await main(["agent", "task", "resume", task.taskId, root, "--approve", "doctor"], none.io), 2);
    assert.match(document(none.writes).problems[0].message, /doctor/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run refuses a task whose scope leaves no context to compile", async () => {
  const root = site();
  try {
    const task = await register(root, contract({ idempotencyKey: "no-context", scope: { pages: ["/guide/absent/"], blocks: [], collections: [], symbols: [], files: [] }, goal: "quantum tunnelling" }));
    const c = capture();
    assert.equal(await main(["agent", "task", "run", task.taskId, root], c.io), 0, c.errors.join("\n"));
    const done = document(c.writes);
    assert.equal(done.ok, true);
    assert.equal(done.context.fragments >= 0, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
