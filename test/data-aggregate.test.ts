import assert from "node:assert/strict";
import { test } from "node:test";
import type { Diagnostic } from "../src/contracts/index.ts";
import { api } from "../src/outputs/api.ts";
import { buildModel } from "../src/model/build.ts";
import {
  affectedNodes,
  buildDependencyGraph,
  collectionNodeId,
  outputNodeId,
  recordNodeId,
} from "../src/pipeline/dependency-graph.ts";
import { withSite } from "./data-record-site.ts";

const SALES = [
  "- id: a",
  "  region: eu",
  "  channel: web",
  "  date: 2026-01-05",
  "  customer: c1",
  "  amount: 10",
  "- id: b",
  "  region: eu",
  "  channel: web",
  "  date: 2026-01-20",
  "  customer: c1",
  "  amount: 5",
  "- id: c",
  "  region: eu",
  "  channel: store",
  "  date: 2026-02-01",
  "  customer: c2",
  "  amount: null",
  "- id: d",
  "  region: us",
  "  channel: web",
  "  date: 2026-02-15",
  "  customer: c3",
  "  amount: 20",
  "- id: e",
  "  region: us",
  "  channel: store",
  "  date: 2026-02-15",
  "  customer: c3",
  "  amount: 7",
  "",
].join("\n");

/** A site with a `sales` source and one aggregate named `summary`, declaring `aggregate` as written. */
function site(aggregate: string, extra = ""): Record<string, string> {
  return {
    "mizzen.yml": `collections:\n  sales:\n    source: _data/sales.yml\n  summary:\n    source: sales\n    aggregate:\n${aggregate}${extra}`,
    "_data/sales.yml": SALES,
  };
}

/** The summary records as id and fields, in output order. */
function rows(result: Awaited<ReturnType<typeof buildModel>>): { id: string; fields: Record<string, unknown> }[] {
  return (result.site.collections["summary"]?.records ?? []).map((record) => ({ id: record.id, fields: { ...record.fields } }));
}

function errorIds(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.filter((diagnostic) => diagnostic.severity === "error").map((diagnostic) => diagnostic.id);
}

const LIST_PAGE = "monthly/index.md";
const LIST = "---\ntitle: Monthly\nlist:\n  collection: summary\n  sort: region\n---\n# Monthly\n";

test("#975 a source that is missing or an unknown operator is an error at the config line", async () => {
  await withSite(
    {
      "mizzen.yml":
        "collections:\n" +
        "  sales:\n" +
        "    source: _data/sales.yml\n" +
        "  summary:\n" +
        "    source: absent\n" +
        "    aggregate:\n" +
        "      by: [region]\n" +
        "      metrics:\n" +
        "        orders: { op: count }\n",
      "_data/sales.yml": SALES,
    },
    (_root, result) => {
      const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
      assert.deepEqual(errors.map((diagnostic) => diagnostic.id), ["data.aggregate-source"]);
      assert.equal(errors[0]!.pos?.file, "mizzen.yml");
      assert.equal(errors[0]!.pos?.line, 4, "the finding points at the collection, not the file");
      assert.equal(result.site.collections["summary"], undefined);
    },
  );

  await withSite(
    {
      "mizzen.yml":
        "collections:\n" +
        "  sales:\n" +
        "    source: _data/sales.yml\n" +
        "  summary:\n" +
        "    source: sales\n" +
        "    aggregate:\n" +
        "      by:\n" +
        "        - { field: date, period: month }\n" +
        "      metrics:\n" +
        "        orders: { op: count }\n",
      "_data/sales.yml": SALES,
    },
    (_root, result) => {
      assert.ok(errorIds(result.diagnostics).includes("data.aggregate-timezone"));
    },
  );
});

test("#976 every distinct combination of two fields is its own group", async () => {
  await withSite(
    site("      by: [region, channel]\n      metrics:\n        orders: { op: count }\n"),
    (_root, result) => {
      assert.deepEqual(result.diagnostics, []);
      assert.deepEqual(rows(result), [
        { id: "eu-store", fields: { id: "eu-store", region: "eu", channel: "store", orders: 1 } },
        { id: "eu-web", fields: { id: "eu-web", region: "eu", channel: "web", orders: 2 } },
        { id: "us-store", fields: { id: "us-store", region: "us", channel: "store", orders: 1 } },
        { id: "us-web", fields: { id: "us-web", region: "us", channel: "web", orders: 1 } },
      ]);
    },
  );
});

test("#977 a monthly bucket uses the configured zone and a civil date keeps its month", async () => {
  await withSite(
    {
      "mizzen.yml":
        "collections:\n" +
        "  events:\n" +
        "    source: _data/events.yml\n" +
        "  berlin:\n" +
        "    source: events\n" +
        "    aggregate:\n" +
        "      by:\n" +
        "        - { field: at, period: month, timezone: Europe/Berlin }\n" +
        "      metrics:\n" +
        "        orders: { op: count }\n" +
        "  utc:\n" +
        "    source: events\n" +
        "    aggregate:\n" +
        "      by:\n" +
        "        - { field: at, period: month, timezone: UTC }\n" +
        "      metrics:\n" +
        "        orders: { op: count }\n",
      "_data/events.yml":
        "- id: a\n  at: 2026-01-31T23:30:00Z\n" +
        "- id: b\n  at: 2026-02-01T00:30:00Z\n" +
        "- id: c\n  at: 2026-03-15\n",
    },
    (_root, result) => {
      assert.deepEqual(result.diagnostics, []);
      assert.deepEqual(
        result.site.collections["berlin"]!.records.map((record) => [record.id, record.fields["orders"]]),
        [["2026-02", 2], ["2026-03", 1]],
      );
      assert.deepEqual(
        result.site.collections["utc"]!.records.map((record) => [record.id, record.fields["orders"]]),
        [["2026-01", 1], ["2026-02", 1], ["2026-03", 1]],
      );
    },
  );
});

test("#978 count counts every record and count-distinct counts each value once", async () => {
  await withSite(
    site("      by: [region]\n      metrics:\n        orders: { op: count }\n        customers: { op: count-distinct, field: customer }\n"),
    (_root, result) => {
      assert.deepEqual(rows(result), [
        { id: "eu", fields: { id: "eu", region: "eu", orders: 3, customers: 2 } },
        { id: "us", fields: { id: "us", region: "us", orders: 2, customers: 1 } },
      ]);
    },
  );
});

test("#979 sum and average skip null, average divides by the values it read, and decimals round it", async () => {
  await withSite(
    {
      "mizzen.yml":
        "collections:\n" +
        "  sales:\n" +
        "    source: _data/sales.yml\n" +
        "  summary:\n" +
        "    source: sales\n" +
        "    aggregate:\n" +
        "      by: [region]\n" +
        "      metrics:\n" +
        "        total: { op: sum, field: amount, decimals: 2 }\n" +
        "        average: { op: average, field: amount, decimals: 1 }\n" +
        "        whole: { op: sum, field: amount, decimals: 0 }\n",
      "_data/sales.yml": "- id: a\n  region: eu\n  amount: 10.4\n- id: b\n  region: eu\n  amount: 5.4\n- id: c\n  region: eu\n  amount: null\n",
    },
    (_root, result) => {
      assert.deepEqual(rows(result), [
        { id: "eu", fields: { id: "eu", region: "eu", total: 15.8, average: 7.9, whole: 16 } },
      ]);
    },
  );
});

test("#980 min and max read the group's bounds, and a value of another kind is a diagnostic", async () => {
  await withSite(
    site("      by: [region]\n      metrics:\n        first: { op: min, field: amount }\n        last: { op: max, field: amount }\n"),
    (_root, result) => {
      assert.deepEqual(rows(result), [
        { id: "eu", fields: { id: "eu", region: "eu", first: 5, last: 10 } },
        { id: "us", fields: { id: "us", region: "us", first: 7, last: 20 } },
      ]);
    },
  );

  await withSite(
    {
      "mizzen.yml":
        "collections:\n  sales:\n    source: _data/sales.yml\n  summary:\n    source: sales\n    aggregate:\n      by: [region]\n      metrics:\n        first: { op: min, field: amount }\n",
      "_data/sales.yml": "- id: a\n  region: eu\n  amount: 10\n- id: b\n  region: eu\n  amount: lots\n",
    },
    (_root, result) => {
      assert.ok(errorIds(result.diagnostics).includes("data.aggregate-bound"));
      assert.equal(result.site.collections["summary"], undefined);
    },
  );
});

test("#981 missing keys follow missing, and an all-null group follows empty", async () => {
  await withSite(
    {
      "mizzen.yml":
        "collections:\n" +
        "  sales:\n" +
        "    source: _data/sales.yml\n" +
        "  skipped:\n" +
        "    source: sales\n" +
        "    aggregate:\n" +
        "      by: [region]\n" +
        "      missing: skip\n" +
        "      metrics:\n" +
        "        orders: { op: count }\n" +
        "  grouped:\n" +
        "    source: sales\n" +
        "    aggregate:\n" +
        "      by: [region]\n" +
        "      missing: group\n" +
        "      metrics:\n" +
        "        orders: { op: count }\n",
      "_data/sales.yml": "- id: a\n  region: eu\n- id: b\n",
    },
    (_root, result) => {
      assert.deepEqual(result.site.collections["skipped"]!.records.map((record) => record.id), ["eu"]);
      const grouped = result.site.collections["grouped"]!.records;
      assert.deepEqual(grouped.map((record) => record.id), ["eu", "missing"]);
      assert.equal(grouped[1]!.fields["region"], null);
    },
  );

  await withSite(
    {
      "mizzen.yml":
        "collections:\n" +
        "  sales:\n" +
        "    source: _data/sales.yml\n" +
        "  kept:\n" +
        "    source: sales\n" +
        "    aggregate:\n" +
        "      by: [region]\n" +
        "      metrics:\n" +
        "        average: { op: average, field: amount }\n" +
        "  omitted:\n" +
        "    source: sales\n" +
        "    aggregate:\n" +
        "      by: [region]\n" +
        "      empty: omit\n" +
        "      metrics:\n" +
        "        average: { op: average, field: amount }\n",
      "_data/sales.yml": "- id: a\n  region: eu\n  amount: null\n",
    },
    (_root, result) => {
      assert.deepEqual(rows(result), []);
      assert.deepEqual(result.site.collections["kept"]!.records.map((record) => record.fields["average"]), [null]);
      assert.deepEqual(result.site.collections["omitted"]!.records, []);
    },
  );
});

test("#982 a filter removes a record from every metric", async () => {
  await withSite(
    site("      by: [region]\n      where: { channel: web }\n      metrics:\n        orders: { op: count }\n        total: { op: sum, field: amount }\n"),
    (_root, result) => {
      assert.deepEqual(rows(result), [
        { id: "eu", fields: { id: "eu", region: "eu", orders: 2, total: 15 } },
        { id: "us", fields: { id: "us", region: "us", orders: 1, total: 20 } },
      ]);
    },
  );
});

test("#983 reordering source rows preserves ids and output order", async () => {
  const files = site("      by: [region, channel]\n      metrics:\n        orders: { op: count }\n");
  const rowsOf = async (text: string) => {
    let out: { id: string; fields: Record<string, unknown> }[] = [];
    await withSite({ ...files, "_data/sales.yml": text }, (_root, result) => {
      out = rows(result);
    });
    return out;
  };
  const forward = await rowsOf(SALES);
  const reversed = await rowsOf([...SALES.trimEnd().split(/\n(?=- id: )/)].reverse().join("\n") + "\n");
  assert.deepEqual(reversed, forward);
  assert.deepEqual(forward.map((row) => row.id), ["eu-store", "eu-web", "us-store", "us-web"]);
});

test("#984 an aggregate record depends on its source collection and on the records in its group", async () => {
  await withSite(
    {
      ...site("      by: [region, channel]\n      metrics:\n        orders: { op: count }\n", "api:\n  collections:\n    summary:\n      fields: [region, orders]\n"),
      [LIST_PAGE]: LIST,
    },
    async (root, result) => {
      assert.deepEqual(result.diagnostics, []);
      const { graph, diagnostics } = await buildDependencyGraph({ root, site: result.site });
      assert.deepEqual(diagnostics, []);
      const pairs = new Set(graph.edges.map((edge) => `${edge.from} -> ${edge.to}`));
      assert.ok(pairs.has(`${collectionNodeId("summary")} -> ${collectionNodeId("sales")}`));
      assert.ok(pairs.has(`${recordNodeId("summary", "eu-web")} -> ${collectionNodeId("sales")}`));
      assert.ok(pairs.has(`${recordNodeId("summary", "eu-web")} -> ${recordNodeId("sales", "a")}`));
      assert.ok(pairs.has(`${outputNodeId("/monthly/")} -> ${collectionNodeId("summary")}`));

      // A record moved from eu/web to us/web changes both groups; the collection edge is what reaches both.
      const affected = affectedNodes(graph, [recordNodeId("sales", "a")]);
      assert.ok(affected.includes(recordNodeId("summary", "eu-web")));
      assert.ok(affected.includes(recordNodeId("summary", "us-web")));
      assert.ok(affected.includes(outputNodeId("/monthly/")));
    },
  );
});

test("group keys cannot collide when a string contains the key separator", async () => {
  await withSite(
    {
      "mizzen.yml":
        "collections:\n  sales:\n    source: _data/sales.json\n  summary:\n    source: sales\n    aggregate:\n      by: [a, b]\n      metrics:\n        orders: { op: count }\n",
      "_data/sales.json": JSON.stringify([
        { id: "one", a: "x", b: "y\u0000s:z" },
        { id: "two", a: "x\u0000s:y", b: "z" },
      ]),
    },
    (_root, result) => {
      assert.deepEqual(result.diagnostics, []);
      assert.equal(rows(result).length, 2);
      assert.deepEqual(rows(result).map((row) => row.fields["orders"]), [1, 1]);
    },
  );
});

test("#985 a list page and the static API publish the same summary counts", async () => {
  await withSite(
    {
      ...site(
        "      by: [region, channel]\n      metrics:\n        orders: { op: count }\n",
        "api:\n  collections:\n    summary:\n      fields: [region, channel, orders]\n",
      ),
      [LIST_PAGE]: LIST,
    },
    async (_root, result) => {
      const page = result.site.pages.find((candidate) => candidate.url === "/monthly/");
      assert.ok(page?.list !== undefined);
      const files = new Map((await api.run(result.site, { renderPage: async () => "", report: () => {} })).map((file) => [file.path, String(file.contents)]));
      const body = JSON.parse(files.get("api/v1/summary.json")!) as { count: number; records: ({ id: string } & Record<string, unknown>)[] };
      assert.equal(page.list.records.length, body.count);
      assert.equal(body.count, 4);
      assert.deepEqual(
        page.list.records.map((record) => record.id).sort(),
        body.records.map((record) => record.id).sort(),
      );
      const eu = body.records.find((record) => record.id === "eu-web");
      assert.deepEqual({ region: eu?.["region"], channel: eu?.["channel"], orders: eu?.["orders"] }, { region: "eu", channel: "web", orders: 2 });    },
  );
});


test("invalid group and metric values name their diagnostics instead of publishing a partial summary", async () => {
  await withSite(
    {
      "mizzen.yml":
        "collections:\n  sales:\n    source: _data/sales.json\n  summary:\n    source: sales\n    aggregate:\n      by: [group]\n      metrics:\n        total: { op: sum, field: amount }\n        distinct: { op: count-distinct, field: bad }\n        first: { op: min, field: amount }\n",
      "_data/sales.json": JSON.stringify([
        { id: "a", group: { nested: true }, amount: 1 },
        { id: "b", group: "ok", amount: "not-a-number", bad: { nested: true } },
        { id: "c", group: "ok", amount: 2 },
      ]),
    },
    (_root, result) => {
      assert.ok(errorIds(result.diagnostics).includes("data.aggregate-key"));
      assert.ok(errorIds(result.diagnostics).includes("data.aggregate-number"));
      assert.ok(errorIds(result.diagnostics).includes("data.aggregate-distinct"));
      assert.ok(errorIds(result.diagnostics).includes("data.aggregate-bound"));
      assert.equal(result.site.collections["summary"], undefined);
    },
  );

  await withSite(
    {
      "mizzen.yml":
        "collections:\n  events:\n    source: _data/events.json\n  summary:\n    source: events\n    aggregate:\n      by:\n        - { field: at, period: month, timezone: UTC }\n      metrics:\n        count: { op: count }\n",
      "_data/events.json": JSON.stringify([{ id: "a", at: 42 }, { id: "b", at: "not-a-date" }]),
    },
    (_root, result) => {
      assert.deepEqual(errorIds(result.diagnostics), ["data.aggregate-period", "data.aggregate-period"]);
    },
  );
});

test("contradictory aggregate rules and a missing filter reference date are rejected", async () => {
  await withSite(
    {
      "mizzen.yml":
        "collections:\n  sales:\n    source: _data/sales.yml\n  summary:\n    source: sales\n    id: region\n    aggregate:\n      by:\n        - { field: region, period: month, timezone: Mars/Olympus }\n        - region\n      metrics:\n        region: { op: count }\n        bad: { op: sum }\n",
      "_data/sales.yml": SALES,
    },
    (_root, result) => {
      for (const id of ["data.aggregate-id-field", "data.aggregate-by", "data.aggregate-timezone", "data.aggregate-metric-name", "data.aggregate-metric-field"]) {
        assert.ok(errorIds(result.diagnostics).includes(id), id);
      }
    },
  );

  await withSite(
    site("      by: [region]\n      where: { date: { before: reference } }\n      metrics:\n        orders: { op: count }\n"),
    (_root, result) => {
      assert.ok(errorIds(result.diagnostics).includes("data.aggregate-reference"));
    },
  );
});
