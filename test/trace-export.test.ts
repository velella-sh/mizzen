import assert from "node:assert/strict";
import { test } from "node:test";
import { exportFilename, exportJson, exportTrace } from "../src/trace/export.ts";
import { parseTrace } from "../src/trace/parse.ts";
import { traceFixture } from "./trace-fixture.ts";

/** A raw trace with a path and a credential in its free text. */
function sensitive(): unknown {
  const trace = JSON.parse(JSON.stringify(traceFixture())) as {
    id?: string;
    task: { goal: string };
    events: { reason?: string }[];
  };
  delete trace.id;
  trace.task.goal = "Update /Users/alice/site/docs/install.md with token=abcd1234efgh5678";
  trace.events[1]!.reason = "Read /home/bob/site/config.yml and api_key=sk_live_1234567890abcdef";
  return trace;
}

test("export keeps the authorized fields and nothing else", () => {
  const { document } = exportTrace(traceFixture());
  assert.deepEqual(Object.keys(document), ["version", "id", "task", "snapshot", "events", "receipts", "nondeterministic"]);
  assert.deepEqual(Object.keys(document.events[2]!), [
    "sequence", "parent", "stage", "kind", "capability", "status", "inputHash", "result", "file", "subtask", "links", "cost", "at", "durationMs",
  ]);
  assert.equal(JSON.stringify(document).includes('"input"'), false);
  assert.deepEqual(parseTrace(document).problems, []);
});

test("the file name is derived from the two hashes and contains no local path", () => {
  const trace = traceFixture();
  const filename = exportFilename(trace);
  assert.equal(filename, `trace-${trace.task.id.slice(0, 12)}-${trace.id.slice(0, 12)}.json`);
  assert.match(filename, /^trace-[0-9a-f]{12}-[0-9a-f]{12}\.json$/);
  assert.equal(filename.includes("/"), false);
  assert.equal(filename.includes("\\"), false);
});

test("a local path and a credential in free text are redacted in the exported document", () => {
  const exported = exportTrace(sensitive());
  const text = exportJson(exported);
  assert.equal(text.includes("/Users/alice"), false);
  assert.equal(text.includes("/home/bob"), false);
  assert.equal(text.includes("sk_live_1234567890abcdef"), false);
  assert.equal(text.includes("abcd1234efgh5678"), false);
  assert.match(text, /\[redacted-path\]/);
  assert.match(text, /\[redacted-credential\]/);
  assert.deepEqual(parseTrace(exported.document).problems, []);
});

test("export is deterministic: the same trace gives the same bytes and one LF", () => {
  const trace = traceFixture();
  const first = exportJson(exportTrace(trace));
  const second = exportJson(exportTrace(trace));
  assert.equal(first, second);
  assert.equal(first.endsWith("\n"), true);
  assert.equal(first.includes("\r"), false);
});
