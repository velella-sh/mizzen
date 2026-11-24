/**
 * #1366: the supersession and historical query through the public CLI.
 *
 * The fixture holds two successive decisions. The `mizzen decisions why` command answers the earlier decision at the
 * version before supersession and the replacement with the earlier one as history after it, so an agent can trace the
 * new behavior to its actual rationale. A supersession cycle is refused, and `mizzen decisions` reports the lifecycle.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli/index.ts";

const FIXTURE = fileURLToPath(new URL("../fixtures/decisions", import.meta.url));

/** Collects the CLI's stdout and stderr. */
function capture(): { readonly io: { readonly log: (m: string) => void; readonly error: (m: string) => void }; readonly out: () => string; readonly err: () => string } {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    io: { log: (m: string) => logs.push(m), error: (m: string) => errors.push(m) },
    out: () => logs.join("\n"),
    err: () => errors.join("\n"),
  };
}

async function run(args: readonly string[]): Promise<{ readonly code: number; readonly out: string; readonly err: string }> {
  const captured = capture();
  const code = await main(args, captured.io);
  return { code, out: captured.out(), err: captured.err() };
}

test("#1366 the CLI answers the earlier decision before supersession", async () => {
  const result = await run(["decisions", "why", "behavior:cache-hit", FIXTURE, "--version", "v1", "--json"]);
  assert.equal(result.code, 0, result.err);
  const answer = JSON.parse(result.out) as { current?: { id: string; rationale?: string }; history: { id: string }[] };
  assert.equal(answer.current?.id, "ADR-0001");
  assert.match(answer.current?.rationale ?? "", /simple and fast/);
  assert.deepEqual(answer.history, []);
});

test("#1366 the CLI answers the replacement with the earlier one as history after supersession", async () => {
  const result = await run(["decisions", "why", "behavior:cache-hit", FIXTURE, "--version", "v2", "--json"]);
  assert.equal(result.code, 0, result.err);
  const answer = JSON.parse(result.out) as { current?: { id: string; rationale?: string; alternatives: { name: string }[] }; history: { id: string }[] };
  assert.equal(answer.current?.id, "ADR-0002");
  assert.match(answer.current?.rationale ?? "", /one answer across workers/);
  assert.deepEqual(answer.history.map((entry) => entry.id), ["ADR-0001"]);
  assert.ok((answer.current?.alternatives ?? []).length >= 2);
});

test("#1366 the CLI reports the lifecycle and its counts", async () => {
  const result = await run(["decisions", FIXTURE, "--json"]);
  assert.equal(result.code, 0, result.err);
  const report = JSON.parse(result.out) as { counts: Record<string, number>; entries: { id: string }[] };
  assert.equal(report.counts.accepted, 1);
  assert.equal(report.counts.superseded, 1);
  assert.deepEqual(report.entries.map((entry) => entry.id).sort(), ["ADR-0001", "ADR-0002"]);
});

test("#1366 a supersession cycle is refused at the CLI", async () => {
  const root = mkdtempSync(join(tmpdir(), "decisions-cycle-"));
  const write = (path: string, text: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  write("mizzen.yml", "title: T\ndecisions:\n  dir: docs/decisions\n");
  write("index.md", "# Home\n");
  write("docs/decisions/a.md", "---\nid: A\ntitle: A\nstatus: accepted\ndate: 2025-01-01\nsource: x\nsupersedes: [B]\n---\n\n## Decision\nDo A.\n");
  write("docs/decisions/b.md", "---\nid: B\ntitle: B\nstatus: accepted\ndate: 2025-02-01\nsource: x\nsupersedes: [A]\n---\n\n## Decision\nDo B.\n");
  try {
    const result = await run(["decisions", root]);
    assert.equal(result.code, 1);
    assert.match(result.err, /supersession cycle/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
