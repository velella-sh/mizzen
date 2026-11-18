import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config/load.ts";
import { loadCollections } from "../src/data/collections.ts";

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "transform-values-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

async function fieldsOf(config: string, data: string): Promise<{ fields: readonly Readonly<Record<string, unknown>>[]; ids: readonly string[]; diagnostics: Awaited<ReturnType<typeof loadCollections>>["diagnostics"] }> {
  const root = tree({ "mizzen.yml": config, "data/items.yml": data });
  try {
    const { config: loaded } = loadConfig(root);
    const result = await loadCollections({ root, config: loaded });
    const records = result.collections["items"]!.records;
    return { fields: records.map((record) => record.fields), ids: records.map((record) => record.id), diagnostics: result.diagnostics };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a cast reaches the target type and names the record when a value cannot", async () => {
  const config = [
    "collections:",
    "  items:",
    "    source: data/items.yml",
    "    id: slug",
    "    transform:",
    "      steps:",
    "        - id: to-number",
    "          op: cast",
    "          field: count",
    "          to: number",
    "        - op: cast",
    "          field: active",
    "          to: boolean",
    "        - op: cast",
    "          field: code",
    "          to: string",
    "",
  ].join("\n");
  const good = await fieldsOf(config, "- slug: a\n  count: \"12\"\n  active: \"true\"\n  code: 7\n");
  assert.deepEqual(good.fields[0], { slug: "a", count: 12, active: true, code: "7" });

  const bad = await fieldsOf(config, "- slug: broken\n  count: many\n  active: true\n  code: x\n");
  const finding = bad.diagnostics.find((diagnostic) => diagnostic.id === "data.transform-cast");
  assert.ok(finding, "the invalid value is a diagnostic");
  assert.match(finding.message, /record "broken"/);
  assert.match(finding.message, /Step "to-number"/);
  assert.equal(finding.pos?.line, 2, "the finding points at the field");
  assert.equal(bad.fields[0]!.count, "many", "an invalid value is left as the source wrote it");
});

test("normalize trims Unicode whitespace and applies a stable, locale-independent case", async () => {
  const config = [
    "collections:",
    "  items:",
    "    source: data/items.yml",
    "    id: slug",
    "    transform:",
    "      steps:",
    "        - id: tidy",
    "          op: normalize",
    "          field: name",
    "          case: lower",
    "",
  ].join("\n");
  const result = await fieldsOf(config, "- slug: a\n  name: \"\\u00a0İSTANBUL\\u00a0\"\n");
  assert.equal(result.fields[0]!.name, "i\u0307stanbul", "trim and lower case keep the Unicode dot the mapping produces");
  assert.deepEqual(result.diagnostics, []);
});

test("map replaces known categories and follows the unknown-value policy", async () => {
  const base = (policy: string, extra = "") => [
    "collections:",
    "  items:",
    "    source: data/items.yml",
    "    id: slug",
    "    transform:",
    "      steps:",
    "        - id: states",
    "          op: map",
    "          field: state",
    "          values:",
    "            stable: active",
    "            beta: preview",
    `          unknown: ${policy}`,
    ...(extra === "" ? [] : [`          ${extra}`]),
    "",
  ].join("\n");

  const kept = await fieldsOf(base("keep"), "- slug: a\n  state: gamma\n- slug: b\n  state: stable\n");
  assert.deepEqual(kept.fields.map((fields) => fields.state), ["gamma", "active"]);

  const error = await fieldsOf(base("error"), "- slug: a\n  state: gamma\n");
  const finding = error.diagnostics.find((diagnostic) => diagnostic.id === "data.transform-map");
  assert.ok(finding);
  assert.match(finding.message, /record "a"/);

  const fallback = await fieldsOf(base("default", "default: other"), "- slug: a\n  state: gamma\n");
  assert.equal(fallback.fields[0]!.state, "other");
});

test("a date format and time zone give the same instant in every environment", async () => {
  const config = [
    "collections:",
    "  items:",
    "    source: data/items.yml",
    "    id: slug",
    "    transform:",
    "      steps:",
    "        - id: published",
    "          op: date",
    "          field: published",
    "          format: YYYY/MM/DD HH:mm",
    "          timezone: Asia/Tehran",
    "",
  ].join("\n");
  const first = await fieldsOf(config, "- slug: a\n  published: 2026/01/31 09:00\n");
  assert.equal(first.fields[0]!.published, "2026-01-31T05:30:00.000Z");

  const second = await fieldsOf(config, "- slug: a\n  published: 2026/01/31 09:00\n");
  assert.deepEqual(second.fields, first.fields, "the same input gives the same instant twice");

  const date = await fieldsOf(
    [
      "collections:",
      "  items:",
      "    source: data/items.yml",
      "    id: slug",
      "    transform:",
      "      steps:",
      "        - op: date",
      "          field: day",
      "          format: DD.MM.YYYY",
      "          timezone: Pacific/Kiritimati",
      "          output: date",
      "",
    ].join("\n"),
    "- slug: a\n  day: 31.01.2026\n",
  );
  assert.equal(date.fields[0]!.day, "2026-01-31");
});

test("a date that does not match its format names the record and leaves the value", async () => {
  const result = await fieldsOf(
    [
      "collections:",
      "  items:",
      "    source: data/items.yml",
      "    id: slug",
      "    transform:",
      "      steps:",
      "        - id: published",
      "          op: date",
      "          field: published",
      "          format: YYYY-MM-DD",
      "          timezone: UTC",
      "",
    ].join("\n"),
    "- slug: wrong\n  published: 31/01/2026\n",
  );
  const finding = result.diagnostics.find((diagnostic) => diagnostic.id === "data.transform-date");
  assert.ok(finding);
  assert.match(finding.message, /record "wrong"/);
  assert.equal(result.fields[0]!.published, "31/01/2026");
});

test("unit applies a factor and rounding, and rejects a non-numeric value", async () => {
  const config = [
    "collections:",
    "  items:",
    "    source: data/items.yml",
    "    id: slug",
    "    transform:",
    "      steps:",
    "        - id: grams",
    "          op: unit",
    "          field: weight",
    "          factor: 0.001",
    "          round: 2",
    "",
  ].join("\n");
  const good = await fieldsOf(config, "- slug: a\n  weight: 1500\n- slug: b\n  weight: \"2500\"\n");
  assert.deepEqual(good.fields.map((fields) => fields.weight), [1.5, 2.5]);

  const bad = await fieldsOf(config, "- slug: heavy\n  weight: heavy\n");
  const finding = bad.diagnostics.find((diagnostic) => diagnostic.id === "data.transform-unit");
  assert.ok(finding);
  assert.match(finding.message, /record "heavy"/);
  assert.equal(bad.fields[0]!.weight, "heavy");
});
