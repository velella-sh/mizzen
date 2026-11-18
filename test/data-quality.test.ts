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

/** {@link SITE}'s rule, with one exception for `record` (every record when omitted) that holds until `until`. */
function exceptionSite(asOf: string | undefined, record: string | undefined, until: string): Record<string, string> {
  return {
    "mizzen.yml": [
      "collections:",
      "  items:",
      "    source: _data/items.yml",
      ...(asOf === undefined ? [] : [`asOf: ${asOf}`]),
      "quality:",
      "  rules:",
      "    - kind: completeness",
      "      collection: items",
      "      fields: [author]",
      "      where: { status: stable }",
      "  exceptions:",
      "    - rule: completeness",
      ...(record === undefined ? [] : [`      record: ${record}`]),
      "      field: author",
      "      reason: Waiting for the author",
      `      until: ${until}`,
      "",
    ].join("\n"),
    "_data/items.yml": SITE["_data/items.yml"]!,
  };
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
    readonly groups: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
    readonly totals: { readonly findings: number; readonly warnings: number; readonly errors: number };
    readonly exceptions: readonly unknown[];
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

test("an exception with a reason holds its finding back through its until day", async () => {
  const { report } = await check(exceptionSite("2026-06-01", "b", "2026-06-01"));
  assert.deepEqual(report.diagnostics, []);
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.exceptions, [{
    rule: "completeness",
    record: "b",
    field: "author",
    reason: "Waiting for the author",
    until: "2026-06-01",
    suppressed: ["data.quality.completeness.items.b.author"],
  }]);
});

test("an exception past its until day reports as expired and no longer holds", async () => {
  const { report } = await check(exceptionSite("2026-06-02", "b", "2026-06-01"));
  assert.deepEqual(report.findings.map((finding) => finding.id), ["data.quality.completeness.items.b.author"]);
  assert.deepEqual(report.exceptions, []);
  assert.deepEqual(report.diagnostics.map((diagnostic) => diagnostic.id), ["data.quality-exception"]);
  assert.equal(report.diagnostics[0]!.severity, "warning");
  assert.match(report.diagnostics[0]!.message, /expired on 2026-06-01/);
});

test("an exception that holds back no finding reports as unused", async () => {
  const { report } = await check(exceptionSite("2026-06-01", "a", "2026-12-31"));
  assert.deepEqual(report.findings.map((finding) => finding.id), ["data.quality.completeness.items.b.author"]);
  assert.deepEqual(report.exceptions, []);
  assert.deepEqual(report.diagnostics.map((diagnostic) => diagnostic.id), ["data.quality-exception"]);
  assert.match(report.diagnostics[0]!.message, /held back no finding/);
});

test("without an as-of date a dated exception still holds, and the JSON report lists it", async () => {
  const root = tree(exceptionSite(undefined, undefined, "2020-01-01"));
  try {
    const { code, printed } = await qualityJson(root);
    assert.equal(code, 0);
    assert.deepEqual(printed.diagnostics, []);
    assert.deepEqual(printed.findings, []);
    assert.deepEqual(printed.exceptions, [{
      rule: "completeness",
      field: "author",
      reason: "Waiting for the author",
      until: "2020-01-01",
      suppressed: ["data.quality.completeness.items.b.author"],
    }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

/** A completeness rule on `author` for `b`, with a rule `severity` and a policy entry each when given. */
function severitySite(ruleSeverity?: string, policy?: string): Record<string, string> {
  return {
    "mizzen.yml": [
      "collections:",
      "  items:",
      "    source: _data/items.yml",
      "quality:",
      "  rules:",
      "    - kind: completeness",
      "      collection: items",
      "      fields: [author]",
      ...(ruleSeverity === undefined ? [] : [`      severity: ${ruleSeverity}`]),
      ...(policy === undefined ? [] : ["  policy:", `    completeness: ${policy}`]),
      "",
    ].join("\n"),
    "_data/items.yml": "- id: a\n  author: Ada\n- id: b\n",
  };
}

test("a rule severity of error fails the build, and outranks the policy", async () => {
  const errorRoot = tree(severitySite("error", "warning"));
  try {
    const { code, printed } = await qualityJson(errorRoot);
    assert.equal(code, 1);
    assert.deepEqual(printed.diagnostics, []);
    assert.deepEqual(printed.findings.map((finding) => (finding as { severity: string }).severity), ["error"]);
    assert.deepEqual(printed.totals, { findings: 1, warnings: 0, errors: 1 });
    assert.deepEqual(printed.groups, {
      items: { completeness: { kind: "completeness", count: 1, warnings: 0, errors: 1 } },
    });
  } finally {
    rmSync(errorRoot, { recursive: true, force: true });
  }

  const warningRoot = tree(severitySite("warning", "error"));
  try {
    const { code, printed } = await qualityJson(warningRoot);
    assert.equal(code, 0, "a warning rule keeps the build green under an error policy");
    assert.deepEqual(printed.findings.map((finding) => (finding as { severity: string }).severity), ["warning"]);
  } finally {
    rmSync(warningRoot, { recursive: true, force: true });
  }
});

test("an unknown rule severity is a config diagnostic, not a finding", async () => {
  const root = tree(severitySite("warn"));
  try {
    const { config, diagnostics } = loadConfig(root);
    assert.deepEqual(config.quality?.rules, [{ kind: "completeness", collection: "items", fields: ["author"] }]);
    assert.deepEqual(diagnostics.map((diagnostic) => diagnostic.id), ["config.invalid"]);
    assert.match(diagnostics[0]!.message, /severity/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

/** A site with one `kind` rule on `price`, with `bounds` as the rule's remaining YAML lines. */
function rangeSite(kind: "threshold" | "outlier", records: string, bounds = "      min: 0\n      max: 10"): Record<string, string> {
  return {
    "mizzen.yml": [
      "collections:",
      "  items:",
      "    source: _data/items.yml",
      "quality:",
      "  rules:",
      `    - kind: ${kind}`,
      "      collection: items",
      "      fields: [price]",
      bounds,
      "",
    ].join("\n"),
    "_data/items.yml": records,
  };
}

test("a value inside the threshold is clean", async () => {
  const { diagnostics, report } = await check(rangeSite("threshold", "- id: a\n  price: 5\n- id: b\n  price: 10\n- id: c\n  price: 0\n"));
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(report.findings, []);
});

test("a value outside the threshold reports the value and its bounds", async () => {
  const { config, report } = await check(rangeSite("threshold", "- id: a\n  price: -1\n- id: b\n  price: 12\n- id: c\n  price: high\n"));
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
      pos: { file: "_data/items.yml", line: 2, column: 10, endLine: 2, endColumn: 11 },
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
      pos: { file: "_data/items.yml", line: 4, column: 10, endLine: 4, endColumn: 11 },
      message: 'Record "b" of collection "items" has field "price" = 12, outside the threshold (min 0, max 10).',
    },
  ], "the non-numeric value of c is skipped");
});

test("a threshold rule without bounds is a diagnostic, not a crash", async () => {
  const { config, report } = await check(rangeSite("threshold", "- id: a\n  price: 5\n", ""));
  assert.deepEqual(config.quality?.rules, [{ kind: "threshold", collection: "items", fields: ["price"] }]);
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.diagnostics.map((diagnostic) => diagnostic.id), ["data.quality-bounds"]);
  assert.match(report.diagnostics[0]!.message, /needs min, max, or both/);
});

test("a value inside the outlier range is clean", async () => {
  const { diagnostics, report } = await check(rangeSite("outlier", "- id: a\n  price: 5\n- id: b\n  price: 10\n"));
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(report.findings, []);
});

test("an outlier reports the value and the range rule", async () => {
  const { config, report } = await check(rangeSite("outlier", "- id: a\n  price: 12\n- id: b\n  price: high\n"));
  assert.deepEqual(config.quality?.rules, [{ kind: "outlier", collection: "items", fields: ["price"], min: 0, max: 10 }]);
  assert.deepEqual(report.findings, [
    {
      id: "data.quality.outlier.items.a.price",
      kind: "outlier",
      severity: "warning",
      collection: "items",
      record: "a",
      field: "price",
      value: 12,
      min: 0,
      max: 10,
      pos: { file: "_data/items.yml", line: 2, column: 10, endLine: 2, endColumn: 11 },
      message: 'Record "a" of collection "items" has field "price" = 12, outside the range rule (min 0, max 10).',
    },
  ], "the non-numeric value of b is skipped");
});

/** Two collections and two kinds: `items` misses an author and holds an outlier, `posts` misses two titles. */
const GROUPED_SITE: Record<string, string> = {
  "mizzen.yml": [
    "collections:",
    "  items:",
    "    source: _data/items.yml",
    "  posts:",
    "    source: _data/posts.yml",
    "quality:",
    "  rules:",
    "    - kind: completeness",
    "      collection: items",
    "      fields: [author]",
    "    - kind: outlier",
    "      collection: items",
    "      fields: [price]",
    "      min: 0",
    "      max: 10",
    "    - kind: completeness",
    "      collection: posts",
    "      fields: [title]",
    "  policy:",
    "    completeness: error",
    "",
  ].join("\n"),
  "_data/items.yml": "- id: a\n  price: 50\n- id: b\n  author: Ada\n  price: 5\n",
  "_data/posts.yml": "- id: p\n- id: q\n",
};

test("the JSON report groups findings by collection and kind, in code-point order", async () => {
  const root = tree(GROUPED_SITE);
  try {
    const { code, printed } = await qualityJson(root);
    assert.equal(code, 1, "the policy makes completeness an error");
    assert.deepEqual(Object.keys(printed.groups), ["items", "posts"]);
    assert.deepEqual(Object.keys(printed.groups.items!), ["completeness", "outlier"]);
    assert.deepEqual(printed.groups, {
      items: {
        completeness: { kind: "completeness", count: 1, warnings: 0, errors: 1 },
        outlier: { kind: "outlier", count: 1, warnings: 1, errors: 0 },
      },
      posts: { completeness: { kind: "completeness", count: 2, warnings: 0, errors: 2 } },
    });
    assert.deepEqual(printed.totals, { findings: 4, warnings: 1, errors: 3 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the JSON report prints each finding's collection, kind, id, field, message, severity, and position", async () => {
  const root = tree(GROUPED_SITE);
  try {
    const { printed } = await qualityJson(root);
    const findings = printed.findings as ReadonlyArray<Record<string, unknown>>;
    assert.deepEqual(findings.map(({ id, kind, collection, record, field }) => ({ id, kind, collection, record, field })), [
      { id: "data.quality.completeness.items.a.author", kind: "completeness", collection: "items", record: "a", field: "author" },
      { id: "data.quality.outlier.items.a.price", kind: "outlier", collection: "items", record: "a", field: "price" },
      { id: "data.quality.completeness.posts.p.title", kind: "completeness", collection: "posts", record: "p", field: "title" },
      { id: "data.quality.completeness.posts.q.title", kind: "completeness", collection: "posts", record: "q", field: "title" },
    ]);
    assert.deepEqual(findings.map((finding) => finding.severity), ["error", "warning", "error", "error"]);
    assert.equal(findings[0]!.message, 'Record "a" of collection "items" is missing field "author".');
    assert.deepEqual(findings[1]!.pos, { file: "_data/items.yml", line: 2, column: 10, endLine: 2, endColumn: 11 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the JSON report prints a coverage finding's before and after", async () => {
  const root = tree(coverageSite(10, baselineOf({ author: 100 })));
  try {
    const { code, printed } = await qualityJson(root);
    assert.equal(code, 0, "a warning finding is not a failed build");
    assert.deepEqual(printed.findings, [
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
    assert.deepEqual(printed.groups, {
      items: { coverage: { kind: "coverage", count: 1, warnings: 1, errors: 0 } },
    });
    assert.deepEqual(printed.totals, { findings: 1, warnings: 1, errors: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

test("--write leaves the baseline untouched when a collection cannot load", async () => {
  const baseline = baselineOf({ id: 100, author: 100 });
  const root = tree({ ...coverageSite(10, baseline), "_data/items.yml": "- id: [\n" });
  try {
    const written = await qualityJson(root, "--write");
    assert.equal(written.code, 1);
    assert.equal(written.printed.wrote, undefined);
    assert.equal(readFileSync(join(root, "data-quality.json"), "utf8"), baseline);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--write leaves the baseline untouched when the config is invalid", async () => {
  const baseline = baselineOf({ id: 100, author: 100 });
  const site = coverageSite(10, baseline);
  const root = tree({ ...site, "mizzen.yml": `${site["mizzen.yml"]}unknown: true\n` });
  try {
    const written = await qualityJson(root, "--write");
    assert.equal(written.code, 1);
    assert.equal(written.printed.wrote, undefined);
    assert.equal(readFileSync(join(root, "data-quality.json"), "utf8"), baseline);
  } finally {
    rmSync(root, { recursive: true, force: true });
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

/** A site with one freshness rule on `updated`, dated `asOf` when given. */
function freshnessSite(records: string, asOf?: string): Record<string, string> {
  return {
    "mizzen.yml": [
      "collections:",
      "  items:",
      "    source: _data/items.yml",
      ...(asOf === undefined ? [] : [`asOf: ${asOf}`]),
      "quality:",
      "  rules:",
      "    - kind: freshness",
      "      collection: items",
      "      field: updated",
      "      maxAgeDays: 30",
      "",
    ].join("\n"),
    "_data/items.yml": records,
  };
}

test("a stale record is a finding; a fresh one is clean", async () => {
  const { config, report } = await check(freshnessSite(
    "- id: a\n  updated: 2026-03-10\n- id: b\n  updated: 2026-03-11\n- id: c\n  updated: 2026-04-01\n",
    "2026-04-10",
  ));
  assert.deepEqual(config.quality?.rules, [
    { kind: "freshness", collection: "items", field: "updated", maxAgeDays: 30 },
  ]);
  assert.deepEqual(report.diagnostics, []);
  assert.deepEqual(report.findings.map((finding) => finding.id), ["data.quality.freshness.items.a.updated"]);
  const finding = report.findings[0]!;
  assert.equal(finding.value, 31);
  assert.equal(finding.maxAgeDays, 30);
  assert.equal(finding.asOf, "2026-04-10");
  assert.equal(finding.pos?.file, "_data/items.yml");
  assert.equal(finding.pos?.line, 2);
  assert.match(finding.message, /dated 2026-03-10, 31 days before the as-of date 2026-04-10/);
});

test("a freshness rule without an as-of date is a diagnostic, not a crash", async () => {
  const { report } = await check(freshnessSite("- id: a\n  updated: 2026-03-10\n"));
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.diagnostics.map((diagnostic) => diagnostic.id), ["dates.no-as-of"]);
  assert.match(report.diagnostics[0]!.message, /freshness rule for collection "items" needs an as-of date/);
});

test("a record whose date field is not a date is a diagnostic at the field", async () => {
  const { report } = await check(freshnessSite("- id: a\n  updated: soon\n", "2026-04-10"));
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.diagnostics.map((diagnostic) => diagnostic.id), ["data.quality-date"]);
  assert.equal(report.diagnostics[0]!.pos?.line, 2);
  assert.match(report.diagnostics[0]!.message, /Record "a" of collection "items" has no valid date in field "updated"/);
});

test("--as-of is accepted by data quality and stands in for the config's asOf", async () => {
  const root = tree(freshnessSite("- id: a\n  updated: 2026-03-10\n"));
  try {
    const { code, printed } = await qualityJson(root, "--as-of", "2026-04-10");
    assert.equal(code, 0);
    assert.deepEqual(printed.findings.map((finding) => (finding as { id: string }).id), [
      "data.quality.freshness.items.a.updated",
    ]);
    assert.deepEqual(printed.diagnostics, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
