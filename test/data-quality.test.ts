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

/** A site with one count rule over `status: stable`: the baseline saw three, the data holds two. */
function countSite(maxDrop: number, baseline?: string): Record<string, string> {
  return {
    "mizzen.yml": [
      "collections:",
      "  items:",
      "    source: _data/items.yml",
      "quality:",
      "  rules:",
      "    - kind: count",
      "      collection: items",
      "      where: { status: stable }",
      `      maxDrop: ${maxDrop}`,
      "",
    ].join("\n"),
    "_data/items.yml": "- id: a\n  status: stable\n- id: b\n  status: stable\n- id: c\n  status: draft\n",
    ...(baseline === undefined ? {} : { "data-quality.json": baseline }),
  };
}

/** A baseline of {@link countSite}'s scope, holding `count` records. */
function countBaselineOf(count: number): string {
  return `${JSON.stringify({ version: 1, collections: { items: { '{"status":"stable"}': { count, fields: {} } } } })}\n`;
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

test("a record count dropping above maxDrop reports before and after", async () => {
  const { report } = await check(countSite(0, countBaselineOf(3)));
  assert.deepEqual(report.diagnostics, []);
  assert.deepEqual(report.findings, [
    {
      id: "data.quality.count.items",
      kind: "count",
      severity: "warning",
      collection: "items",
      record: "",
      field: "",
      before: 3,
      after: 2,
      drop: 1,
      maxDrop: 0,
      message: 'Collection "items" dropped from 3 to 2 records (drop 1, maxDrop 0).',
    },
  ]);
});

test("a record count dropping by exactly maxDrop is clean", async () => {
  const { report } = await check(countSite(1, countBaselineOf(3)));
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.diagnostics, []);
});

/** A site with one threshold rule on `price`, with `bounds` as the rule's remaining YAML lines. */
function thresholdSite(records: string, bounds = "      min: 0\n      max: 10"): Record<string, string> {
  return {
    "mizzen.yml": [
      "collections:",
      "  items:",
      "    source: _data/items.yml",
      "quality:",
      "  rules:",
      "    - kind: threshold",
      "      collection: items",
      "      fields: [price]",
      bounds,
      "",
    ].join("\n"),
    "_data/items.yml": records,
  };
}

test("a value inside the threshold is clean", async () => {
  const { diagnostics, report } = await check(thresholdSite("- id: a\n  price: 5\n- id: b\n  price: 10\n- id: c\n  price: 0\n"));
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(report.findings, []);
});

test("a value outside the threshold reports the value and its bounds", async () => {
  const { config, report } = await check(thresholdSite("- id: a\n  price: -1\n- id: b\n  price: 12\n- id: c\n  price: high\n"));
  assert.deepEqual(config.quality?.rules, [{ kind: "threshold", collection: "items", fields: ["price"], min: 0, max: 10 }]);
  assert.deepEqual(report.findings, [
    {
      id: "data.quality.threshold.items.a.price",
      kind: "threshold",
      severity: "warning",
      collection: "items",
      record: "a",
      field: "price",
      value: -1,
      min: 0,
      max: 10,
      message: 'Record "a" of collection "items" has field "price" = -1, outside the threshold (min 0, max 10).',
    },
    {
      id: "data.quality.threshold.items.b.price",
      kind: "threshold",
      severity: "warning",
      collection: "items",
      record: "b",
      field: "price",
      value: 12,
      min: 0,
      max: 10,
      message: 'Record "b" of collection "items" has field "price" = 12, outside the threshold (min 0, max 10).',
    },
  ], "the non-numeric value of c is skipped");
});

test("a threshold rule without bounds is a diagnostic, not a crash", async () => {
  const { config, report } = await check(thresholdSite("- id: a\n  price: 5\n", ""));
  assert.deepEqual(config.quality?.rules, [{ kind: "threshold", collection: "items", fields: ["price"] }]);
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.diagnostics.map((diagnostic) => diagnostic.id), ["data.quality-bounds"]);
  assert.match(report.diagnostics[0]!.message, /needs min, max, or both/);
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

test("--write records a count baseline that a second run passes", async () => {
  const root = tree(countSite(0));
  try {
    const written = await qualityJson(root, "--write");
    assert.equal(written.code, 0);
    assert.equal(written.printed.wrote, "data-quality.json");
    assert.deepEqual(written.printed.diagnostics, []);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "data-quality.json"), "utf8")), {
      version: 1,
      collections: {
        items: {
          "*": { count: 3, fields: { id: 100, status: 100 } },
          '{"status":"stable"}': { count: 2, fields: { id: 100, status: 100 } },
        },
      },
    });

    const rerun = await qualityJson(root);
    assert.equal(rerun.code, 0);
    assert.deepEqual(rerun.printed.findings, []);
    assert.deepEqual(rerun.printed.diagnostics, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
