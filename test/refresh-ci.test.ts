/**
 * #1024–#1035: one refresh report covers changed, unchanged, and failed runs; a filtered run keeps the other locks;
 * validation restores the previous lock; and a build reads the refreshed lock without a network.
 */
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "../src/pipeline/build.ts";
import { dataRefresh, REFRESH_SCHEMA } from "../src/cli/refresh.ts";
import type { FetchLike } from "../src/cli/data.ts";

const FIXTURE = new URL("../fixtures/refresh-ci/site/", import.meta.url);
const THEME = fileURLToPath(new URL("../../lateen", import.meta.url));

/** A copy of the fixture site, so one test never changes another. */
function site(): string {
  const root = mkdtempSync(join(tmpdir(), "refresh-ci-"));
  cpSync(FIXTURE, root, { recursive: true });
  return root;
}

/** A JSON API stub; `state.records` is what the next request returns. */
function service(): { state: { records: Record<string, unknown>[]; status: number }; fetch: FetchLike; calls: number[] } {
  const state = { records: [{ id: "alpha", name: "Alpha", note: "first" }], status: 200 };
  const calls: number[] = [];
  const fetch: FetchLike = async () => {
    calls.push(1);
    return new Response(JSON.stringify({ data: { items: state.records } }), {
      status: state.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { state, fetch, calls };
}

test("a changed source reports counts and ids, and the same bytes are unchanged", async () => {
  const root = site();
  try {
    const report = join(root, "..", "refresh.json");
    const api = service();

    const first = await dataRefresh({ root, report, fetch: api.fetch });
    assert.equal(first.code, 0, first.errors.join("\n"));
    assert.equal(first.report.schema, REFRESH_SCHEMA);
    assert.equal(first.report.status, "changed");
    assert.equal(first.report.lock.before, null);
    assert.deepEqual(first.report.changes.collections, [
      { name: "items", before: 0, after: 1, added: ["alpha"], removed: [], changed: [] },
    ]);
    assert.deepEqual(first.report.changes.totals, { before: 0, after: 1, added: 1, removed: 0, changed: 0 });
    assert.equal(first.report.sources.length, 1);
    assert.equal(first.report.sources[0]!.source, "http://127.0.0.1:4317/items");
    assert.equal(first.report.sources[0]!.status, "new");
    assert.equal(JSON.parse(readFileSync(report, "utf8")).schema, REFRESH_SCHEMA);

    const second = await dataRefresh({ root, report, fetch: api.fetch });
    assert.equal(second.code, 0, second.errors.join("\n"));
    assert.equal(second.report.status, "unchanged");
    assert.equal(second.report.lock.before, second.report.lock.after);
    assert.deepEqual(second.report.changes.totals, { before: 1, after: 1, added: 0, removed: 0, changed: 0 });

    api.state.records = [
      { id: "alpha", name: "Alpha Two", note: "first" },
      { id: "beta", name: "Beta", note: "second" },
    ];
    const third = await dataRefresh({ root, report, fetch: api.fetch });
    assert.equal(third.code, 0, third.errors.join("\n"));
    assert.equal(third.report.status, "changed");
    assert.deepEqual(third.report.changes.totals, { before: 1, after: 2, added: 1, removed: 0, changed: 1 });
    assert.deepEqual(third.report.changes.collections[0]!.added, ["beta"]);
    assert.deepEqual(third.report.changes.collections[0]!.changed, ["alpha"]);
    assert.equal(third.report.sources[0]!.status, "changed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a schema or quality failure stops before a proposal and restores the previous lock", async () => {
  const root = site();
  try {
    const report = join(root, "..", "failed.json");
    const api = service();
    const good = await dataRefresh({ root, report, fetch: api.fetch });
    assert.equal(good.code, 0);
    const healthy = readFileSync(join(root, "mizzen.lock.json"));

    api.state.records = [{ id: "alpha", name: 7, note: "first" }];
    const invalid = await dataRefresh({ root, report, fetch: api.fetch });
    assert.equal(invalid.code, 1);
    assert.equal(invalid.report.status, "failed");
    assert.equal(invalid.report.stage, "validate");
    assert.equal(invalid.report.lock.restored, true);
    assert.ok(invalid.report.errors.some((message) => /name|schema|expected/i.test(message)));
    assert.deepEqual(readFileSync(join(root, "mizzen.lock.json")), healthy, "the previous lock stays in place");

    api.state.records = [{ id: "alpha", name: "Alpha", note: "first" }];
    await dataRefresh({ root, report, fetch: api.fetch });
    api.state.records = [{ id: "alpha", name: "Alpha" }];
    const quality = await dataRefresh({ root, report, fetch: api.fetch });
    assert.equal(quality.code, 1);
    assert.equal(quality.report.stage, "quality");
    assert.equal(quality.report.lock.restored, true);
    assert.deepEqual(readFileSync(join(root, "mizzen.lock.json")), healthy, "a quality failure also restores the lock");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a filtered refresh leaves another collection's lock entry untouched", async () => {
  const root = site();
  try {
    writeFileSync(
      join(root, "mizzen.yml"),
      readFileSync(join(root, "mizzen.yml"), "utf8").replace(
        "\nquality:",
        "\n  other:\n    source: http://127.0.0.1:4317/other\n    records: data.items\n    id: id\nquality:",
      ),
    );
    const report = join(root, "..", "filtered.json");
    const api = service();
    const all = await dataRefresh({ root, report, fetch: api.fetch });
    assert.equal(all.code, 0, all.errors.join("\n"));

    const before = JSON.parse(readFileSync(join(root, "mizzen.lock.json"), "utf8")) as {
      sources: Record<string, { sha256: string }>;
    };
    const other = "http://127.0.0.1:4317/other";
    assert.ok(before.sources[other]);

    const second = await dataRefresh({ root, report, collections: ["items"], fetch: api.fetch });
    assert.equal(second.code, 0, second.errors.join("\n"));
    assert.deepEqual(second.report.collections, ["items"]);
    const after = JSON.parse(readFileSync(join(root, "mizzen.lock.json"), "utf8")) as {
      sources: Record<string, { sha256: string }>;
    };
    assert.equal(after.sources[other]!.sha256, before.sources[other]!.sha256);
    assert.ok(after.sources["http://127.0.0.1:4317/items"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a refresh report never carries an environment value", async () => {
  const root = site();
  try {
    const report = join(root, "..", "secret.json");
    const api = service();
    process.env.MIZZEN_REFRESH_TEST_TOKEN = "refresh-secret-value";
    const result = await dataRefresh({ root, report, fetch: api.fetch });
    assert.equal(result.code, 0);
    const text = readFileSync(report, "utf8");
    assert.doesNotMatch(text, /refresh-secret-value/);
  } finally {
    delete process.env.MIZZEN_REFRESH_TEST_TOKEN;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a build reads the refreshed lock with no network", async () => {
  const root = site();
  const out = join(root, "..", "dist");
  try {
    const api = service();
    const refresh = await dataRefresh({ root, report: join(root, "..", "build.json"), fetch: api.fetch });
    assert.equal(refresh.code, 0, refresh.errors.join("\n"));

    const original = globalThis.fetch;
    let opened = 0;
    globalThis.fetch = (() => {
      opened += 1;
      throw new Error("the build must not open a network connection");
    }) as typeof globalThis.fetch;
    try {
      const result = await build({ root, out, themeRoot: THEME, defaultLayout: "doc" });
      assert.deepEqual(result.diagnostics.filter((finding) => finding.severity === "error"), []);
      assert.ok(result.files.includes("items/alpha/index.html"), result.files.join("\n"));
    } finally {
      globalThis.fetch = original;
    }
    assert.equal(opened, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test("an unknown collection is a usage error and still writes a report", async () => {
  const root = site();
  try {
    const report = join(root, "..", "unknown.json");
    const result = await dataRefresh({ root, report, collections: ["missing"], fetch: service().fetch });
    assert.equal(result.code, 2);
    assert.equal(result.report.status, "failed");
    assert.match(result.errors.join("\n"), /No collection named "missing"/);
    assert.equal(JSON.parse(readFileSync(report, "utf8")).status, "failed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
