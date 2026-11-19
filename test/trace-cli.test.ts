import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main } from "../src/cli/index.ts";
import type { TraceDocument } from "../src/contracts/trace.ts";
import { parseTrace } from "../src/trace/parse.ts";
import { traceFixture } from "./trace-fixture.ts";

/** Captures what a command prints. */
function capture(): { readonly io: { write: (text: string) => void; error: (text: string) => void }; readonly out: string[]; readonly err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { write: (text) => out.push(text), error: (text) => err.push(text) } };
}

/** A folder with one trace file and its document. */
function fixture(): { readonly folder: string; readonly file: string; readonly trace: TraceDocument } {
  const folder = mkdtempSync(join(tmpdir(), "mizzen-trace-cli-"));
  const trace = traceFixture();
  const file = join(folder, "trace.json");
  writeFileSync(file, `${JSON.stringify(trace, null, 2)}\n`, "utf8");
  return { folder, file, trace };
}

test("trace show prints the task, snapshot, stages, and evidence, or the JSON summary", async () => {
  const { folder, file } = fixture();
  try {
    const text = capture();
    assert.equal(await main(["trace", "show", file], text.io), 0, text.err.join("\n"));
    const printed = text.out.join("");
    assert.match(printed, /task e{64} Update the install guide/);
    assert.match(printed, /stage context 1/);
    assert.match(printed, /evidence pack\/install\.json/);

    const json = capture();
    assert.equal(await main(["trace", "show", file, "--json"], json.io), 0);
    const summary = JSON.parse(json.out.join("")) as { readonly events: number; readonly evidence: readonly string[] };
    assert.equal(summary.events, 5);
    assert.deepEqual(summary.evidence, ["pack/install.json", "install.proof.json"]);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("trace search filters by status and stage, in text and JSON", async () => {
  const { folder, file } = fixture();
  try {
    const failed = capture();
    assert.equal(await main(["trace", "search", file, "--status", "failed"], failed.io), 0);
    assert.match(failed.out.join(""), /#3 verify verify edit\.verify failed docs\/install\.md/);

    const edit = capture();
    assert.equal(await main(["trace", "search", file, "--stage", "edit", "--json"], edit.io), 0);
    const events = JSON.parse(edit.out.join("")) as readonly { readonly sequence: number }[];
    assert.deepEqual(events.map((event) => event.sequence), [2]);

    const invalid = capture();
    assert.equal(await main(["trace", "search", file, "--stage", "deploy"], invalid.io), 2);
    assert.match(invalid.err.join(""), /--stage must be one of/);

    const misplaced = capture();
    assert.equal(await main(["trace", "show", file, "--stage", "edit"], misplaced.io), 2);
    assert.match(misplaced.err.join(""), /only valid for trace search/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("trace replay passes on the recorded snapshot and fails on another, without writing", async () => {
  const { folder, file } = fixture();
  try {
    const ok = capture();
    assert.equal(await main(["trace", "replay", file], ok.io), 0, ok.err.join("\n"));
    assert.match(ok.out.join(""), /replay ok: 5 events at snapshot/);
    assert.match(ok.out.join(""), /nothing was written/);

    const wrong = capture();
    assert.equal(await main(["trace", "replay", file, "--snapshot", "0".repeat(64)], wrong.io), 1);
    assert.match(wrong.err.join(""), /replay-snapshot/);

    const json = capture();
    assert.equal(await main(["trace", "replay", file, "--json"], json.io), 0);
    assert.equal((JSON.parse(json.out.join("")) as { readonly ok: boolean }).ok, true);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("trace export writes one safe file into --out, or prints the authorized JSON", async () => {
  const { folder, file } = fixture();
  try {
    const out = join(folder, "export");
    const write = capture();
    assert.equal(await main(["trace", "export", file, "--out", out], write.io), 0, write.err.join("\n"));
    const names = readdirSync(out);
    assert.equal(names.length, 1);
    assert.match(names[0] ?? "", /^trace-[0-9a-f]{12}-[0-9a-f]{12}\.json$/);
    const text = readFileSync(join(out, names[0]!), "utf8");
    assert.equal(text.includes(folder), false);
    assert.deepEqual(parseTrace(JSON.parse(text)).problems, []);
    assert.match(write.out.join(""), new RegExp(names[0]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const print = capture();
    assert.equal(await main(["trace", "export", file], print.io), 0);
    assert.equal((JSON.parse(print.out.join("")) as { readonly version: number }).version, 1);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("trace handoff prints the state, decisions, and remaining work", async () => {
  const { folder, file } = fixture();
  try {
    const text = capture();
    assert.equal(await main(["trace", "handoff", file], text.io), 0, text.err.join("\n"));
    const printed = text.out.join("");
    assert.match(printed, /state ok/);
    assert.match(printed, /change proof install\.proof\.json/);
    assert.match(printed, /decision 1 decision .*\[policy\.context-source\]/);
    assert.match(printed, /remaining 3 edit\.verify failed/);

    const json = capture();
    assert.equal(await main(["trace", "handoff", file, "--json"], json.io), 0);
    const handoff = JSON.parse(json.out.join("")) as { readonly state: string; readonly receipts: readonly unknown[] };
    assert.equal(handoff.state, "ok");
    assert.equal(handoff.receipts.length, 3);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("a malformed trace and a missing subcommand are usage errors", async () => {
  const folder = mkdtempSync(join(tmpdir(), "mizzen-trace-bad-"));
  try {
    const file = join(folder, "bad.json");
    writeFileSync(file, "{}\n", "utf8");
    const bad = capture();
    assert.equal(await main(["trace", "show", file], bad.io), 2);
    assert.match(bad.err.join(""), /trace\.missing|Missing required field/);

    const missing = capture();
    assert.equal(await main(["trace"], missing.io), 0);
    assert.match(missing.out.join(""), /Usage: mizzen trace/);

    const unknown = capture();
    assert.equal(await main(["trace", "deploy", file], unknown.io), 2);
    assert.match(unknown.err.join(""), /unknown trace subcommand/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
