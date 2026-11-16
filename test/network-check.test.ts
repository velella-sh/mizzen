import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main } from "../src/cli/index.ts";
import { checkNetworkText } from "../src/network/check.ts";

const file = (projects: string): string => `{\n  "version": 1,\n  "projects": [\n${projects}\n  ]\n}\n`;
const ok = '    { "id": "alpha", "path": "alpha", "title": "Alpha", "public": true }';

test("a valid file has no problems", () => {
  const result = checkNetworkText(file(`${ok},\n    { "id": "beta", "path": "beta", "title": "Beta", "public": false }`), "network.json");
  assert.equal(result.code, 0);
  assert.equal(result.projects, 2);
});

test("a duplicate id is reported at the second use, with its line", () => {
  const result = checkNetworkText(file(`${ok},\n    { "id": "alpha", "path": "other", "title": "Other", "public": true }`), "network.json");
  assert.equal(result.code, 1);
  assert.equal(result.problems[0]?.id, "network.duplicate-id");
  assert.equal(result.problems[0]?.line, 5);
  assert.match(result.lines[0]!, /^network\.json:5:\d+: network\.duplicate-id:/);
});

test("duplicate and overlapping paths are reported", () => {
  const result = checkNetworkText(file(`${ok},\n    { "id": "beta", "path": "Alpha", "title": "Beta", "public": true }`), "n.json");
  assert.deepEqual(result.problems.map((p) => p.id), ["network.duplicate-path"]);
});

test("a path that is not one segment is reported", () => {
  const result = checkNetworkText(file('    { "id": "alpha", "path": "docs/alpha", "title": "Alpha", "public": true }'), "n.json");
  assert.deepEqual(result.problems.map((p) => p.id), ["network.path-not-segment"]);
  assert.equal(result.problems[0]?.line, 4);
});

test("a missing title is reported against its project", () => {
  const result = checkNetworkText(file('    { "id": "alpha", "path": "alpha", "public": true }'), "n.json");
  assert.deepEqual(result.problems.map((p) => p.id), ["network.missing-title"]);
  assert.match(result.problems[0]!.message, /project "alpha"/);
  assert.equal(result.problems[0]?.line, 4);
});

test("invalid JSON is one problem with a line", () => {
  const result = checkNetworkText('{ "version": 1,\n "projects": [ }', "n.json");
  assert.equal(result.code, 1);
  assert.equal(result.problems[0]?.id, "network.invalid-json");
});

test("the command exits non-zero on any error and 0 on a valid file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "network-check-"));
  try {
    const good = join(dir, "good.json");
    const bad = join(dir, "bad.json");
    await writeFile(good, file(ok));
    await writeFile(bad, file('    { "id": "a", "path": "a/b", "title": "A", "public": true }'));
    const out: string[] = [];
    const err: string[] = [];
    const io = { log: (m: string) => out.push(m), error: (m: string) => err.push(m) };
    assert.equal(await main(["network", "check", good], io), 0);
    assert.equal(await main(["network", "check", bad], io), 1);
    assert.match(err.join("\n"), /bad\.json:4:\d+: network\.path-not-segment/);
    assert.equal(await main(["network", "check", join(dir, "missing.json")], io), 2);
    assert.equal(await main(["network", "check"], io), 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
