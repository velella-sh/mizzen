import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main } from "../src/cli/index.ts";
import { canonicalJson, sha256 } from "../src/data/lock.ts";
import { readEnvelope } from "../src/evidence/format.ts";
import { testFindings } from "../src/evidence/tests.ts";

const commit = "a".repeat(40);
const configSha256 = "b".repeat(64);
const artifact = "CI artifact\n";
const artifactSha256 = sha256(artifact);
const surface = "cli:install";
const behavior = "install";
const target = { surface, behavior };
const catalog = [{ suite: "cli", name: "install & run", ...target }];
const ci = { schema: "ci-run@1", commit, configSha256, runId: "123", workflow: "ci.yml", artifactSha256,
  outcome: "passed", targets: [target] };
const benchmark = { schema: "benchmark@1", metric: "install-time", unit: "ms", raw: [49, 52, 50], value: 50,
  run: "https://ci.example/runs/123", targets: [target], environment: { os: "linux" } };

function wrap(kind: string, id: string, payload: unknown, executedAt = "2026-11-20T02:23:01.000Z") {
  return { version: 1, kind, id, origin: "https://ci.example/evidence", snapshot: "v1", executedAt,
    payloadSha256: sha256(canonicalJson(payload)), payload };
}

async function cli(args: readonly string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main(args, { log: (line) => stdout.push(line), error: (line) => stderr.push(line) });
  return { code, out: stdout.join("\n"), err: stderr.join("\n") };
}

test("test evidence joins qualified names and flags missing, duplicate, and unmapped cases", () => {
  const payload = { schema: "junit@1" as const, results: `<?xml version="1.0"?>
    <testsuites><testsuite name="cli">
      <testcase name="install &amp; run"/><testcase name="install &amp; run"><failure/></testcase>
      <testcase classname="other" name="install &amp; run"/>
      <testcase name="errors"><error/></testcase><testcase name="skips"><skipped/></testcase>
    </testsuite></testsuites>`,
  catalog: [...catalog, ...["deleted", "errors", "skips"].map((name) => ({ ...target, suite: "cli", name }))] };
  assert.deepEqual(testFindings(payload).map(({ suite, name, outcome }) => [suite, name, outcome]), [
    ["cli", "deleted", "deleted"], ["cli", "errors", "failed"], ["cli", "install & run", "duplicate"],
    ["cli", "skips", "skipped"], ["other", "install & run", "unmapped"],
  ]);
  assert.throws(() => testFindings({ ...payload, results: "<testsuite>" }), /end|close/i);
  assert.throws(() => testFindings({ ...payload, results: "<!DOCTYPE testsuite><testsuite/>" }), /document type/);
  assert.throws(() => testFindings({ ...payload, results: "<other/>" }), /testsuite/);
  assert.throws(() => testFindings({ ...payload, catalog: [...catalog, ...catalog] }), /Duplicate test catalog/);
});

test("envelopes enforce version, schema, timestamp, HTTPS provenance, and payload integrity", () => {
  const valid = wrap("benchmark", "measurement", benchmark);
  assert.deepEqual(readEnvelope(valid), valid);
  assert.throws(() => readEnvelope({ ...valid, version: 2 }), /schema/);
  assert.throws(() => readEnvelope(wrap("benchmark", "measurement", { ...benchmark, raw: [] })), /schema/);
  assert.throws(() => readEnvelope({ ...valid, executedAt: "2026-02-30T00:00:00Z" }), /timestamp/);
  assert.throws(() => readEnvelope({ ...valid, origin: "https://secret@ci.example" }), /HTTPS/);
  assert.throws(() => readEnvelope(wrap("benchmark", "measurement", { ...benchmark, run: "file:///tmp/result" })), /HTTPS/);
  assert.throws(() => readEnvelope({ ...valid, payload: { ...benchmark, value: 51 } }), /payload SHA-256/);
  assert.throws(() => readEnvelope(wrap("benchmark", "measurement", { ...benchmark, value: Infinity })), /schema/);
});

test("build resolves pinned evidence offline and rejects changed envelopes and artifacts even on a cache hit", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mizzen-evidence-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, "source");
  const theme = join(dir, "theme");
  await mkdir(join(theme, "src"), { recursive: true });
  await mkdir(join(theme, "layouts"));
  await writeFile(join(theme, "src/index.ts"), 'export const theme = { name: "test", folders: ["layouts"] };\n');
  await writeFile(join(theme, "layouts/doc.ts"), 'export default () => "<html><head></head><body></body></html>";\n');
  await mkdir(source);
  await writeFile(join(source, "index.md"), "# Home\n");
  await writeFile(join(source, "mizzen.yml"), 'title: Evidence\ninclude: [".mizzen"]\nexclude: [".mizzen/cache"]\n');
  const out = join(dir, "out");
  const artifactFile = join(dir, "artifact");
  const envelopeFile = join(dir, "envelope.json");
  await writeFile(artifactFile, artifact);
  const lockFile = join(source, "evidence.lock.json");
  const pins: Record<string, { sha256: string; artifactSha256?: string }> = {};
  const json = { schema: "test-json@1", catalog, results: [{ suite: "cli", name: "install & run", outcome: "passed" }] };
  const entries = [
    wrap("test", "tests", json),
    wrap("test", "deleted-test", { ...json, results: [] }),
    wrap("test", "junit", { schema: "junit@1", catalog, results: '<testsuite name="cli"><testcase name="install &amp; run"/></testsuite>' }),
    wrap("ci", "ci", ci),
    wrap("ci", "other-commit", { ...ci, commit: "c".repeat(40) }),
    wrap("ci", "other-config", { ...ci, configSha256: "d".repeat(64) }),
    wrap("ci", "other-artifact", ci),
    wrap("ci", "failed-ci", { ...ci, outcome: "failed" }),
    { ...wrap("test", "other-snapshot", json), snapshot: "v2" },
    wrap("benchmark", "measurement", benchmark),
    wrap("benchmark", "expired", benchmark, "2026-10-20T02:23:01Z"),
    wrap("benchmark", "future", benchmark, "2026-12-20T02:23:01Z"),
    wrap("benchmark", "unrelated", { ...benchmark, targets: [{ ...target, behavior: "uninstall" }] }),
  ];
  await writeFile(envelopeFile, JSON.stringify(entries[3]));
  assert.match((await cli(["evidence", "ingest", envelopeFile, source])).err, /original artifact/);
  await writeFile(artifactFile, "changed artifact");
  assert.match((await cli(["evidence", "ingest", envelopeFile, source, "--artifact", artifactFile])).err, /artifact SHA-256/);
  await writeFile(artifactFile, artifact);
  for (const envelope of entries) {
    await writeFile(envelopeFile, JSON.stringify(envelope));
    const args = ["evidence", "ingest", envelopeFile, source];
    if (envelope.kind === "ci") args.push("--artifact", artifactFile);
    const ingested = await cli(args);
    assert.equal(ingested.code, 0, ingested.err);
    assert.match(ingested.out, /^[a-f0-9]{64}$/);
    pins[envelope.id] = { sha256: ingested.out,
      ...(envelope.kind === "ci" ? { artifactSha256: envelope.id === "other-artifact" ? "e".repeat(64) : artifactSha256 } : {}) };
  }
  await rm(envelopeFile);
  await rm(artifactFile);
  const page = { kind: "page", id: "/" };
  const claim = (id: string, extra = {}) => ({ id, subject: page, ...target, evidence: [id], ...extra });
  const lock = { version: 1, snapshot: { id: "v1", commit, configSha256 }, maxAgeDays: 3, pins, surfaces: [surface], claims: [
    ...entries.map(({ id }) => claim(id)), claim("missing"),
    claim("bad-page", { subject: { ...page, id: "/missing/" }, evidence: ["tests"] }),
    claim("bad-surface", { surface: "unknown", evidence: ["tests"] }),
    claim("behavior", { subject: { kind: "behavior", id: behavior }, evidence: ["tests", "missing"] }),
    claim("bad-behavior", { subject: { kind: "behavior", id: "other" }, evidence: ["tests"] }),
  ] };
  await writeFile(lockFile, JSON.stringify(lock));
  const buildArgs = ["build", source, "--theme", theme, "--out", out, "--as-of", "2026-11-23"];
  assert.match((await cli(buildArgs.slice(0, -2))).err, /explicit as-of/);
  const built = await cli(buildArgs);
  assert.equal(built.code, 0, built.err || built.out);
  const reportPath = join(out, ".mizzen", "evidence.json");
  const bytes = await readFile(reportPath, "utf8");
  const report = JSON.parse(bytes);
  assert.deepEqual(Object.fromEntries(report.claims.map((row: { id: string; status: string }) => [row.id, row.status])), {
    tests: "verified", "deleted-test": "unverified", junit: "verified", ci: "verified", "other-commit": "unverified",
    "other-config": "unverified", "other-artifact": "unverified", "failed-ci": "unverified", "other-snapshot": "unverified",
    measurement: "verified", expired: "stale", future: "unverified", unrelated: "unverified", missing: "unverified",
    "bad-page": "unverified", "bad-surface": "unverified", behavior: "verified", "bad-behavior": "unverified",
  });
  assert.deepEqual(report.claims.slice(4, 9).map((row: { evidence: { reason: string }[] }) => row.evidence[0]?.reason),
    ["commit-mismatch", "configuration-mismatch", "artifact-mismatch", "nonpassing-ci", "snapshot-mismatch"]);
  assert.ok(bytes.includes('"run":"https://ci.example/runs/123"'));
  assert.equal(report.evidence.filter((row: { measurement?: unknown }) => row.measurement).length, 1);
  for (const privatePath of ["evidence.lock.json", ".mizzen/evidence"]) {
    await assert.rejects(readFile(join(out, privatePath)), { code: "ENOENT" });
  }
  const replayed = await cli(buildArgs);
  assert.equal(replayed.code, 0, replayed.err);
  assert.equal(await readFile(reportPath, "utf8"), bytes);

  await writeFile(lockFile, JSON.stringify({ ...lock, maxAgeDays: 2 }));
  const stricter = await cli(buildArgs);
  assert.equal(stricter.code, 0, stricter.err);
  assert.equal(JSON.parse(await readFile(reportPath, "utf8")).claims[0].status, "stale");
  await writeFile(lockFile, JSON.stringify(lock));
  assert.equal((await cli(buildArgs)).code, 0);
  assert.equal(await readFile(reportPath, "utf8"), bytes);

  const store = join(source, ".mizzen", "evidence");
  const storedArtifact = join(store, `${artifactSha256}.artifact`);
  await writeFile(storedArtifact, "changed artifact");
  assert.match((await cli(buildArgs)).err, /artifact SHA-256/);
  await writeFile(storedArtifact, artifact);
  const pinnedCi = join(store, `${pins.ci!.sha256}.json`);
  const oldCi = await readFile(pinnedCi, "utf8");
  await writeFile(pinnedCi, oldCi.replace(commit, "f".repeat(40)));
  assert.match((await cli(buildArgs)).err, /envelope SHA-256/);
  await writeFile(pinnedCi, oldCi);
  await rm(join(store, `${pins.tests!.sha256}.json`));
  assert.match((await cli(buildArgs)).err, /missing from the local store/);
  assert.equal(await readFile(reportPath, "utf8"), bytes);
});
