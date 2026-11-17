import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { doctor, doctorReport, MIN_NODE_MAJOR, runtimeDiagnostic } from "../src/cli/doctor.ts";
import type { DoctorReport } from "../src/cli/doctor-report.ts";
import { COMMANDS, main, NAME, parseArgs, usage } from "../src/cli/index.ts";

const THEME = fileURLToPath(new URL("../../lateen", import.meta.url));

/** A temporary folder holding `files`. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "cli-doctor-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** The state of every check in a report, keyed by check id. */
function statesOf(report: DoctorReport): Record<string, string> {
  return Object.fromEntries(report.checks.map((check) => [check.id, check.state]));
}

function capture() {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    io: {
      log: (m: string) => {
        logs.push(m);
      },
      error: (m: string) => {
        errors.push(m);
      },
    },
  };
}

const VALID: Record<string, string> = {
  "mizzen.yml":
    "title: Demo\nurl: https://example.com\ndefaults:\n  - path: \"\"\n    values:\n      layout: doc\n",
  "index.md": "# Hello\n",
};

test("parseArgs: doctor defaults, flags, and usage errors", () => {
  assert.deepEqual(parseArgs(["doctor"]), {
    options: { command: "doctor", root: ".", format: "text" },
  });
  assert.deepEqual(parseArgs(["doctor", "site", "--theme", "/t", "--format", "json"]), {
    options: { command: "doctor", root: "site", format: "json", theme: "/t" },
  });
  assert.equal("error" in parseArgs(["doctor", "--out", "dist"]), true);
  assert.equal("error" in parseArgs(["doctor", "--hash", "abc"]), true);
  assert.equal("error" in parseArgs(["doctor", "--format", "yaml"]), true);
  assert.match(usage, /doctor \[dir\]/);
  assert.ok(usage.includes("text, json, or sarif (check and doctor"), "the help names doctor for --format");
});

test("every registered command parses and is documented", () => {
  for (const command of COMMANDS) {
    assert.deepEqual(parseArgs([command, "--help"]), { help: true }, `\`${NAME} ${command}\` is registered`);
    assert.ok(usage.includes(`\n  ${command} `), `the help lists \`${NAME} ${command}\``);
  }
});

test("doctor exits 0 for a valid site, prints the count, and writes nothing", async () => {
  const root = tree(VALID);
  const before = readdirSync(root).sort();
  const { logs, errors, io } = capture();
  try {
    assert.equal(await main(["doctor", root, "--theme", THEME], io), 0);
    assert.deepEqual(errors, []);
    assert.equal(logs.join("\n"), "0 errors, 0 warnings");
    assert.deepEqual(readdirSync(root).sort(), before, "the site folder is untouched");
    assert.equal(existsSync(join(root, "dist")), false, "no output folder appears");
    assert.equal(existsSync(join(root, ".mizzen")), false, "no cache appears");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor prints an empty machine-readable report for a valid site", async () => {
  const root = tree(VALID);
  try {
    const json = capture();
    assert.equal(await main(["doctor", root, "--theme", THEME, "--format", "json"], json.io), 0);
    assert.deepEqual(JSON.parse(json.logs.join("\n")), { version: 1, diagnostics: [] });

    const sarif = capture();
    assert.equal(await main(["doctor", root, "--theme", THEME, "--format", "sarif"], sarif.io), 0);
    const log = JSON.parse(sarif.logs.join("\n")) as {
      version: string;
      runs: { tool: { driver: { name: string } }; results: unknown[] }[];
    };
    assert.equal(log.version, "2.1.0");
    assert.equal(log.runs[0]?.tool.driver.name, NAME);
    assert.deepEqual(log.runs[0]?.results, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an invalid config exits 1 with an actionable finding at the config file", async () => {
  const root = tree({ ...VALID, "mizzen.yml": `${VALID["mizzen.yml"]}not_a_key: true\n` });
  const { logs, errors, io } = capture();
  try {
    assert.equal(await main(["doctor", root, "--theme", THEME], io), 1);
    assert.deepEqual(errors, []);
    const text = logs.join("\n");
    assert.match(text, /mizzen\.yml:\d+:1\s+config\.unknown-key\s+Unknown key `not_a_key`\./);
    assert.ok(text.includes("help:"), "the finding says how to fix it");
    assert.match(text, /1 error, 0 warnings/);
    assert.equal(text.match(/config\.unknown-key/g)?.length, 1, "the config finding is reported once");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an invalid config is machine-readable and still leaves the site untouched", async () => {
  const root = tree({ ...VALID, "mizzen.yml": `${VALID["mizzen.yml"]}not_a_key: true\n` });
  const before = readdirSync(root).sort();
  try {
    const json = capture();
    assert.equal(await main(["doctor", root, "--theme", THEME, "--format", "json"], json.io), 1);
    const report = JSON.parse(json.logs.join("\n")) as {
      version: number;
      diagnostics: { id: string; severity: string; message: string; help?: string }[];
    };
    assert.equal(report.version, 1);
    const finding = report.diagnostics.find((d) => d.id === "config.unknown-key");
    assert.ok(finding !== undefined);
    assert.equal(finding.severity, "error");
    assert.match(finding.message, /not_a_key/);
    assert.equal(typeof finding.help, "string");
    assert.deepEqual(readdirSync(root).sort(), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("content errors are reported with their source positions", async () => {
  const root = tree({
    ...VALID,
    "a.md": "---\npermalink: /same/\n---\n# A\n",
    "b.md": "---\npermalink: /same/\n---\n# B\n",
  });
  const { logs, io } = capture();
  try {
    assert.equal(await main(["doctor", root, "--theme", THEME], io), 1);
    const text = logs.join("\n");
    assert.ok(text.includes("page.duplicate-url"), "the duplicate URL is named");
    assert.match(text, /b\.md:\d+:\d+/, "the finding points at a source file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing source folder is one actionable finding, not a crash", async () => {
  const root = tree({ "mizzen.yml": "title: Demo\nsource: docs\n", "index.md": "# Not in the source folder\n" });
  const { logs, errors, io } = capture();
  try {
    assert.equal(await main(["doctor", root, "--theme", THEME], io), 1);
    assert.deepEqual(errors, []);
    const text = logs.join("\n");
    assert.ok(text.includes("doctor.source-missing"));
    assert.ok(text.includes('"docs"'));
    assert.ok(text.includes("help:"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("without a theme, doctor names it and still checks the content", async () => {
  const root = tree({
    ...VALID,
    "a.md": "---\npermalink: /same/\n---\n# A\n",
    "b.md": "---\npermalink: /same/\n---\n# B\n",
  });
  try {
    const diagnostics = await doctor({ root });
    const ids = diagnostics.map((d) => d.id);
    assert.ok(ids.includes("doctor.missing-theme"));
    assert.ok(ids.includes("page.duplicate-url"), "content is checked without a theme");
    assert.equal(diagnostics.every((d) => d.help !== undefined), true, "every finding is actionable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the runtime check fails only below the engine's oldest Node", () => {
  assert.equal(runtimeDiagnostic(`${MIN_NODE_MAJOR}.0.0`), undefined);
  assert.equal(runtimeDiagnostic("27.1.0"), undefined);
  const old = runtimeDiagnostic("22.11.0");
  assert.equal(old?.id, "doctor.node-version");
  assert.equal(old?.severity, "error");
  assert.match(old?.message ?? "", /22\.11\.0/);
  assert.match(old?.help ?? "", new RegExp(`Node\\.js ${MIN_NODE_MAJOR}`));
});

test("doctor reports the runtime check through the same diagnostics", async () => {
  const root = tree(VALID);
  try {
    const diagnostics = await doctor({ root, themeRoot: THEME, defaultLayout: "doc", nodeVersion: "22.11.0" });
    assert.deepEqual(diagnostics.map((d) => d.id), ["doctor.node-version"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const DATA_SCHEMA = JSON.stringify({
  type: "object",
  required: ["title"],
  properties: { id: { type: "string" }, title: { type: "string" } },
});

const DATA_FILES: Record<string, string> = {
  "mizzen.yml":
    "title: Demo\nurl: https://example.com\n" +
    "defaults:\n  - path: \"\"\n    values:\n      layout: doc\n" +
    "collections:\n  items:\n    source: _data/items.yml\n    schema: _data/items.schema.json\n",
  "index.md": "# Hello\n",
  "_data/items.schema.json": DATA_SCHEMA,
};

test("the data check passes and fails on its own, and doctor reports the counts", async () => {
  const good = tree({ ...DATA_FILES, "_data/items.yml": "- id: one\n  title: First\n" });
  const bad = tree({ ...DATA_FILES, "_data/items.yml": "- id: one\n" });
  try {
    const passed = await doctorReport({
      root: good,
      themeRoot: THEME,
      defaultLayout: "doc",
      nodeVersion: `${MIN_NODE_MAJOR}.0.0`,
    });
    assert.deepEqual(statesOf(passed), {
      runtime: "passed",
      config: "passed",
      content: "passed",
      drift: "passed",
      data: "passed",
      theme: "passed",
      render: "passed",
      output: "passed",
    });
    const summary = passed.diagnostics.find((diagnostic) => diagnostic.id === "doctor.data-summary");
    assert.match(summary?.message ?? "", /Data: 1 collection, 1 loaded, 1 read, 1 record kept, 0 skipped, 1 schema\./);
    assert.equal(summary?.severity, "info");

    const failed = await doctorReport({
      root: bad,
      themeRoot: THEME,
      defaultLayout: "doc",
      nodeVersion: `${MIN_NODE_MAJOR}.0.0`,
    });
    assert.equal(statesOf(failed).content, "passed", "a data finding never fails the content check");
    assert.equal(statesOf(failed).data, "failed");
    const finding = failed.diagnostics.find((diagnostic) => diagnostic.id === "data.record-invalid");
    assert.equal(finding?.pos?.file, "_data/items.yml", "the data file is the location");
    assert.match(
      failed.diagnostics.find((diagnostic) => diagnostic.id === "doctor.data-summary")?.message ?? "",
      /1 skipped/,
    );
  } finally {
    rmSync(good, { recursive: true, force: true });
    rmSync(bad, { recursive: true, force: true });
  }
});

test("doctor reports a data finding in text, JSON, and SARIF at the data file", async () => {
  const root = tree({ ...DATA_FILES, "_data/items.yml": "- id: one\n" });
  try {
    const text = capture();
    assert.equal(await main(["doctor", root, "--theme", THEME], text.io), 1);
    assert.match(text.logs.join("\n"), /_data\/items\.yml:\d+:\d+\s+data\.record-invalid/);

    const json = capture();
    assert.equal(await main(["doctor", root, "--theme", THEME, "--format", "json"], json.io), 1);
    const report = JSON.parse(json.logs.join("\n")) as {
      diagnostics: { id: string; pos?: { file: string } }[];
    };
    const finding = report.diagnostics.find((diagnostic) => diagnostic.id === "data.record-invalid");
    assert.equal(finding?.pos?.file, "_data/items.yml");

    const sarif = capture();
    assert.equal(await main(["doctor", root, "--theme", THEME, "--format", "sarif"], sarif.io), 1);
    const log = JSON.parse(sarif.logs.join("\n")) as {
      runs: {
        tool: { driver: { rules: { id: string }[] } };
        results: { ruleId: string; locations?: { physicalLocation: { artifactLocation: { uri: string } } }[] }[];
      }[];
    };
    const run = log.runs[0]!;
    assert.ok(run.tool.driver.rules.some((rule) => rule.id === "data.record-invalid"));
    assert.equal(
      run.results.find((result) => result.ruleId === "data.record-invalid")?.locations?.[0]?.physicalLocation.artifactLocation.uri,
      "_data/items.yml",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("data is checked even when the page source folder is missing", async () => {
  const root = tree({
    "mizzen.yml":
      "title: Demo\nsource: docs\n" +
      "collections:\n  items:\n    source: data/items.yml\n    schema: schemas/items.json\n",
    "data/items.yml": "- id: one\n",
    "schemas/items.json": DATA_SCHEMA,
  });
  try {
    const report = await doctorReport({
      root,
      themeRoot: THEME,
      defaultLayout: "doc",
      nodeVersion: `${MIN_NODE_MAJOR}.0.0`,
    });
    assert.equal(statesOf(report).content, "skipped", "the pages folder is still missing");
    assert.equal(statesOf(report).data, "failed", "its own input is enough to check the records");
    const finding = report.diagnostics.find((diagnostic) => diagnostic.id === "data.record-invalid");
    assert.equal(finding?.pos?.file, "data/items.yml");
    const summary = report.diagnostics.find((diagnostic) => diagnostic.id === "doctor.data-summary");
    assert.match(summary?.message ?? "", /Data: 1 collection, 1 loaded, 1 read, 0 records kept, 1 skipped, 1 schema\./);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a broken content source and a broken collection fail their own checks, independently", async () => {
  const root = tree({
    ...DATA_FILES,
    "_data/items.yml": "- id: one\n",
    "a.md": "---\npermalink: /same/\n---\n# A\n",
    "b.md": "---\npermalink: /same/\n---\n# B\n",
  });
  try {
    const report = await doctorReport({
      root,
      themeRoot: THEME,
      defaultLayout: "doc",
      nodeVersion: `${MIN_NODE_MAJOR}.0.0`,
    });
    assert.equal(statesOf(report).content, "failed");
    assert.equal(statesOf(report).data, "failed");
    const ids = report.diagnostics.map((diagnostic) => diagnostic.id);
    assert.ok(ids.includes("page.duplicate-url"));
    assert.ok(ids.includes("data.record-invalid"));
    assert.ok(ids.includes("doctor.data-summary"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the data summary counts the records read, and the invalid one among them", async () => {
  const root = tree({ ...DATA_FILES, "_data/items.yml": "- id: one\n  title: First\n- id: two\n" });
  try {
    const report = await doctorReport({
      root,
      themeRoot: THEME,
      defaultLayout: "doc",
      nodeVersion: `${MIN_NODE_MAJOR}.0.0`,
    });
    const summary = report.diagnostics.find((diagnostic) => diagnostic.id === "doctor.data-summary");
    assert.match(summary?.message ?? "", /Data: 1 collection, 1 loaded, 2 read, 1 record kept, 1 skipped, 1 schema\./);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
