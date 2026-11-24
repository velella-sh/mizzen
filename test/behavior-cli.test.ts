import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { join } from "node:path";
import { main } from "../src/cli/index.ts";
import {
  behavior,
  behaviorPage,
  behaviorTree,
  FIXTURE_CONFIG,
  symbol,
  testFile,
} from "./behavior-fixture.ts";

function capture() {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    io: { log: (message: string) => logs.push(message), error: (message: string) => errors.push(message) },
  };
}

function cliSite(): string {
  return behaviorTree({
    "mizzen.yml": FIXTURE_CONFIG,
    "pkg/index.ts": [symbol("greet", "(name: string): string"), symbol("farewell", "(name: string): string")].join("\n"),
    "test/greet.test.ts": testFile("greet returns the name"),
    "docs/api.md": behaviorPage([
      behavior({
        id: "greet.verified",
        surface: ["symbol:greet"],
        testFile: "test/greet.test.ts",
        testName: "greet returns the name",
        evidenceUrl: "https://ci.example.org/run",
      }),
      behavior({
        id: "greet.unverified",
        surface: ["symbol:greet"],
        testFile: "test/greet.test.ts",
        testName: "greet returns the name",
      }),
      behavior({
        id: "greet.linux",
        surface: ["symbol:greet"],
        testFile: "test/greet.test.ts",
        testName: "greet returns the name",
        evidenceUrl: "https://ci.example.org/linux",
        environments: ["{ os: linux }"],
      }),
    ]),
  });
}

test("mizzen behavior prints a versioned JSON report and applies a version query", async () => {
  const root = cliSite();
  try {
    const json = capture();
    assert.equal(await main(["behavior", root, "--json", "--version", "1.0.0"], json.io), 0);
    const report = JSON.parse(json.logs.join("\n")) as {
      version: number;
      source: { version?: string };
      behaviors: { id: string; statusAtVersion?: string }[];
      coverage: { total: number; verified: number; unverified: number };
    };
    assert.equal(report.version, 1);
    assert.equal(report.source.version, "1.0.0");
    assert.equal(report.behaviors.length, 3);
    assert.ok(report.behaviors.every((entry) => entry.statusAtVersion === "supported"));
    assert.equal(report.coverage.verified, 2);
    assert.equal(report.coverage.unverified, 1);

    const text = capture();
    assert.equal(await main(["behavior", root], text.io), 0);
    assert.match(text.logs.join("\n"), /Behavior contracts: 3/);
    assert.match(text.logs.join("\n"), /Unverified:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mizzen behavior scopes by status and environment", async () => {
  const root = cliSite();
  try {
    const linux = capture();
    assert.equal(await main(["behavior", root, "--json", "--os", "linux"], linux.io), 0);
    const report = JSON.parse(linux.logs.join("\n")) as { behaviors: { id: string }[] };
    const ids = report.behaviors.map((entry) => entry.id);
    assert.ok(ids.includes("greet.linux"));
    assert.ok(ids.includes("greet.verified"), "an unscoped behavior covers every environment");
    assert.equal(ids.length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mizzen behavior gates on --min-verified, rejects bad arguments, and writes --out", async () => {
  const root = cliSite();
  try {
    const badFormat = capture();
    assert.equal(await main(["behavior", root, "--format", "yaml"], badFormat.io), 2);
    assert.match(badFormat.errors.join("\n"), /--format must be text or json/);

    const badMin = capture();
    assert.equal(await main(["behavior", root, "--min-verified", "101"], badMin.io), 2);
    assert.match(badMin.errors.join("\n"), /0 to 100/);

    const unknown = capture();
    assert.equal(await main(["behavior", root, "--nope"], unknown.io), 2);

    const gated = capture();
    assert.equal(await main(["behavior", root, "--min-verified", "100"], gated.io), 1);
    assert.match(gated.errors.join("\n"), /below --min-verified 100%/);

    const out = join(root, "behavior-report.json");
    const written = capture();
    assert.equal(await main(["behavior", root, "--json", "--out", out], written.io), 0);
    assert.deepEqual(written.logs, []);
    assert.ok(existsSync(out));
    assert.equal((JSON.parse(readFileSync(out, "utf8")) as { version: number }).version, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mizzen behavior compares a baseline and reports drift only for the affected behavior", async () => {
  const root = cliSite();
  try {
    const baseline = capture();
    assert.equal(await main(["behavior", root, "--json", "--version", "1.0.0"], baseline.io), 0);
    const file = join(root, "baseline.json");
    writeFileSync(file, baseline.logs.join("\n"));

    const compared = capture();
    assert.equal(await main(["behavior", root, "--json", "--version", "1.0.0", "--baseline", file], compared.io), 0);
    const value = JSON.parse(compared.logs.join("\n")) as { comparison: { drift: unknown[]; unchanged: number } };
    assert.deepEqual(value.comparison.drift, []);
    assert.equal(value.comparison.unchanged, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mizzen behavior exits 1 on a duplicate id and names both locations", async () => {
  const root = behaviorTree({
    "mizzen.yml": FIXTURE_CONFIG,
    "pkg/index.ts": symbol("greet", "(name: string): string"),
    "docs/a.md": behaviorPage([behavior({ id: "duplicate", surface: [] })]),
    "docs/b.md": behaviorPage([behavior({ id: "duplicate", surface: [] })]),
  });
  try {
    const run = capture();
    assert.equal(await main(["behavior", root], run.io), 1);
    assert.match(run.errors.join("\n"), /behavior\.duplicate-id/);
    assert.match(run.errors.join("\n"), /docs\/a\.md/);
    assert.match(run.errors.join("\n"), /docs\/b\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
