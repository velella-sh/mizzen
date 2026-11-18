import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
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

/** A site with one coverage rule for `author`: `a` holds it and `b` does not, so coverage is 50%. */
function coverageSite(maxDrop: number, baseline?: string): Record<string, string> {
  return {
    "mizzen.yml": [
      "collections:",
      "  items:",
      "    source: _data/items.yml",
      "quality:",
      "  rules:",
      "    - kind: coverage",
      "      collection: items",
      "      fields: [author]",
      `      maxDrop: ${maxDrop}`,
      "",
    ].join("\n"),
    "_data/items.yml": "- id: a\n  author: Ada\n- id: b\n",
    ...(baseline === undefined ? {} : { "data-quality.json": baseline }),
  };
}

/** A baseline of {@link coverageSite}'s two records, holding `fields` coverage. */
function baselineOf(fields: Record<string, number>): string {
  return `${JSON.stringify({ version: 1, collections: { items: { "*": { count: 2, fields } } } })}\n`;
}

/** Runs `mizzen data quality --json` over `root`: the exit code, and the report it printed. */
async function qualityJson(root: string, ...extra: readonly string[]): Promise<{
  readonly code: number;
  readonly printed: {
    readonly findings: readonly unknown[];
    readonly scopes: readonly unknown[];
    readonly diagnostics: readonly unknown[];
    readonly wrote?: string;
  };
}> {
  const lines: string[] = [];
  const code = await main(["data", "quality", root, "--json", ...extra], {
    log: (line: string) => void lines.push(line),
    error: () => {},
  });
  return { code, printed: JSON.parse(lines.join("")) };
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

test("coverage dropping above maxDrop reports before and after", async () => {
  const { report } = await check(coverageSite(10, baselineOf({ author: 100 })));
  assert.deepEqual(report.diagnostics, []);
  assert.deepEqual(report.findings, [
    {
      id: "data.quality.coverage.items.author",
      kind: "coverage",
      severity: "warning",
      collection: "items",
      record: "",
      field: "author",
      before: 100,
      after: 50,
      drop: 50,
      maxDrop: 10,
      message: 'Field "author" of collection "items" dropped from 100% to 50% coverage (drop 50, maxDrop 10).',
    },
  ]);
});

test("coverage dropping by exactly maxDrop is clean", async () => {
  const { report } = await check(coverageSite(30, baselineOf({ author: 80 })));
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.diagnostics, []);
});

test("a coverage rule without a baseline is a diagnostic", async () => {
  const { report } = await check(coverageSite(10));
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.diagnostics.map((diagnostic) => diagnostic.id), ["data.quality-baseline"]);
  assert.match(report.diagnostics[0]!.message, /data-quality\.json is missing/);
});

test("a malformed baseline is a diagnostic", async () => {
  const cases = [
    ["{", /not valid JSON/],
    ["{}", /not a quality baseline/],
  ] as const;
  for (const [text, pattern] of cases) {
    const { report } = await check(coverageSite(10, text));
    assert.deepEqual(report.findings, []);
    assert.deepEqual(report.diagnostics.map((diagnostic) => diagnostic.id), ["data.quality-baseline"]);
    assert.match(report.diagnostics[0]!.message, pattern);
  }
});

test("--write records a baseline that a second run passes", async () => {
  const root = tree(coverageSite(10));
  try {
    const written = await qualityJson(root, "--write");
    assert.equal(written.code, 0);
    assert.equal(written.printed.wrote, "data-quality.json");
    assert.deepEqual(written.printed.diagnostics, []);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "data-quality.json"), "utf8")), {
      version: 1,
      collections: { items: { "*": { count: 2, fields: { author: 50, id: 100 } } } },
    });

    const rerun = await qualityJson(root);
    assert.equal(rerun.code, 0);
    assert.deepEqual(rerun.printed.findings, []);
    assert.deepEqual(rerun.printed.diagnostics, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
