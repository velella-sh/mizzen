import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../src/cli/index.ts";
import { diffRuleVersions, ruleDiffJson } from "../src/data/rule-diff.ts";

const BIN = fileURLToPath(new URL("../bin/mizzen.ts", import.meta.url));

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "data-rule-diff-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function run(args: readonly string[], cwd: string) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8" });
}

/** A product site whose only rule multiplies `price`; `factor` is what a review changes. */
function products(factor: number): string {
  return [
    "title: Rules",
    "url: https://example.test",
    "collections:",
    "  products:",
    "    source: _data/products.yml",
    "    template: _templates/product.md",
    "    permalink: /products/{id}/",
    "    transform:",
    "      steps:",
    "        - id: price-unit",
    "          op: unit",
    "          field: price",
    "          factor: " + factor,
    "          round: 0",
    "",
  ].join("\n");
}

const TEMPLATE = '---\ntitle: "{title}"\nlayout: record\n---\n# :field[title]\n';
const PRODUCTS = "- id: a\n  title: Alpha\n  price: 12\n";

function productSite(): string {
  return tree({
    "mizzen.yml": products(100),
    "mizzen.proposed.yml": products(1000),
    "_data/products.yml": PRODUCTS,
    "_templates/product.md": TEMPLATE,
    "mizzen.lock.json": '{"version":1,"sources":{}}\n',
  });
}

test("compares two rule versions on one hashed input and leaves the lock untouched", async () => {
  const root = productSite();
  try {
    const lockBefore = readFileSync(join(root, "mizzen.lock.json"));
    const result = await diffRuleVersions({ root, baseline: "mizzen.yml", proposed: "mizzen.proposed.yml" });
    assert.equal(result.code, 0);
    assert.deepEqual(result.errors, []);
    const report = result.report!;
    assert.equal(report.baseline.path, "mizzen.yml");
    assert.equal(report.proposed.path, "mizzen.proposed.yml");
    assert.match(report.baseline.sha256, /^[0-9a-f]{64}$/u);
    assert.match(report.proposed.sha256, /^[0-9a-f]{64}$/u);
    assert.match(report.input.sha256, /^[0-9a-f]{64}$/u);
    assert.deepEqual(report.counts, { added: 0, removed: 0, changed: 1, fields: 1, outputs: 1 });

    const record = report.records[0]!;
    assert.equal(record.id, "a");
    assert.equal(record.change, "changed");
    const price = record.fields[0]!;
    assert.equal(price.path, "price");
    assert.deepEqual(price.before, { type: "number", value: 1200 });
    assert.deepEqual(price.after, { type: "number", value: 12000 });
    assert.deepEqual(price.rules.map((rule) => [rule.side, rule.rule]), [["baseline", "price-unit"], ["proposed", "price-unit"]]);
    assert.deepEqual(report.affected.map((output) => [output.path, output.role, output.records]), [["/products/a/", "page", ["a"]]]);
    assert.equal(report.complete, true);
    assert.ok(result.output.includes("price: number 1200 -> number 12000"));

    const again = await diffRuleVersions({ root, baseline: "mizzen.yml", proposed: "mizzen.proposed.yml", format: "json" });
    const twice = await diffRuleVersions({ root, baseline: "mizzen.yml", proposed: "mizzen.proposed.yml", format: "json" });
    assert.equal(again.output, twice.output);
    assert.equal(again.output, ruleDiffJson(again.report!));
    assert.deepEqual(again.errors, []);
    assert.equal(again.report!.input.sha256, report.input.sha256);
    assert.deepEqual(readFileSync(join(root, "mizzen.lock.json")), lockBefore);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports added, removed, and changed fields with missing, null, and type kept apart", async () => {
  const root = tree({
    "mizzen.yml": [
      "title: Rules",
      "collections:",
      "  items:",
      "    source: _data/items.yml",
      "",
    ].join("\n"),
    "mizzen.proposed.yml": [
      "title: Rules",
      "collections:",
      "  items:",
      "    source: _data/items.yml",
      "    transform:",
      "      steps:",
      "        - id: tag-default",
      "          op: default",
      "          field: tag",
      "          value: null",
      "        - id: code-string",
      "          op: cast",
      "          field: code",
      "          to: string",
      "        - id: drop-gone",
      "          op: remove",
      "          fields: [gone]",
      "",
    ].join("\n"),
    "_data/items.yml": "- id: a\n  code: 7\n  gone: x\n",
  });
  try {
    const result = await diffRuleVersions({ root, baseline: "mizzen.yml", proposed: "mizzen.proposed.yml" });
    assert.equal(result.code, 0);
    const fields = result.report!.records[0]!.fields;
    const byPath = new Map(fields.map((field) => [field.path, field]));

    const tag = byPath.get("tag")!;
    assert.equal(tag.change, "added");
    assert.equal(Object.hasOwn(tag, "before"), false);
    assert.deepEqual(tag.after, { type: "null", value: null });
    assert.equal(tag.typeChange, false);
    assert.deepEqual(tag.rules.map((rule) => rule.rule), ["tag-default"]);

    const code = byPath.get("code")!;
    assert.equal(code.change, "changed");
    assert.equal(code.typeChange, true);
    assert.deepEqual(code.before, { type: "number", value: 7 });
    assert.deepEqual(code.after, { type: "string", value: "7" });
    assert.equal(Object.hasOwn(code, "unknown"), false);

    const gone = byPath.get("gone")!;
    assert.equal(gone.change, "removed");
    assert.deepEqual(gone.before, { type: "string", value: "x" });
    assert.equal(Object.hasOwn(gone, "after"), false);
    assert.ok(result.output.includes("tag: missing -> null"));
    assert.ok(result.output.includes("code: number 7 -> string \"7\""));
    assert.ok(result.output.includes("gone: string \"x\" -> missing"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("attributes a nested field that no step wrote to unknown, with a reason", async () => {
  const root = tree({
    "mizzen.yml": [
      "title: Rules",
      "collections:",
      "  items:",
      "    source: _data/items.yml",
      "    transform:",
      "      steps:",
      "        - id: kind-default",
      "          op: default",
      "          field: kind",
      "          value: plain",
      "",
    ].join("\n"),
    "mizzen.proposed.yml": [
      "title: Rules",
      "collections:",
      "  items:",
      "    source: _data/items.yml",
      "    transform:",
      "      steps:",
      "        - id: keep-x",
      "          op: select",
      "          fields: [a.x]",
      "",
    ].join("\n"),
    "_data/items.yml": "- id: a\n  kind: k\n  a:\n    x: 1\n    y: 2\n",
  });
  try {
    const result = await diffRuleVersions({ root, baseline: "mizzen.yml", proposed: "mizzen.proposed.yml" });
    const removed = result.report!.records[0]!.fields.find((field) => field.path === "a.y")!;
    assert.equal(removed.change, "removed");
    assert.deepEqual(removed.rules, []);
    assert.match(removed.unknown!, /no transformation step/u);
    assert.ok(result.output.includes("unknown: no transformation step"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports a one-sided transform failure with its side and stage and marks the result incomplete", async () => {
  const root = tree({
    "mizzen.yml": "title: Rules\ncollections:\n  items:\n    source: _data/items.yml\n",
    "mizzen.proposed.yml": [
      "title: Rules",
      "collections:",
      "  items:",
      "    source: _data/items.yml",
      "    transform:",
      "      steps:",
      "        - id: label-unit",
      "          op: unit",
      "          field: label",
      "          factor: 2",
      "",
    ].join("\n"),
    "_data/items.yml": "- id: a\n  label: heavy\n",
  });
  try {
    const result = await diffRuleVersions({ root, baseline: "mizzen.yml", proposed: "mizzen.proposed.yml" });
    assert.equal(result.code, 2);
    const report = result.report!;
    assert.equal(report.complete, false);
    assert.deepEqual(report.failures.map((failure) => [failure.side, failure.stage, failure.rule]), [["proposed", "transform", "label-unit"]]);
    assert.match(report.failures[0]!.message, /cannot convert field "label"/u);
    assert.ok(result.output.includes("complete: no"));
    assert.ok(result.output.includes("proposed transform step \"label-unit\""));
    assert.equal(result.errors.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports a validation failure on one side with its stage and the record it removed", async () => {
  const schema = JSON.stringify({ type: "object", required: ["price"], properties: { price: { type: "number" }, title: { type: "string" } } });
  const root = tree({
    "mizzen.yml": [
      "title: Rules",
      "collections:",
      "  items:",
      "    source: _data/items.yml",
      "    schema: item.schema.json",
      "",
    ].join("\n"),
    "mizzen.proposed.yml": [
      "title: Rules",
      "collections:",
      "  items:",
      "    source: _data/items.yml",
      "    schema: item.schema.json",
      "    transform:",
      "      validate: before-and-after",
      "      steps:",
      "        - id: price-string",
      "          op: cast",
      "          field: price",
      "          to: string",
      "",
    ].join("\n"),
    "_data/items.yml": "- id: a\n  title: Alpha\n  price: 12\n",
    "item.schema.json": schema,
  });
  try {
    const result = await diffRuleVersions({ root, baseline: "mizzen.yml", proposed: "mizzen.proposed.yml" });
    assert.equal(result.code, 2);
    const report = result.report!;
    assert.equal(report.complete, false);
    assert.deepEqual(report.records.map((record) => [record.id, record.change]), [["a", "removed"]]);
    assert.deepEqual(report.failures.map((failure) => [failure.side, failure.stage, failure.rule]), [
      ["proposed", "validation-output", "price-string"],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses two different inputs and a missing config with a clear target error", async () => {
  const root = tree({
    "mizzen.yml": [
      "title: Rules",
      "collections:",
      "  items:",
      "    source: _data/a.yml",
      "    transform:",
      "      steps:",
      "        - id: kind-default",
      "          op: default",
      "          field: kind",
      "          value: plain",
      "",
    ].join("\n"),
    "mizzen.proposed.yml": [
      "title: Rules",
      "collections:",
      "  items:",
      "    source: _data/b.yml",
      "    transform:",
      "      steps:",
      "        - id: kind-default",
      "          op: default",
      "          field: kind",
      "          value: plain",
      "",
    ].join("\n"),
    "_data/a.yml": "- id: a\n  price: 1\n",
    "_data/b.yml": "- id: a\n  price: 2\n",
  });
  try {
    const unequal = await diffRuleVersions({ root, baseline: "mizzen.yml", proposed: "mizzen.proposed.yml" });
    assert.equal(unequal.code, 2);
    assert.equal(unequal.output, "");
    assert.match(unequal.errors[0]!, /same hash/u);
    assert.match(unequal.errors[0]!, /_data\/a\.yml/u);
    assert.match(unequal.errors[0]!, /_data\/b\.yml/u);

    const missing = await diffRuleVersions({ root, baseline: "nope.yml", proposed: "mizzen.proposed.yml" });
    assert.equal(missing.code, 2);
    assert.match(missing.errors[0]!, /baseline config "nope\.yml" cannot be read/u);
    assert.equal(missing.report, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("filters by collection and asks for one when both configs declare several", async () => {
  const root = tree({
    "mizzen.yml": [
      "title: Rules",
      "collections:",
      "  alpha:",
      "    source: _data/alpha.yml",
      "    transform:",
      "      steps:",
      "        - id: alpha-unit",
      "          op: unit",
      "          field: n",
      "          factor: 2",
      "  beta:",
      "    source: _data/beta.yml",
      "",
    ].join("\n"),
    "mizzen.proposed.yml": [
      "title: Rules",
      "collections:",
      "  alpha:",
      "    source: _data/alpha.yml",
      "  beta:",
      "    source: _data/beta.yml",
      "    transform:",
      "      steps:",
      "        - id: beta-unit",
      "          op: unit",
      "          field: n",
      "          factor: 3",
      "",
    ].join("\n"),
    "_data/alpha.yml": "- id: a\n  n: 2\n",
    "_data/beta.yml": "- id: b\n  n: 2\n",
  });
  try {
    const ambiguous = await diffRuleVersions({ root, baseline: "mizzen.yml", proposed: "mizzen.proposed.yml" });
    assert.equal(ambiguous.code, 2);
    assert.match(ambiguous.errors[0]!, /--collection: alpha, beta/u);

    const filtered = await diffRuleVersions({ root, baseline: "mizzen.yml", proposed: "mizzen.proposed.yml", collection: "beta" });
    assert.equal(filtered.code, 0);
    assert.equal(filtered.report!.collection, "beta");
    assert.deepEqual(filtered.report!.records.map((record) => record.id), ["b"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parses and runs the command with distinct exit codes for unchanged, changed, and failed", () => {
  assert.deepEqual(parseArgs(["data", "transform-diff", "old.yml", "new.yml", "site", "--collection", "products", "--format", "json", "--check"]), {
    options: {
      command: "data-transform-diff",
      root: "site",
      baseline: "old.yml",
      proposed: "new.yml",
      collection: "products",
      format: "json",
      check: true,
    },
  });
  assert.equal("error" in parseArgs(["data", "transform-diff", "old.yml"]), true);
  assert.equal("error" in parseArgs(["data", "transform-diff", "old.yml", "new.yml", "--format", "yaml"]), true);

  const root = productSite();
  try {
    const unchanged = run(["data", "transform-diff", "mizzen.yml", "mizzen.yml", ".", "--check"], root);
    assert.equal(unchanged.status, 0, unchanged.stderr);
    assert.match(unchanged.stdout, /no record changes/u);

    const changed = run(["data", "transform-diff", "mizzen.yml", "mizzen.proposed.yml", ".", "--check"], root);
    assert.equal(changed.status, 1, changed.stderr);
    assert.match(changed.stdout, /1 changed/u);

    const failed = run(["data", "transform-diff", "missing.yml", "mizzen.proposed.yml", "."], root);
    assert.equal(failed.status, 2);
    assert.match(failed.stderr, /cannot be read/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
