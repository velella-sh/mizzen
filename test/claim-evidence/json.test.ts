import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import type { DataRecord, Page, Site, SiteConfig } from "../../src/contracts/index.ts";
import type { OutputContext } from "../../src/contracts/output.ts";
import { pageJson } from "../../src/outputs/page-json.ts";

const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;
const schema = JSON.parse(
  readFileSync(new URL("../../schema/page-json.schema.json", import.meta.url), "utf8"),
) as object;
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

const pos = { file: "_data/findings.yml", startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 };

function config(overrides: Partial<SiteConfig> = {}): SiteConfig {
  return {
    title: "Claim evidence fixture",
    base: "",
    lang: "en",
    dir: "ltr",
    languages: [],
    source: ".",
    include: [],
    exclude: [],
    navigation: "_data/navigation.yml",
    collections: { findings: { source: "_data/findings.yml", evidence: "claims" } },
    feeds: {},
    defaults: [],
    theme: { options: {} },
    search: {},
    redirects: {},
    outputs: {},
    ...overrides,
  };
}

function record(id: string, fields: Record<string, unknown>): DataRecord {
  return { id, fields, position: pos, fieldPositions: {} };
}

function page(url: string, id: string): Page {
  return {
    url,
    source: { file: "_templates/finding.md", line: 1, column: 1, endLine: 1, endColumn: 1 },
    frontMatter: {},
    title: url,
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "",
    markdown: "",
    kind: "doc",
    record: { collection: "findings", id, position: pos, template: "_templates/finding.md", templateLine: 1, fallbacks: [] },
  };
}

function site(records: readonly DataRecord[], pages: readonly Page[], overrides: Partial<SiteConfig> = {}): Site {
  return {
    config: config(overrides),
    pages,
    nav: {},
    collections: { findings: { name: "findings", source: "_data/findings.yml", records } },
    data: {},
  };
}

const ctx: OutputContext = {
  renderPage: () => Promise.reject(new Error("the page JSON never renders a page")),
  report: () => {},
};

/** The record object each page wrote, in page order. */
async function recordsOf(model: Site): Promise<Array<Record<string, unknown>>> {
  const files = await pageJson.run(model, ctx);
  return files.map((file) => {
    const body = JSON.parse(String(file.contents)) as Record<string, unknown>;
    assert.equal(validate(body), true, JSON.stringify(validate.errors));
    return body.record as Record<string, unknown>;
  });
}

const EBB = {
  id: "ebb-node-18",
  statement: "Node 18 reaches end of life.",
  eol: "2025-04-30",
  claims: {
    eol: [
      {
        id: "node-18-schedule",
        title: "Node.js release schedule",
        url: "https://nodejs.org/en/about/previous-releases#release-schedule",
      },
      {
        id: "node-18-announcement",
        title: "Node.js 18 release announcement",
        url: "https://nodejs.org/en/blog/announcements/v18-release-announce",
      },
    ],
  },
};

const OFFING = {
  id: "offing-checkout-v3",
  statement: "Workflows still pin actions/checkout v3.",
  openWorkflows: 1204,
  claims: {
    openWorkflows: {
      id: "workflow-inventory",
      title: "Workflow inventory, 2026-03-01",
      url: "https://offing.example.org/runs/2026-03-01/workflows.json",
      note: "Counted by scripts/inventory.ts; not published.",
    },
  },
};

test("a record page publishes the claim id, title, and url its evidence field names", async () => {
  const model = site(
    [record(EBB.id, { statement: EBB.statement, eol: EBB.eol, claims: EBB.claims }), record(OFFING.id, {
      statement: OFFING.statement,
      openWorkflows: OFFING.openWorkflows,
      claims: OFFING.claims,
    })],
    [page("/findings/ebb-node-18/", EBB.id), page("/findings/offing-checkout-v3/", OFFING.id)],
  );
  const [ebb, offing] = await recordsOf(model);

  assert.deepEqual(ebb, {
    collection: "findings",
    id: "ebb-node-18",
    fields: { statement: "Node 18 reaches end of life.", eol: "2025-04-30" },
    evidence: {
      eol: [
        {
          id: "node-18-schedule",
          title: "Node.js release schedule",
          url: "https://nodejs.org/en/about/previous-releases#release-schedule",
        },
        {
          id: "node-18-announcement",
          title: "Node.js 18 release announcement",
          url: "https://nodejs.org/en/blog/announcements/v18-release-announce",
        },
      ],
    },
  });
  assert.deepEqual(Object.keys(ebb!), ["collection", "id", "fields", "evidence"]);
  const [first] = (ebb!.evidence as Record<string, Array<Record<string, unknown>>>).eol!;
  assert.deepEqual(Object.keys(first!), ["id", "title", "url"]);

  assert.deepEqual(offing, {
    collection: "findings",
    id: "offing-checkout-v3",
    fields: { statement: "Workflows still pin actions/checkout v3.", openWorkflows: 1204 },
    evidence: {
      openWorkflows: [
        {
          id: "workflow-inventory",
          title: "Workflow inventory, 2026-03-01",
          url: "https://offing.example.org/runs/2026-03-01/workflows.json",
        },
      ],
    },
  });
});

test("a private key in the data file never reaches the page JSON", async () => {
  const model = site([record(OFFING.id, { statement: OFFING.statement, openWorkflows: OFFING.openWorkflows, claims: OFFING.claims })], [
    page("/findings/offing-checkout-v3/", OFFING.id),
  ]);
  const files = await pageJson.run(model, ctx);
  const text = String(files[0]!.contents);
  assert.ok(!text.includes("note"), "the private note key is absent");
  assert.ok(!text.includes("Counted by"), "the private note value is absent");
  const [body] = await recordsOf(model);
  assert.ok(!("claims" in (body!.fields as Record<string, unknown>)), "the raw evidence field is not a public field");
});

test("field groups follow the record's field order, not the evidence map's", async () => {
  const claims = {
    eol: { id: "node-18-schedule", title: "Node.js release schedule", url: "https://nodejs.org/en/about/previous-releases" },
    openWorkflows: [
      { id: "workflow-inventory", title: "Workflow inventory", url: "https://offing.example.org/runs/workflows.json" },
      { id: "workflow-inventory-2", title: "Workflow inventory, second run", url: "/reports/workflows-2.json" },
    ],
  };
  const model = site(
    [record("one", { statement: "Both claims.", openWorkflows: 1204, eol: "2025-04-30", claims })],
    [page("/findings/one/", "one")],
  );
  const [body] = await recordsOf(model);
  const evidence = body!.evidence as Record<string, unknown>;
  assert.deepEqual(Object.keys(evidence), ["openWorkflows", "eol"]);
  assert.equal((evidence.openWorkflows as Array<Record<string, unknown>>).length, 2, "the list keeps its order");
  assert.deepEqual(evidence.eol, [
    { id: "node-18-schedule", title: "Node.js release schedule", url: "https://nodejs.org/en/about/previous-releases" },
  ]);
});

test("a record with no evidence carries no evidence key", async () => {
  const model = site(
    [record("bare", { statement: "No sources." }), record("empty", { statement: "Empty.", claims: {} })],
    [page("/findings/bare/", "bare"), page("/findings/empty/", "empty")],
  );
  const [bare, empty] = await recordsOf(model);
  assert.ok(!("evidence" in bare!));
  assert.ok(!("evidence" in empty!));
});

test("an empty list or a broken claim publishes no entry, and the sound claims still publish", async () => {
  const claims = {
    eol: [],
    openWorkflows: { id: "workflow-inventory", url: "https://offing.example.org/runs/workflows.json" },
  };
  const model = site([record("one", { statement: "Broken.", eol: "2025-04-30", openWorkflows: 1, claims })], [
    page("/findings/one/", "one"),
  ]);
  const [body] = await recordsOf(model);
  assert.ok(!("evidence" in body!));
});

test("a collection without an evidence setting publishes its fields unchanged", async () => {
  const model = site([record("one", { statement: "Plain.", claims: { eol: { id: "a", title: "A", url: "https://example.org" } } })], [
    page("/findings/one/", "one"),
  ], { collections: { findings: { source: "_data/findings.yml" } } });
  const [body] = await recordsOf(model);
  assert.ok(!("evidence" in body!));
  assert.ok("claims" in (body!.fields as Record<string, unknown>), "without the setting the field is ordinary data");
});

test("json.fields never publishes the raw evidence field", async () => {
  const model = site([record("one", { statement: "Plain.", eol: "2025-04-30", claims: EBB.claims })], [
    page("/findings/one/", "one"),
  ], { collections: { findings: { source: "_data/findings.yml", evidence: "claims", json: { fields: ["statement", "claims", "eol"] } } } });
  const [body] = await recordsOf(model);
  assert.deepEqual(body!.fields, { statement: "Plain.", eol: "2025-04-30" });
  assert.ok("evidence" in body!);
});
