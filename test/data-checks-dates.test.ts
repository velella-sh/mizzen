import assert from "node:assert/strict";
import { test } from "node:test";
import { idsOf, loadSite } from "./data-schema-tree.ts";

const CONFIG = "collections:\n  items:\n    source: _data/items.yml\n    dates: [released]\n";

test("an accepted day and an accepted instant keep the value and normalize it for the theme", async () => {
  const result = await loadSite({
    "mizzen.yml": CONFIG,
    "_data/items.yml":
      "- id: day\n  released: \"2026-01-31\"\n- id: instant\n  released: \"2026-01-31T09:00:00+03:30\"\n- id: utc\n  released: \"2026-02-01T00:00:00Z\"\n",
  });
  assert.deepEqual(result.diagnostics, []);
  const dates = Object.fromEntries(
    Object.values(result.collections["items"]!.records).map((record) => [record.id, record.normalizedDates]),
  );
  assert.deepEqual(dates, {
    day: { released: "2026-01-31" },
    instant: { released: "2026-01-31T05:30:00.000Z" },
    utc: { released: "2026-02-01T00:00:00.000Z" },
  });
  assert.equal(
    result.collections["items"]!.records[0]!.fields["released"],
    "2026-01-31",
    "the value stays as the source writes it",
  );
});

test("an impossible day, a locale format, and a non-text value are each one error at the field", async () => {
  const result = await loadSite({
    "mizzen.yml": CONFIG,
    "_data/items.yml":
      '- id: impossible\n  released: "2026-02-30"\n- id: locale\n  released: "31/01/2026"\n- id: number\n  released: 20260131\n',
  });
  const found = result.diagnostics.filter((diagnostic) => diagnostic.id === "data.date-invalid");
  assert.deepEqual(
    found.map((diagnostic) => [diagnostic.pos?.line, diagnostic.pos?.column]),
    [
      [2, 13],
      [4, 13],
      [6, 13],
    ],
  );
  assert.match(found[0]!.message, /is not a valid date: "2026-02-30"/);
  assert.match(found[1]!.message, /is not a valid date: "31\/01\/2026"/);
  assert.match(found[2]!.message, /must be a date written as text/);
  for (const diagnostic of found) {
    assert.match(diagnostic.help ?? "", /YYYY-MM-DD/);
    assert.match(diagnostic.help ?? "", /ISO 8601/);
    assert.equal("fix" in diagnostic, false, "the help names the accepted formats; a guess is never offered as a fix");
  }
});

test("an empty date is not a problem and adds no normalized value", async () => {
  const result = await loadSite({
    "mizzen.yml": CONFIG,
    "_data/items.yml": '- id: empty\n  released: ""\n- id: absent\n',
  });
  assert.deepEqual(idsOf(result), []);
  for (const record of result.collections["items"]!.records) {
    assert.equal(record.normalizedDates, undefined);
  }
});

test("a leap day is accepted only in a leap year", async () => {
  const result = await loadSite({
    "mizzen.yml": CONFIG,
    "_data/items.yml": '- id: leap\n  released: "2028-02-29"\n- id: plain\n  released: "2027-02-29"\n',
  });
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => [diagnostic.id, diagnostic.pos?.line]),
    [["data.date-invalid", 4]],
  );
});
