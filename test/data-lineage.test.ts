import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { main, parseArgs } from "../src/cli/index.ts";
import { loadConfig } from "../src/config/load.ts";
import { loadCollections } from "../src/data/collections.ts";
import { explain, LINEAGE_EVENT_LIMIT, LINEAGE_FORMAT, type LineageReport } from "../src/data/lineage.ts";
import type { TransformEvent } from "../src/data/transform.ts";

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "data-lineage-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const CATALOG = [
  "- sku: a",
  "  name: Alpha",
  "  price: 10",
  "  region: eu",
  "- sku: b",
  "  name: Beta",
  "  price: 20",
  "  region: us",
  "",
].join("\n");

const INVENTORY = ["- sku: a", "  stock: 5", "- sku: b", "  stock: 7", ""].join("\n");

const SALES = [
  "- id: s1",
  "  region: eu",
  "  date: 2026-01-05",
  "  amount: 10",
  "- id: s2",
  "  region: eu",
  "  date: 2026-02-05",
  "  amount: 5",
  "- id: s3",
  "  region: us",
  "  date: 2026-02-06",
  "  amount: 20",
  "",
].join("\n");

const CONFIG = [
  "collections:",
  "  catalog:",
  "    source: data/catalog.yml",
  "    id: sku",
  "    template: templates/catalog.md",
  "    permalink: /catalog/{sku}/",
  "    public: [sku, title, price, stock]",
  "    schemaRenames:",
  "      title: name",
  "    transform:",
  "      steps:",
  "        - id: cents",
  "          op: unit",
  "          field: price",
  "          factor: 100",
  "        - id: fallback-title",
  "          op: default",
  "          field: title",
  "          value: Untitled",
  "        - id: fallback-label",
  "          op: default",
  "          field: label",
  "          value: new",
  "    join:",
  "      type: left",
  "      key: sku",
  "      sources:",
  "        - collection: inventory",
  "          fields: {stock: stock}",
  "  inventory:",
  "    source: data/inventory.yml",
  "    id: sku",
  "  sales:",
  "    source: data/sales.yml",
  "    dates: [date]",
  "  monthly:",
  "    source: sales",
  "    template: templates/month.md",
  "    permalink: /months/{id}/",
  "    dates: [date]",
  "    aggregate:",
  "      by:",
  "        - { field: date, period: month, timezone: Europe/Berlin }",
  "      metrics:",
  "        orders: { op: count }",
  "        revenue: { op: sum, field: amount, decimals: 2 }",
  "api:",
  "  collections:",
  "    catalog:",
  "      fields: [title, price, stock]",
  "",
].join("\n");

const FILES = {
  "mizzen.yml": CONFIG,
  "templates/catalog.md": "# {title}\n",
  "templates/month.md": "# {id}\n",
  "data/catalog.yml": CATALOG,
  "data/inventory.yml": INVENTORY,
  "data/sales.yml": SALES,
};

/** Loads a site and returns the collections plus the transform events the load captured. */
async function load(root: string) {
  const parsed = loadConfig(root);
  const events: TransformEvent[] = [];
  const result = await loadCollections({ root, config: parsed.config, onTransformEvent: (event) => events.push(event) });
  return { config: parsed.config, collections: result.collections, events, diagnostics: [...parsed.diagnostics, ...result.diagnostics] };
}

/** The report for one field, or the error message. */
async function report(root: string, collection: string, id: string, field: string, extra: { readonly public?: boolean } = {}): Promise<LineageReport> {
  const loaded = await load(root);
  const result = await explain(loaded.collections[collection]!, id, field, {
    root,
    config: loaded.config,
    collections: loaded.collections,
    transformEvents: loaded.events,
    ...extra,
  });
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  return (result as { readonly report: LineageReport }).report;
}

test("a report names its format and every event carries the input reference, record, field, and stage", async () => {
  const root = tree(FILES);
  try {
    const found = await report(root, "catalog", "a", "price");
    assert.equal(found.format, LINEAGE_FORMAT);
    assert.equal(found.format, 1);
    assert.ok(found.chain.length > 0);
    for (const event of found.chain) {
      assert.equal(event.format, LINEAGE_FORMAT);
      assert.equal(typeof event.input.collection, "string");
      assert.equal(event.record, "a");
      assert.equal(typeof event.field, "string");
      assert.equal(typeof event.stage, "string");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a raw value traces to the input hash and its row", async () => {
  const root = tree(FILES);
  try {
    const found = await report(root, "inventory", "a", "stock");
    const origin = found.chain[0]!;
    assert.equal(origin.stage, "source");
    assert.equal(origin.op, "origin");
    assert.equal(origin.input.collection, "inventory");
    assert.match(origin.input.sha256 ?? "", /^[a-f0-9]{64}$/);
    assert.equal(origin.input.row, 1);
    assert.equal(found.value, 5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a renamed field follows back to its original path", async () => {
  const root = tree(FILES);
  try {
    const found = await report(root, "catalog", "a", "title");
    const rename = found.chain.find((event) => event.stage === "schema-rename");
    assert.ok(rename !== undefined, "the chain has the schema rename");
    assert.equal(rename.from, "name");
    assert.equal(found.chain[0]!.field, "name");
    assert.equal(found.value, "Alpha");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a default value names the rule that filled it and is marked generated", async () => {
  const root = tree({
    ...FILES,
    "data/catalog.yml": "- sku: c\n  name: Gamma\n  price: 1\n",
  });
  try {
    const found = await report(root, "catalog", "c", "title");
    // A schema rename of the source value is not a generated value.
    assert.equal(found.generated, false);
    const filled = await report(root, "catalog", "c", "label");
    assert.equal(filled.generated, true);
    assert.equal(filled.value, "new");
    const step = filled.chain.find((event) => event.stage === "transform:fallback-label");
    assert.equal(step?.op, "default");
    assert.equal(step?.rule, "fallback-label");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a join reports the selected source and precedence without the rejected values", async () => {
  const root = tree(FILES);
  try {
    const found = await report(root, "catalog", "a", "stock");
    const join = found.chain.find((event) => event.stage === "join:inventory");
    assert.ok(join !== undefined);
    assert.equal(join.source, "inventory");
    assert.equal(join.op, "select");
    assert.equal(join.from, "stock");
    assert.equal(join.reason, "only");
    assert.equal(join.contributors, 1);
    assert.equal(found.chain[0]!.input.collection, "inventory");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an aggregate value names the group rule, snapshot, and contributing inputs", async () => {
  const root = tree(FILES);
  try {
    const found = await report(root, "monthly", "2026-02", "revenue");
    const aggregate = found.chain.find((event) => event.stage === "aggregate:sales");
    assert.ok(aggregate !== undefined);
    assert.equal(aggregate.op, "aggregate");
    assert.equal(aggregate.contributors, 2);
    assert.match(aggregate.rule ?? "", /^metric:revenue$/);
    assert.equal(found.chain[0]!.input.collection, "sales");
    assert.match(found.snapshot?.ref ?? "", /^(sha256:|[a-f0-9]{7,40}$)/);
    assert.equal(found.value, 25);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a final field lists its stages in order back to the source", async () => {
  const root = tree(FILES);
  try {
    const found = await report(root, "catalog", "a", "price");
    const stages = found.chain.map((event) => event.stage);
    assert.deepEqual(stages.slice(0, 2), ["source", "transform:cents"]);
    assert.ok(stages.includes("publish"));
    assert.equal(found.value, 1000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a report connects the field to its page and static API paths", async () => {
  const root = tree(FILES);
  try {
    const found = await report(root, "catalog", "a", "price");
    assert.deepEqual(
      found.outputs.map((output) => `${output.kind} ${output.path}`).sort(),
      ["api /api/v1/catalog/a.json", "page /catalog/a/"],
    );
    const publish = found.chain.filter((event) => event.stage === "publish");
    assert.equal(publish.length, 2);
    assert.equal(publish[0]!.input.collection, "catalog");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an equivalent build produces an identical report", async () => {
  const first = tree(FILES);
  const second = tree(FILES);
  try {
    const left = await report(first, "catalog", "a", "price");
    const right = await report(second, "catalog", "a", "price");
    assert.deepEqual(JSON.parse(JSON.stringify(left)), JSON.parse(JSON.stringify(right)));
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

test("a public report keeps permitted metadata and drops values, paths, and rejected inputs", async () => {
  const root = tree(FILES);
  try {
    const found = await report(root, "catalog", "a", "stock", { public: true });
    const text = JSON.stringify(found);
    assert.equal(found.value, undefined);
    assert.equal(text.includes("data/inventory.yml"), false);
    assert.equal(text.includes("sha256"), true);
    assert.equal(found.chain.some((event) => event.input.source !== undefined), false);
    const loaded = await load(root);
    const denied = await explain(loaded.collections["catalog"]!, "a", "region", {
      root,
      config: loaded.config,
      collections: loaded.collections,
      transformEvents: loaded.events,
      public: true,
    });
    assert.equal(denied.ok, false);
    assert.match((denied as { readonly error: string }).error, /not public; add it to `collections\.catalog\.public`/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a chain stays within the event limit and marks the stages it summarized", async () => {
  const steps: string[] = [];
  let previous = "name";
  for (let index = 0; index < LINEAGE_EVENT_LIMIT + 4; index++) {
    const next = `name${index}`;
    steps.push(`        - id: rename-${index}`, "          op: rename", `          from: ${previous}`, `          to: ${next}`);
    previous = next;
  }
  const root = tree({
    "mizzen.yml": ["collections:", "  items:", "    source: data/items.yml", "    transform:", "      steps:", ...steps, ""].join("\n"),
    "data/items.yml": "- id: a\n  name: Alpha\n",
  });
  try {
    const started = process.memoryUsage().heapUsed;
    const found = await report(root, "items", "a", previous);
    const used = (process.memoryUsage().heapUsed - started) / (1024 * 1024);
    assert.equal(found.chain.length, LINEAGE_EVENT_LIMIT);
    assert.equal(found.summarized, true);
    assert.ok(found.omitted > 0);
    assert.ok(used < 64, `lineage kept the run within 64 MB (used ${used.toFixed(1)} MB)`);
    assert.equal(found.chain[0]!.op, "origin");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a full and a repeated load report the same chain for a changed input", async () => {
  const root = tree(FILES);
  const fresh = tree(FILES);
  try {
    const before = await report(root, "catalog", "a", "price");
    writeFileSync(join(root, "data", "catalog.yml"), CATALOG.replace("price: 10", "price: 12"));
    writeFileSync(join(fresh, "data", "catalog.yml"), CATALOG.replace("price: 10", "price: 12"));
    const increment = await report(root, "catalog", "a", "price");
    const full = await report(fresh, "catalog", "a", "price");
    assert.deepEqual(JSON.parse(JSON.stringify(increment)), JSON.parse(JSON.stringify(full)));
    assert.notEqual(increment.value, before.value);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(fresh, { recursive: true, force: true });
  }
});

test("the CLI explains a field, prints JSON, and exits 2 for a missing target", async () => {
  assert.deepEqual(parseArgs(["data", "explain", "catalog", "a", "site", "--field", "price", "--json"]), {
    options: { command: "data-explain", root: "site", collection: "catalog", id: "a", field: "price", json: true, public: false },
  });
  assert.equal("error" in parseArgs(["data", "explain", "catalog", "a"]), true);
  const root = tree(FILES);
  const logs: string[] = [];
  const errors: string[] = [];
  const io = {
    log: (message: string) => void logs.push(message),
    error: (message: string) => void errors.push(message),
    write: (message: string) => void logs.push(message),
  };
  try {
    assert.equal(await main(["data", "explain", "catalog", "a", root, "--field", "price", "--json"], io), 0, errors.join(" | "));
    const printed = JSON.parse(logs.join("\n")) as LineageReport;
    assert.equal(printed.format, 1);
    assert.equal(printed.field, "price");
    assert.equal(JSON.stringify(printed).includes("Untitled"), false);
    assert.equal(await main(["data", "explain", "catalog", "missing", root, "--field", "price"], io), 2);
    assert.match(errors.at(-1) ?? "", /has no record "missing"/);
    assert.equal(await main(["data", "explain", "catalog", "a", root, "--field", "nope"], io), 2);
    assert.match(errors.at(-1) ?? "", /has no field "nope"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
