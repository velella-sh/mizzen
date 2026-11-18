import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { main } from "../src/cli/index.ts";
import { loadConfig } from "../src/config/load.ts";
import { checkQuality } from "../src/data/quality.ts";
import { tree } from "./data-schema-tree.ts";

/** One site: `b` is in scope and lacks `author`, `c` is out of scope and lacks it too. */
const SITE: Record<string, string> = {
  "mizzen.yml": [
    "collections:",
    "  items:",
    "    source: _data/items.yml",
    "quality:",
    "  rules:",
    "    - kind: completeness",
    "      collection: items",
    "      fields: [author]",
    "      where: { status: stable }",
    "",
  ].join("\n"),
  "_data/items.yml": "- id: a\n  status: stable\n  author: Ada\n- id: b\n  status: stable\n- id: c\n  status: draft\n",
};

/** Loads and checks a temporary site, which is gone before the assertions run. */
async function check(files: Record<string, string> = SITE) {
  const root = tree(files);
  try {
    const { config, diagnostics } = loadConfig(root);
    return { config, diagnostics, report: await checkQuality({ root, config }) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a record missing a required field is a finding", async () => {
  const { report } = await check();
  assert.deepEqual(report.diagnostics, []);
  assert.deepEqual(
    report.findings.map((finding) => finding.id),
    ["data.quality.completeness.items.b.author"],
  );
  const finding = report.findings[0]!;
  assert.equal(finding.severity, "warning");
  assert.equal(finding.record, "b");
  assert.equal(finding.field, "author");
  assert.match(finding.message, /Record "b" of collection "items" is missing field "author"/);
});

test("a record outside the rule's where is out of scope, not a finding", async () => {
  const { report } = await check();
  assert.deepEqual(report.scopes, [
    { collection: "items", kind: "completeness", checked: ["a", "b"], outOfScope: ["c"] },
  ]);
  assert.deepEqual(
    report.findings.map((finding) => finding.record),
    ["b"],
    "the out-of-scope record never becomes a finding",
  );
});

test("a config with quality parses without errors", async () => {
  const { config, diagnostics } = await check();
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(config.quality, {
    rules: [{ kind: "completeness", collection: "items", fields: ["author"], where: { status: "stable" } }],
    exceptions: [],
    policy: {},
  });
});

test("data quality exits 1 only when the policy makes a finding an error", async () => {
  const strict = tree({ ...SITE, "mizzen.yml": `${SITE["mizzen.yml"]!}  policy:\n    completeness: error\n` });
  try {
    const lines: string[] = [];
    const code = await main(["data", "quality", strict, "--json"], { log: (line: string) => void lines.push(line), error: () => {} });
    assert.equal(code, 1);
    const printed = JSON.parse(lines.join("")) as { findings: Array<{ severity: string }> };
    assert.equal(printed.findings[0]?.severity, "error");
  } finally {
    rmSync(strict, { recursive: true, force: true });
  }

  const lenient = tree(SITE);
  try {
    assert.equal(await main(["data", "quality", lenient], { log: () => {}, error: () => {} }), 0);
  } finally {
    rmSync(lenient, { recursive: true, force: true });
  }
});
