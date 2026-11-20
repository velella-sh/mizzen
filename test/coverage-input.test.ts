/** Every branch of reading a task contract from a file or stdin. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readContract } from "../src/agent-cli/input.ts";
import type { AgentIo } from "../src/agent-cli/io.ts";

const io: AgentIo = { log: () => {}, write: () => {}, error: () => {} };

test("readContract: no source is one problem on /file", async () => {
  const read = await readContract({ stdin: false }, io);
  assert.equal(read.value, undefined);
  assert.deepEqual(read.problems.map((problem) => problem.code), ["agent.source-missing"]);
  assert.match(read.problems[0]!.message, /--file <path>/);
});

test("readContract: file and stdin together is a conflict", async () => {
  const read = await readContract({ file: "task.json", stdin: true }, io);
  assert.equal(read.value, undefined);
  assert.deepEqual(read.problems.map((problem) => problem.code), ["agent.source-conflict"]);
  assert.match(read.problems[0]!.message, /exactly one/);
});

test("readContract: stdin returns the parsed value", async () => {
  const read = await readContract({ stdin: true }, { ...io, readStdin: async () => '{"version":1}' });
  assert.deepEqual(read.problems, []);
  assert.deepEqual(read.value, { version: 1 });
});

test("readContract: a file returns the same parsed value", async () => {
  const root = mkdtempSync(join(tmpdir(), "coverage-input-"));
  try {
    const path = join(root, "task.json");
    writeFileSync(path, '{"version":1}');
    const read = await readContract({ file: path, stdin: false }, io);
    assert.deepEqual(read.problems, []);
    assert.deepEqual(read.value, { version: 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readContract: a stdin error becomes agent.read with its message", async () => {
  const read = await readContract(
    { stdin: true },
    {
      ...io,
      readStdin: async () => {
        throw new Error("stream broke");
      },
    },
  );
  assert.equal(read.value, undefined);
  assert.equal(read.problems[0]!.code, "agent.read");
  assert.match(read.problems[0]!.message, /cannot read stdin: stream broke/);
});

test("readContract: a non-Error stdin rejection is stringified", async () => {
  const read = await readContract(
    { stdin: true },
    {
      ...io,
      readStdin: async () => {
        throw "plain failure";
      },
    },
  );
  assert.equal(read.problems[0]!.code, "agent.read");
  assert.match(read.problems[0]!.message, /cannot read stdin: plain failure/);
});

test("readContract: a missing file becomes agent.read", async () => {
  const root = mkdtempSync(join(tmpdir(), "coverage-input-"));
  try {
    const read = await readContract({ file: join(root, "absent.json"), stdin: false }, io);
    assert.equal(read.problems[0]!.code, "agent.read");
    assert.match(read.problems[0]!.message, /cannot read the task from .*absent\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readContract: a file with invalid JSON names the file", async () => {
  const root = mkdtempSync(join(tmpdir(), "coverage-input-"));
  try {
    const path = join(root, "task.json");
    writeFileSync(path, "{not json");
    const read = await readContract({ file: path, stdin: false }, io);
    assert.equal(read.value, undefined);
    assert.equal(read.problems[0]!.code, "agent.json");
    assert.match(read.problems[0]!.message, /is not valid JSON/);
    assert.ok(read.problems[0]!.message.includes(path));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readContract: invalid JSON on stdin says stdin", async () => {
  const read = await readContract({ stdin: true }, { ...io, readStdin: async () => "<html>" });
  assert.equal(read.problems[0]!.code, "agent.json");
  assert.match(read.problems[0]!.message, /the task in stdin is not valid JSON/);
});
