import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import type { DataRecord } from "../src/contracts/index.ts";
import { deriveRecords } from "../src/data/derived.ts";
import { recordPropsOf } from "../src/data/record-context.ts";
import { buildModel, type ModelResult } from "../src/model/build.ts";
import { ids, pageAt, site } from "./data-record-site.ts";

const CONFIG = [
  "collections:",
  "  releases:",
  "    source: _data/releases.yml",
  "    template: _templates/release.md",
  "    permalink: /releases/{id}/",
  "    dates: [released]",
  "    derived:",
  "      daysLeft: { field: released, kind: days-left }",
  "      daysSince: { field: released, kind: days-since }",
  "      state:",
  "        field: released",
  "        bands:",
  "          - { below: 0, value: expired }",
  "          - { below: 90, value: soon }",
  "          - { value: later }",
  "  plain:",
  "    source: _data/plain.yml",
  "    template: _templates/plain.md",
  "    permalink: /plain/{id}/",
  "",
].join("\n");

const DATA = [
  "- id: day",
  "  name: Day",
  "  released: 2026-06-11",
  "- id: month",
  "  name: Month",
  '  released: "2026-06"',
  "- id: year",
  "  name: Year",
  '  released: "2025"',
  "- id: past",
  "  name: Past",
  "  released: 2026-05-22",
  "- id: far",
  "  name: Far",
  "  released: 2027-01-01",
  "- id: missing",
  "  name: Missing",
  "",
].join("\n");

const TEMPLATE = "---\ntitle: \"{name}\"\n---\n# :field[name]\n";
const PLAIN_TEMPLATE = "---\ntitle: \"{name}\"\n---\n# :field[name]\n";

const FILES: Record<string, string> = {
  "mizzen.yml": CONFIG,
  "_data/releases.yml": DATA,
  "_data/plain.yml": "- id: p1\n  name: Plain\n",
  "_templates/release.md": TEMPLATE,
  "_templates/plain.md": PLAIN_TEMPLATE,
};

function bytesOf(files: Record<string, string>, extra: Record<string, string> = {}): Record<string, string> {
  return { ...FILES, ...files, ...extra };
}

async function withAsOf(
  files: Record<string, string>,
  asOf: string | undefined,
  run: (result: ModelResult) => void,
): Promise<void> {
  const root = site(files);
  try {
    run(await buildModel(root, asOf === undefined ? {} : { asOf }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function recordOf(result: ModelResult, id: string): DataRecord {
  const record = result.site.collections["releases"]?.records.find((candidate) => candidate.id === id);
  assert.ok(record, `the release ${id} exists`);
  return record;
}

test("days-left counts to the latest day and days-since from the earliest", async () => {
  await withAsOf(bytesOf({}), "2026-06-01", (result) => {
    assert.deepEqual(ids(result), []);
    assert.deepEqual(recordOf(result, "day").derived, { daysLeft: 10, daysSince: -10, state: "soon" });
    assert.deepEqual(recordOf(result, "month").derived, { daysLeft: 29, daysSince: 0, state: "soon" });
    assert.deepEqual(recordOf(result, "year").derived, { daysLeft: -152, daysSince: 516, state: "expired" });
    assert.deepEqual(recordOf(result, "past").derived, { daysLeft: -10, daysSince: 10, state: "expired" });
    assert.deepEqual(recordOf(result, "far").derived, { daysLeft: 214, daysSince: -214, state: "later" });
    assert.equal(recordOf(result, "missing").derived, undefined);
    assert.deepEqual(recordOf(result, "month").normalizedDates, { released: "2026-06" });
    assert.deepEqual(recordOf(result, "year").normalizedDates, { released: "2025" });
  });
});

test("a record with no date has no value and no finding", async () => {
  await withAsOf(bytesOf({}), "2026-06-01", (result) => {
    assert.deepEqual(ids(result), []);
    assert.equal(recordOf(result, "missing").derived, undefined);
    assert.deepEqual(Object.keys(recordOf(result, "missing").fields).sort(), ["id", "name"]);
  });
});

test("no as-of date reports one finding per rule and derives nothing", async () => {
  await withAsOf(bytesOf({}), undefined, (result) => {
    assert.deepEqual(ids(result).sort(), ["dates.no-as-of", "dates.no-as-of", "dates.no-as-of"]);
    for (const record of result.site.collections["releases"]!.records) {
      assert.equal(record.derived, undefined);
    }
  });
});

test("a closed band set with no match gives no value", () => {
  const rules = {
    tier: {
      field: "released",
      bands: [
        { below: 0, value: "past" },
        { below: 10, value: "near" },
      ],
    },
  } as const;
  const { records, diagnostics } = deriveRecords(
    "releases",
    [{
      id: "day",
      fields: { id: "day", name: "Day", released: "2026-06-21" },
      position: { file: "_data/releases.yml", startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 },
      fieldPositions: {},
    }],
    rules,
    "2026-06-01",
  );
  assert.deepEqual(diagnostics, []);
  assert.equal(records[0]?.derived, undefined);
});

test("a real field wins over a derived value in a template and in a list", async () => {
  const files = bytesOf({
    "_data/releases.yml": "- id: day\n  name: Day\n  released: 2026-06-11\n  state: manual\n",
    "_templates/release.md": "---\ntitle: \"{name}\"\n---\n# :field[name]\n\nState: :field[state]\n",
    "blog/index.md":
      "---\ntitle: Blog\nlist:\n  collection: releases\n  where: { state: manual }\n  fields: [name]\n---\n",
  });
  await withAsOf(files, "2026-06-01", (result) => {
    assert.deepEqual(ids(result), []);
    const page = pageAt(result, "/releases/day/")!;
    assert.match(page.html, />manual</);
    assert.doesNotMatch(page.html, />soon</);
    assert.equal(recordOf(result, "day").derived?.state, "soon");
    assert.deepEqual(pageAt(result, "/blog/")?.list?.records.map((record) => record.id), ["day"]);
  });
});

test("a list filters, sorts, and groups on a derived value", async () => {
  await withAsOf(
    bytesOf({
      "blog/index.md":
        "---\ntitle: Blog\nlist:\n  collection: releases\n  where: { state: expired }\n  group: state\n  fields: [name]\n---\n",
      "sorted/index.md":
        "---\ntitle: Sorted\nlist:\n  collection: releases\n  sort: daysLeft asc\n  fields: [name]\n---\n",
    }),
    "2026-06-01",
    (result) => {
      assert.deepEqual(ids(result), []);
      const grouped = pageAt(result, "/blog/")!;
      assert.deepEqual(grouped.list?.groups.map((group) => [group.key, group.records.map((record) => record.id)]), [
        ["expired", ["year", "past"]],
      ]);
      assert.equal(grouped.list?.records[0]?.derived?.state, "expired");
      assert.equal(grouped.list?.records[0]?.fields["name"], "Year");
      const sorted = pageAt(result, "/sorted/")!;
      assert.deepEqual(sorted.list?.records.map((record) => record.id), ["year", "past", "day", "month", "far", "missing"]);
    },
  );
});

test("a derived value reaches the record props, and a page that reads a date is marked", async () => {
  await withAsOf(bytesOf({}), "2026-06-01", (result) => {
    const dated = pageAt(result, "/releases/day/")!;
    assert.equal(dated.dates, true);
    assert.equal(recordPropsOf(result.site, dated)?.derived?.daysLeft, 10);
    assert.equal(recordPropsOf(result.site, dated)?.fields["daysLeft"], 10);
    assert.equal(pageAt(result, "/plain/p1/")?.dates, undefined);
  });
});

test("a config rule must read a date field, and bands must be ordered", async () => {
  const files = bytesOf({
    "mizzen.yml": [
      "collections:",
      "  releases:",
      "    source: _data/releases.yml",
      "    template: _templates/release.md",
      "    permalink: /releases/{id}/",
      "    dates: [released]",
      "    derived:",
      "      wrong: { field: name, kind: days-left }",
      "      tier:",
      "        field: released",
      "        bands:",
      "          - { below: 10, value: near }",
      "          - { below: 0, value: past }",
      "          - { value: later }",
      "",
    ].join("\n"),
    "_data/releases.yml": "- id: day\n  name: Day\n  released: 2026-06-11\n",
  });
  await withAsOf(files, "2026-06-01", (result) => {
    const found = ids(result);
    assert.ok(found.includes("config.derived-date-field"), found.join(", "));
    assert.ok(found.includes("config.derived-bands"), found.join(", "));
  });
});

test("nothing is written back to a record's fields or its source file", async () => {
  const files = bytesOf({});
  await withAsOf(files, "2026-06-01", (result) => {
    for (const record of result.site.collections["releases"]!.records) {
      assert.equal(Object.hasOwn(record.fields, "daysLeft"), false);
      assert.equal(Object.hasOwn(record.fields, "state"), false);
    }
    assert.deepEqual(Object.keys(recordOf(result, "day").fields).sort(), ["id", "name", "released"]);
    assert.equal(files["_data/releases.yml"], DATA);
  });
});
