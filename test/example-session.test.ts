/**
 * The bounded session runner (#1328, #1330, #1334). A session runs several blocks in one folder in declared order, so
 * state carries between them; the runner classifies a timeout, a memory blow-up, an output flood, a network attempt, a
 * filesystem escape, and a denied command, and stops a run without side effects.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, runSession } from "../src/examples/session.ts";

test("blocks in one session share state in declared order", async () => {
  const result = await runSession({
    blocks: [
      { id: "write", lang: "js", code: 'import { writeFileSync } from "node:fs"; writeFileSync("state.txt", "v1"); console.log("wrote");' },
      { id: "read", lang: "js", code: 'import { readFileSync } from "node:fs"; console.log(readFileSync("state.txt", "utf8"));' },
      { id: "shell", lang: "bash", code: "cat state.txt; echo done" },
    ],
    limits: { timeoutMs: 10_000, memoryMb: 0, network: "deny" },
  });
  assert.deepEqual(result.blocks.map((block) => block.id), ["write", "read", "shell"]);
  assert.equal(result.blocks[0]?.stdout, "wrote\n");
  assert.equal(result.blocks[1]?.stdout, "v1\n");
  // The state file has no trailing newline, so `cat` prints it then `echo` adds the newline after `done`.
  assert.match(result.blocks[2]?.stdout ?? "", /v1done/);
  assert.ok(result.blocks.every((block) => block.ok));
});

test("a failing block stops the session before the next when stopOnFailure is set", async () => {
  const result = await runSession({
    blocks: [
      { id: "first", lang: "js", code: 'throw new Error("boom");' },
      { id: "second", lang: "js", code: 'console.log("should not run");' },
    ],
    limits: { timeoutMs: 10_000, memoryMb: 0, network: "deny" },
    stopOnFailure: true,
  });
  assert.deepEqual(result.blocks.map((block) => block.id), ["first"]);
  assert.equal(result.blocks[0]?.ok, false);
  assert.match(result.blocks[0]?.stderr ?? "", /boom/);
});

test("the network is denied by default and the network policy is guarded", async () => {
  const denied = await runSession({
    blocks: [{ id: "net", lang: "js", code: 'await fetch("https://example.com");' }],
    limits: { timeoutMs: 10_000, memoryMb: 0, network: "deny" },
  });
  assert.equal(denied.blocks[0]?.ok, false);
  assert.equal(denied.blocks[0]?.violation, "network");
});

test("a denied command is refused before it runs", async () => {
  const result = await runSession({
    blocks: [{ id: "denied", lang: "bash", code: "sudo rm -rf /" }],
    limits: { timeoutMs: 10_000, memoryMb: 0, network: "deny" },
  });
  assert.equal(result.blocks[0]?.violation, "command");
  assert.equal(result.blocks[0]?.ok, false);
  assert.match(result.blocks[0]?.stderr ?? "", /denied command/);
});

test("a memory limit stops the block and is classified as a memory violation", { skip: process.platform === "win32" }, async () => {
  const result = await runSession({
    blocks: [{ id: "memory", lang: "js", code: "const a = new Array(1e9).fill(1); console.log(a.length);" }],
    limits: { timeoutMs: 10_000, memoryMb: 20, network: "deny" },
  });
  assert.equal(result.blocks[0]?.ok, false);
  assert.equal(result.blocks[0]?.violation, "memory");
});
test("a write outside the session folder is refused and classified as a filesystem violation", { skip: process.platform === "win32" }, async () => {
  const result = await runSession({
    blocks: [
      {
        id: "escape",
        lang: "js",
        code: 'import { writeFileSync } from "node:fs"; try { writeFileSync("/etc/mizzen-should-never-exist", "x"); } catch { console.error("EPERM"); process.exit(1); }',
      },
    ],
    limits: { timeoutMs: 10_000, memoryMb: 0, network: "deny" },
  });
  assert.equal(result.blocks[0]?.ok, false);
  assert.equal(result.blocks[0]?.violation, "filesystem");
});

test("a timeout is enforced and classified", async () => {
  const result = await runSession({
    blocks: [{ id: "hang", lang: "js", code: "while (true) {}" }],
    limits: { timeoutMs: 300, memoryMb: 0, network: "deny" },
  });
  assert.equal(result.blocks[0]?.violation, "timeout");
  assert.equal(result.blocks[0]?.ok, false);
});

test("classify names each violation from the runtime's own message", () => {
  assert.equal(classify("", true, false), "timeout");
  assert.equal(classify("", false, true), "output");
  assert.equal(classify("FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory", false, false), "memory");
  assert.equal(classify("Error: network access is disabled for this example", false, false), "network");
  assert.equal(classify("EACCES: permission denied, open '/etc/x'", false, false), "filesystem");
  assert.equal(classify("", false, false), "none");
});

test("fixtures are copied into the session folder before the first block", async () => {
  const result = await runSession({
    blocks: [{ id: "read", lang: "js", code: 'import { readFileSync } from "node:fs"; console.log(readFileSync("data.txt", "utf8"));' }],
    fixtures: { "data.txt": "from a fixture" },
    limits: { timeoutMs: 10_000, memoryMb: 0, network: "deny" },
  });
  assert.equal(result.blocks[0]?.stdout, "from a fixture\n");
});

test("a zero timeout is a caller mistake and throws", async () => {
  await assert.rejects(
    runSession({ blocks: [], limits: { timeoutMs: 0, memoryMb: 0, network: "deny" } }),
    /timeoutMs must be a positive/,
  );
});
