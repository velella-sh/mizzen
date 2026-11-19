import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import { main } from "../src/cli/index.ts";
import { compareReports, reproduce } from "../src/cli/reproduce.ts";
import { build } from "../src/pipeline/build.ts";
import {
  BUILD_REPORT_PATH,
  buildReportOf,
  buildReportText,
  compareBuildReports,
  comparisonJson,
  comparisonText,
  preflightReport,
  preflightText,
  readBuildReport,
  validateBuildReport,
  type BuildReport,
} from "../src/reproduce/manifest.ts";

const THEME = fileURLToPath(new URL("../../lateen", import.meta.url));
const BIN = fileURLToPath(new URL("../bin/mizzen.ts", import.meta.url));

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "reproduce-"));
}

function site(parent: string, files: Readonly<Record<string, string>>): string {
  const root = join(parent, "site");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const CONFIG = "title: Demo\nurl: https://example.com\ndefaults:\n  - path: \"\"\n    values:\n      layout: doc\n";

async function reportFor(root: string, out: string): Promise<BuildReport> {
  const result = await build({ root, out, themeRoot: THEME, defaultLayout: "doc" });
  assert.deepEqual(result.diagnostics.filter((finding) => finding.severity === "error"), []);
  return buildReportOf({ root, out, themeRoot: THEME });
}

function cloneReport(report: BuildReport): BuildReport {
  return JSON.parse(JSON.stringify(report)) as BuildReport;
}

function capture(): { logs: string[]; errors: string[]; io: { log: (m: string) => void; error: (m: string) => void } } {
  const logs: string[] = [];
  const errors: string[] = [];
  return { logs, errors, io: { log: (m: string) => logs.push(m), error: (m: string) => errors.push(m) } };
}

test("a report is deterministic and independent of the checkout path", async () => {
  const one = scratch();
  const two = scratch();
  try {
    const firstRoot = site(one, { "mizzen.yml": CONFIG, "index.md": "# Hello\n" });
    const secondRoot = site(two, { "mizzen.yml": CONFIG, "index.md": "# Hello\n" });
    const first = await reportFor(firstRoot, join(one, "out"));
    const second = await reportFor(secondRoot, join(two, "out"));

    assert.deepEqual(second, first);
    assert.equal(buildReportText(second), buildReportText(first));
    const text = buildReportText(first);
    assert.equal(text.includes(one), false, "the checkout path does not leak");
    assert.equal(text.includes(two), false, "the other checkout path does not leak");
    assert.deepEqual(first.outputs.files["index.html"], second.outputs.files["index.html"]);
    assert.equal(validateBuildReport(first), undefined);
  } finally {
    rmSync(one, { recursive: true, force: true });
    rmSync(two, { recursive: true, force: true });
  }
});

test("an intentional time zone difference is visible and attributable", async () => {
  const parent = scratch();
  try {
    const reports: BuildReport[] = [];
    for (const [name, tz] of [["utc", "UTC"], ["far", "Pacific/Kiritimati"]] as const) {
      const root = site(join(parent, name), {
        "mizzen.yml": CONFIG,
        "index.md": "# Hello\n",
        "mizzen.config.ts":
          "export default { plugins: [{ name: \"env\", inputs: [], outputs(files) { return [...files, { path: \"env.txt\", contents: `${process.env.TZ ?? \"\"}\\n` }]; } }] };\n",
      });
      const out = join(parent, `${name}-out`);
      const run = spawnSync(process.execPath, [BIN, "build", root, "--out", out, "--theme", THEME, "--diagnose"], {
        encoding: "utf8",
        env: { ...process.env, TZ: tz },
      });
      assert.equal(run.status, 0, run.stderr);
      const read = await readBuildReport(join(root, BUILD_REPORT_PATH));
      assert.equal("error" in read, false);
      if ("error" in read) throw new Error(read.error);
      reports.push(read.report);
      const env = readFileSync(join(out, "env.txt"), "utf8") as string;
      assert.equal(env.trim(), tz);
    }
    const comparison = compareBuildReports(reports[0]!, reports[1]!);
    assert.notEqual(reports[0]!.environment.timezone, reports[1]!.environment.timezone);
    assert.equal(comparison.differences.environment.length > 0, true);
    assert.equal(comparison.differences.outputs.length > 0, true);
    assert.equal(comparison.unexplained, false, "the environment difference explains the output");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("comparison names every category, and a bare output change is unexplained", () => {
  const report: BuildReport = {
    format: 1,
    categories: ["inputs", "config", "tools", "environment", "outputs"],
    inputs: { locks: {}, data: {}, content: { "index.md": "a".repeat(64) } },
    config: {
      sha256: "b".repeat(64),
      referenceDate: "2026-11-19",
      rules: { defaults: [], redirects: {}, outputs: {}, collections: {}, feeds: [], calendars: [] },
    },
    tools: { mizzen: "0.2.4", node: "24.0.0", theme: { name: "theme", version: "1.0.0" } },
    environment: { timezone: "UTC", locale: "en-US" },
    outputs: { hash: "c".repeat(64), files: { "index.html": "d".repeat(64) } },
  };
  assert.equal(validateBuildReport(report), undefined);

  const changed = cloneReport(report);
  const wrong = changed as unknown as Record<string, any>;
  wrong.inputs.content["index.md"] = "e".repeat(64);
  wrong.config.sha256 = "f".repeat(64);
  wrong.tools.node = "25.0.0";
  wrong.environment.timezone = "Pacific/Kiritimati";
  wrong.outputs.files["index.html"] = "1".repeat(64);
  wrong.outputs.hash = "2".repeat(64);
  const explained = compareBuildReports(report, changed);
  for (const category of ["inputs", "config", "tools", "environment", "outputs"] as const) {
    assert.equal(explained.differences[category].length > 0, true, category);
  }
  assert.equal(explained.unexplained, false);

  const outputOnly = cloneReport(report);
  const only = outputOnly as unknown as Record<string, any>;
  only.outputs.files["index.html"] = "3".repeat(64);
  only.outputs.hash = "4".repeat(64);
  const unexplained = compareBuildReports(report, outputOnly);
  assert.equal(unexplained.differences.outputs.length > 0, true);
  assert.equal(unexplained.unexplained, true);
});

test("preflight names a missing input and an incompatible version before building", async () => {
  const parent = scratch();
  try {
    const root = site(parent, {
      "mizzen.yml": `${CONFIG}collections:\n  items:\n    source: _data/items.yml\n    permalink: /items/{id}/\n`,
      "index.md": "# Hello\n",
      "_data/items.yml": "- id: a\n  title: A\n",
    });
    const report = await reportFor(root, join(parent, "out"));

    rmSync(join(root, "_data/items.yml"));
    const missing = await preflightReport(report, { root, themeRoot: THEME });
    assert.equal(missing.ok, false);
    assert.match(missing.problems.map((problem) => problem.message).join("\n"), /missing (content|data) input .*items\.yml/);

    const incompatible = cloneReport(report) as unknown as Record<string, any>;
    incompatible.tools.mizzen = "0.0.0";
    const tools = await preflightReport(incompatible as BuildReport, { root, themeRoot: THEME });
    assert.equal(tools.ok, false);
    assert.match(tools.problems.map((problem) => problem.message).join("\n"), /Mizzen 0\.0\.0/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("preflight names tool, input, and environment differences together", async () => {
  const parent = scratch();
  try {
    const root = site(parent, {
      "mizzen.yml": `${CONFIG}collections:\n  items:\n    source: _data/items.yml\n`,
      "index.md": "# Hello\n",
      "_data/items.yml": "- id: a\n",
      "mizzen.lock.json": '{"version":1,"sources":{}}\n',
    });
    const report = await reportFor(root, join(parent, "out"));
    const changed = cloneReport(report) as unknown as Record<string, any>;
    changed.tools.node = "25.0.0";
    changed.tools.theme.version = "0.0.0";
    changed.inputs.locks["mizzen.lock.json"] = "1".repeat(64);
    for (const path of Object.keys(changed.inputs.data)) changed.inputs.data[path] = "2".repeat(64);
    for (const path of Object.keys(changed.inputs.content)) changed.inputs.content[path] = "3".repeat(64);
    changed.environment.timezone = "Pacific/Kiritimati";
    changed.environment.locale = "fa-IR";

    const result = await preflightReport(changed as BuildReport, { root, themeRoot: THEME });
    const messages = result.problems.map((problem) => problem.message).join("\n");
    assert.equal(result.ok, false);
    assert.match(messages, /Node 25\.0\.0/);
    assert.match(messages, /theme .* 0\.0\.0/);
    assert.match(messages, /lock file mizzen\.lock\.json differs/);
    assert.match(messages, /data input .*items\.yml differs/);
    assert.match(messages, /content input .* differs/);
    assert.match(messages, /time zone Pacific\/Kiritimati/);
    assert.match(messages, /locale fa-IR/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a clean checkout with an imported input package reproduces the output hashes", async () => {
  const parent = scratch();
  try {
    const source = site(parent, {
      "mizzen.yml": `${CONFIG}collections:\n  items:\n    source: _data/items.yml\n    permalink: /items/{id}/\n`,
      "index.md": "# Hello\n",
      "_data/items.yml": "- id: a\n  title: A\n",
    });
    const target = await reportFor(source, join(parent, "out-source"));
    const reportFile = join(parent, "target.json");
    writeFileSync(reportFile, buildReportText(target));

    const fresh = site(join(parent, "fresh-parent"), {
      "mizzen.yml": `${CONFIG}collections:\n  items:\n    source: _data/items.yml\n    permalink: /items/{id}/\n`,
      "index.md": "# Hello\n",
    });
    const pack = join(parent, "inputs.mizzenpack");
    const exported = capture();
    assert.equal(await main(["inputs", "export", source, "--out", pack], exported.io), 0, exported.errors.join("\n"));
    const imported = capture();
    assert.equal(await main(["inputs", "import", pack, fresh], imported.io), 0, imported.errors.join("\n"));

    const run = await reproduce({
      manifest: reportFile,
      root: fresh,
      out: join(parent, "out-fresh"),
      themeRoot: THEME,
      check: false,
      format: "text",
    });
    assert.equal(run.code, 0, `${run.output}\n${run.problems.join("\n")}`);
    assert.match(run.output, /identical: every category matches/);
    const freshReport = JSON.parse(readFileSync(join(fresh, BUILD_REPORT_PATH), "utf8")) as BuildReport;
    assert.equal(freshReport.outputs.hash, target.outputs.hash);
    assert.deepEqual({ ...freshReport.outputs.files }, { ...target.outputs.files });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a report fingerprints rule values instead of copying secrets", async () => {
  const parent = scratch();
  const secret = "do-not-write-this-token";
  try {
    const root = site(parent, {
      "mizzen.yml": `${CONFIG}collections:\n  items:\n    source: _data/items.yml\n    transform:\n      steps:\n        - op: default\n          field: token\n          value: ${secret}\nredirects:\n  /old/: https://example.com/?token=${secret}\n`,
      "index.md": "# Hello\n",
      "_data/items.yml": "- id: a\n",
    });
    const report = await reportFor(root, join(parent, "out"));
    const text = buildReportText(report);
    assert.equal(text.includes(secret), false);
    assert.equal(validateBuildReport(report), undefined);

    const detailed = cloneReport(report) as unknown as Record<string, any>;
    detailed.config.rules.collections.items.derived = { age: "a".repeat(64) };
    detailed.config.rules.quality = { sha256: "b".repeat(64) };
    assert.equal(validateBuildReport(detailed as BuildReport), undefined);
    for (const rawValue of [
      (raw: Record<string, any>) => { raw.config.rules.redirects["/old/"] = secret; },
      (raw: Record<string, any>) => { raw.config.rules.collections.items.transform = { steps: [{ value: secret }] }; },
      (raw: Record<string, any>) => { raw.config.rules.collections.items.derived.age = secret; },
      (raw: Record<string, any>) => { raw.config.rules.quality = { rules: [secret] }; },
      (raw: Record<string, any>) => { raw.config.rules.extra = { value: secret }; },
      (raw: Record<string, any>) => { raw.config.rules.defaults[0].extra = secret; },
    ]) {
      const raw = cloneReport(detailed as BuildReport) as unknown as Record<string, any>;
      rawValue(raw);
      assert.notEqual(validateBuildReport(raw as BuildReport), undefined);
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("the schema accepts a generated report and refuses another format or category list", async () => {
  const parent = scratch();
  try {
    const root = site(parent, { "mizzen.yml": CONFIG, "index.md": "# Hello\n" });
    const report = await reportFor(root, join(parent, "out"));
    const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;
    const schema = JSON.parse(readFileSync(new URL("../schema/build-report.schema.json", import.meta.url), "utf8")) as object;
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
    assert.equal(validate(report), true, JSON.stringify(validate.errors));
    const raw = cloneReport(report) as unknown as Record<string, any>;
    raw.config.rules.collections.items = { transform: { steps: [{ value: "secret" }] } };
    assert.equal(validate(raw), false, "the schema refuses raw transform values");
    assert.equal(validateBuildReport({ ...report, format: 2 }), "format 2 is not the format this version reads (1)");
    assert.match(validateBuildReport({ ...report, categories: ["inputs", "outputs"] }) ?? "", /categories/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});


test("report readers and comparison commands return structured usage errors", async () => {
  const parent = scratch();
  const missing = join(parent, "missing.json");
  try {
    const unreadable = await readBuildReport(missing);
    assert.match("error" in unreadable ? unreadable.error : "", /cannot be read/);

    const invalid = join(parent, "invalid.json");
    writeFileSync(invalid, "not-json\n");
    const invalidJson = await readBuildReport(invalid);
    assert.match("error" in invalidJson ? invalidJson.error : "", /not valid JSON/);
    writeFileSync(invalid, "{}\n");
    const invalidShape = await readBuildReport(invalid);
    assert.match("error" in invalidShape ? invalidShape.error : "", /not a build report/);

    assert.equal((await reproduce({ manifest: missing, root: parent, out: join(parent, "out"), themeRoot: THEME, check: false, format: "text" })).code, 2);
    assert.equal((await compareReports({ before: missing, after: missing, format: "text" })).code, 2);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("reproduce --check and compare expose preflight and comparison output without rebuilding", async () => {
  const parent = scratch();
  try {
    const root = site(parent, { "mizzen.yml": CONFIG, "index.md": "# Hello\n" });
    const report = await reportFor(root, join(parent, "out"));
    const manifest = join(parent, "report.json");
    writeFileSync(manifest, buildReportText(report));

    const checked = await reproduce({ manifest, root, out: join(parent, "unused"), themeRoot: THEME, check: true, format: "json" });
    assert.equal(checked.code, 0, checked.problems.join("\n"));
    assert.equal(JSON.parse(checked.output).ok, true);

    const incompatible = cloneReport(report) as unknown as Record<string, any>;
    incompatible.tools.mizzen = "0.0.0";
    writeFileSync(manifest, buildReportText(incompatible as BuildReport));
    const refused = await reproduce({ manifest, root, out: join(parent, "unused"), themeRoot: THEME, check: false, format: "text" });
    assert.equal(refused.code, 1);
    assert.match(refused.problems.join("\n"), /Mizzen 0\.0\.0/);

    writeFileSync(manifest, buildReportText(report));
    const other = join(parent, "other.json");
    writeFileSync(other, buildReportText(report));
    const compared = await compareReports({ before: manifest, after: other, format: "json" });
    assert.equal(compared.code, 0);
    assert.equal(JSON.parse(compared.output).same, true);
    assert.equal((await compareReports({ before: manifest, after: join(parent, "absent.json"), format: "text" })).code, 2);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("text and JSON comparisons and preflight output preserve every category", () => {
  const base: BuildReport = {
    format: 1,
    categories: ["inputs", "config", "tools", "environment", "outputs"],
    inputs: { locks: {}, data: {}, content: {} },
    config: { sha256: "a".repeat(64), rules: { defaults: [], redirects: {}, outputs: {}, collections: {}, feeds: [], calendars: [] } },
    tools: { mizzen: "0.2.5", node: "24.0.0", theme: { name: "theme", version: "1" } },
    environment: { timezone: "UTC", locale: "en-US" },
    outputs: { hash: "b".repeat(64), files: {} },
  };
  const changed = cloneReport(base) as unknown as Record<string, any>;
  changed.outputs.hash = "c".repeat(64);
  const comparison = compareBuildReports(base, changed as BuildReport);
  assert.match(comparisonText(comparison), /unexplained:/);
  assert.match(comparisonText(comparison), /outputs: 1 difference/);
  assert.equal(JSON.parse(comparisonJson(comparison)).unexplained, true);
  assert.match(preflightText({ ok: true, problems: [] }), /reproducible:/);
  assert.match(preflightText({ ok: false, problems: [{ category: "inputs", message: "missing", fatal: true }] }), /error: inputs: missing/);
});
