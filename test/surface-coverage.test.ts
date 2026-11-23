import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import type { Page } from "../src/contracts/content.ts";
import type { SurfaceItem, SurfaceMatch } from "../src/contracts/surface.ts";
import { buildModel } from "../src/model/build.ts";
import { pageJson } from "../src/outputs/page-json.ts";
import { surface as surfaceOutput } from "../src/outputs/surface.ts";
import { compareSurfaceReports } from "../src/surface/compare.ts";
import { matchDocumentation } from "../src/surface/match.ts";
import { surfaceReportOf } from "../src/surface/report.ts";
import { main } from "../src/cli/index.ts";

const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;
const schema = JSON.parse(readFileSync(new URL("../schema/surface-report.schema.json", import.meta.url), "utf8")) as object;
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

/** A temporary fixture site holding `files`. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "surface-coverage-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** A site whose config declares one command and documents only the first of two. */
const FIXTURE: Record<string, string> = {
  "mizzen.yml": "title: Surface\nsurface:\n  package: pkg/index.ts\n  docs: [docs]\n",
  "pkg/index.ts": [
    "/** Build the site. */",
    "export function buildSite(root: string): Promise<void> { return Promise.resolve(); }",
    "/** A brand-new export the docs do not mention. */",
    "export function brandNewThing(): string { return \"x\"; }",
  ].join("\n"),
  "docs/index.md": "# Guide\n\nCall `buildSite` to build the site.\n",
};

function capture() {
  const logs: string[] = [];
  const errors: string[] = [];
  return { logs, errors, io: { log: (m: string) => { logs.push(m); }, error: (m: string) => { errors.push(m); } } };
}

test("#1343 matching distinguishes complete, partial, and missing documentation", async () => {
  const page = (file: string, markdown: string): Page => ({
    url: `/${file.replace(/\.md$/, "")}/`,
    source: { file, line: 1, column: 1, endLine: 1, endColumn: 1 },
    frontMatter: {},
    title: file,
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "",
    markdown,
    kind: "doc",
  });
  const pages = [page("docs/a.md", "Call `buildSite`.\n"), page("docs/b.md", "# brandNewThing\n\nNo link or code here.\n")];
  const items = [
    { id: "symbol:buildSite", area: "api" as const, kind: "symbol" as const, name: "buildSite", source: { file: "pkg/index.ts", line: 2, column: 1, endLine: 2, endColumn: 1 }, stability: "stable" as const },
    { id: "symbol:brandNewThing", area: "api" as const, kind: "symbol" as const, name: "brandNewThing", source: { file: "pkg/index.ts", line: 4, column: 1, endLine: 4, endColumn: 1 }, stability: "stable" as const },
    { id: "symbol:unmentioned", area: "api" as const, kind: "symbol" as const, name: "unmentioned", source: { file: "pkg/index.ts", line: 6, column: 1, endLine: 6, endColumn: 1 }, stability: "stable" as const },
  ];
  const { matches } = await matchDocumentation({ pages, items });
  const state = new Map(matches.map((match) => [match.item, match.state]));
  assert.equal(state.get("symbol:buildSite"), "complete");
  assert.equal(state.get("symbol:brandNewThing"), "partial", "a heading names the item but nothing links it");
  assert.equal(state.get("symbol:unmentioned"), "missing");
});

test("#1344 a new undocumented surface item is reported as a gap with its kind, id, source, and version", async () => {
  const root = tree(FIXTURE);
  try {
    const model = await buildModel(root);
    const { report } = await surfaceReportOf({ root, site: model.site, version: "0.2.7" });
    assert.equal(validate(report), true, JSON.stringify(validate.errors));

    const documented = report.matches.find((match) => match.item === "symbol:buildSite");
    assert.equal(documented?.state, "complete");
    const gap = report.gaps.find((entry) => entry.item === "symbol:brandNewThing");
    assert.ok(gap !== undefined, "the brand-new export is a gap");
    assert.equal(gap?.kind, "symbol");
    assert.equal(gap?.area, "api");
    assert.equal(gap?.gap, "undocumented");
    assert.equal(gap?.source.file, "pkg/index.ts");
    assert.equal(gap?.introduced, "0.2.7");
    assert.ok(!report.gaps.some((entry) => entry.item === "symbol:buildSite"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1344 a documented exclusion is counted apart and never appears as a gap", async () => {
  const root = tree({
    ...FIXTURE,
    "mizzen.yml": `${FIXTURE["mizzen.yml"]}  exclude:\n    - id: symbol:brandNewThing\n      reason: Internal during preview.\n`,
  });
  try {
    const model = await buildModel(root);
    const { report } = await surfaceReportOf({ root, site: model.site, version: "0.2.7" });
    assert.equal(validate(report), true, JSON.stringify(validate.errors));
    assert.ok(!report.gaps.some((entry) => entry.item === "symbol:brandNewThing"), "an exclusion is not a gap");
    assert.deepEqual(report.exclusions, [{ id: "symbol:brandNewThing", reason: "Internal during preview." }]);
    assert.equal(report.coverage.counts.excluded, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1345 a source file rename alone does not cause a coverage regression", async () => {
  const root = tree(FIXTURE);
  try {
    const model = await buildModel(root);
    const { report: before } = await surfaceReportOf({ root, site: model.site, version: "0.2.7" });

    // The item is the same symbol, moved to another file and line; its id and documentation state are unchanged.
    const after = structuredClone(before);
    const moved = after.items.find((item) => item.id === "symbol:brandNewThing");
    assert.ok(moved !== undefined);
    (moved as { source: typeof moved.source }).source = { file: "pkg/moved.ts", line: 99, column: 1, endLine: 99, endColumn: 1 };

    const comparison = compareSurfaceReports(before, after);
    assert.deepEqual(comparison.changes, [], "a move is not a change");
    assert.equal(comparison.delta.total, 0);
    assert.equal(comparison.delta.documented, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1345 comparing versions reports added, removed, and newly documented items", async () => {
  const root = tree(FIXTURE);
  try {
    const model = await buildModel(root);
    const { report: before } = await surfaceReportOf({ root, site: model.site, version: "0.2.6" });
    type MutableReport = { items: SurfaceItem[]; matches: SurfaceMatch[] } & Record<string, unknown>;
    const after = structuredClone(before) as unknown as MutableReport;

    // Document the new item, add one more, and drop one. The clone is mutable; the report type is readonly.
    const brandNew = after.matches.find((match) => match.item === "symbol:brandNewThing");
    assert.ok(brandNew !== undefined);
    (brandNew as { state: string }).state = "complete";
    after.items.push({ id: "symbol:another", area: "api", kind: "symbol", name: "another", source: { file: "pkg/index.ts", line: 8, column: 1, endLine: 8, endColumn: 1 }, stability: "stable" });
    after.matches.push({ item: "symbol:another", area: "api", state: "missing", evidence: [] });
    const kept = after.items.findIndex((item) => item.id === "symbol:buildSite");
    after.items.splice(kept, 1);
    after.matches = after.matches.filter((match) => match.item !== "symbol:buildSite");

    const comparison = compareSurfaceReports(before, after as unknown as typeof before);
    const byId = new Map(comparison.changes.map((change) => [change.id, change.change]));
    assert.equal(byId.get("symbol:brandNewThing"), "documented");
    assert.equal(byId.get("symbol:another"), "added");
    assert.equal(byId.get("symbol:buildSite"), "removed");
    assert.equal(comparison.baseline, "0.2.6");
    assert.equal(comparison.current, "0.2.6");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1346 the surface output writes surface.json and each page JSON carries the counts", async () => {
  const root = tree(FIXTURE);
  try {
    const model = await buildModel(root);
    const reported: unknown[] = [];
    const ctx = {
      renderPage: () => Promise.reject(new Error("no render in this test")),
      build: { root, workers: 1 },
      report: (diagnostic: unknown) => { reported.push(diagnostic); },
    };
    const files = await surfaceOutput.run(model.site, ctx);
    const body = files.find((file) => file.path === "surface.json");
    assert.ok(body !== undefined);
    const report = JSON.parse(String(body.contents)) as { version: number; coverage: { counts: { total: number } } };
    assert.equal(validate(report), true, JSON.stringify(validate.errors));
    assert.ok(report.coverage.counts.total >= 2);

    const pageFiles = await pageJson.run(model.site, ctx);
    const index = pageFiles.find((file) => file.path.endsWith("index.json"));
    assert.ok(index !== undefined);
    const page = JSON.parse(String(index.contents)) as { surface?: { gaps: number; coverage: { counts: { total: number } } } };
    assert.ok(page.surface !== undefined, "the page JSON carries the surface summary");
    assert.equal(page.surface?.coverage.counts.total, report.coverage.counts.total);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1343 a code reference at an item's declaration counts, and a directive names a data field", async () => {
  const page: Page = {
    url: "/ref/",
    source: { file: "docs/ref.md", line: 1, column: 1, endLine: 1, endColumn: 1 },
    frontMatter: {},
    title: "ref",
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "",
    markdown: "See src/view.ts:3 for the view.\n\nList :field[name] values.\n",
    kind: "doc",
  };
  const items = [
    { id: "symbol:view", area: "api" as const, kind: "symbol" as const, name: "view", source: { file: "src/view.ts", line: 3, column: 1, endLine: 3, endColumn: 1 }, stability: "stable" as const },
    { id: "field:people.name", area: "data" as const, kind: "field" as const, name: "people.name", source: { file: "_data/people.yml", line: 1, column: 1, endLine: 1, endColumn: 1 }, stability: "stable" as const },
  ];
  const { matches } = await matchDocumentation({ pages: [page], items });
  const state = new Map(matches.map((match) => [match.item, match.state]));
  assert.equal(state.get("symbol:view"), "complete", "a file:line reference at the declaration is strong");
  assert.equal(state.get("field:people.name"), "complete", "a :field directive names the data field");
});

test("#1343 a heading that names the item is weak evidence, so the item is partial", async () => {
  const page: Page = {
    url: "/b/",
    source: { file: "notes/b.md", line: 1, column: 1, endLine: 1, endColumn: 1 },
    frontMatter: {},
    title: "b",
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "",
    markdown: "# buildSite\n\nNo link or code here.\n",
    kind: "doc",
  };
  const items = [{ id: "symbol:buildSite", area: "api" as const, kind: "symbol" as const, name: "buildSite", source: { file: "pkg/index.ts", line: 2, column: 1, endLine: 2, endColumn: 1 }, stability: "stable" as const }];
  const { matches } = await matchDocumentation({ pages: [page], items });
  assert.equal(matches[0]?.state, "partial");
});

test("#1346 the same site gives the same report bytes, in the same order", async () => {
  const root = tree(FIXTURE);
  try {
    const model = await buildModel(root);
    const first = await surfaceReportOf({ root, site: model.site, version: "0.2.7" });
    const second = await surfaceReportOf({ root, site: model.site, version: "0.2.7" });
    assert.equal(JSON.stringify(first.report), JSON.stringify(second.report), "two reports are byte-identical");
    const areas = first.report.coverage.areas.map((row) => row.area);
    assert.deepEqual(areas, ["api", "cli", "config", "openapi", "data", "version"], "areas are in report order");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1346 mizzen surface rejects bad arguments, writes to --out, and passes a met --min", async () => {
  const root = tree(FIXTURE);
  try {
    const badFormat = capture();
    assert.equal(await main(["surface", root, "--format", "yaml"], badFormat.io), 2);
    assert.match(badFormat.errors.join("\n"), /--format must be text or json/);

    const badMin = capture();
    assert.equal(await main(["surface", root, "--min", "101"], badMin.io), 2);
    assert.match(badMin.errors.join("\n"), /0 to 100/);

    const unknown = capture();
    assert.equal(await main(["surface", root, "--nope"], unknown.io), 2);

    const out = join(root, "report.json");
    const written = capture();
    assert.equal(await main(["surface", root, "--json", "--out", out], written.io), 0);
    const stored = JSON.parse(readFileSync(out, "utf8")) as { version: number };
    assert.equal(stored.version, 1);
    assert.deepEqual(written.logs, [], "the report went to the file, not stdout");

    const met = capture();
    assert.equal(await main(["surface", root, "--min", "0"], met.io), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1346 a page JSON has no surface summary when the site does not declare one", async () => {
  const root = tree({ "mizzen.yml": "title: Plain\n", "index.md": "# Home\n" });
  try {
    const model = await buildModel(root);
    const files = await pageJson.run(model.site, { renderPage: () => Promise.reject(new Error("no render")), build: { root, workers: 1 }, report: () => {} });
    for (const file of files) {
      const body = JSON.parse(String(file.contents)) as Record<string, unknown>;
      assert.ok(!("surface" in body), "a site without `surface` writes no summary");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1346 mizzen surface prints JSON, compares a baseline, and gates on --min", async () => {
  const root = tree(FIXTURE);
  try {
    const json = capture();
    assert.equal(await main(["surface", root, "--json", "--version", "0.2.7"], json.io), 0);
    const report = JSON.parse(json.logs.join("\n")) as { version: number; gaps: { item: string }[] };
    assert.equal(validate(report), true, JSON.stringify(validate.errors));
    assert.ok(report.gaps.some((gap) => gap.item === "symbol:brandNewThing"));

    const baselineFile = join(root, "baseline.json");
    writeFileSync(baselineFile, json.logs.join("\n"));

    const compared = capture();
    assert.equal(await main(["surface", root, "--json", "--baseline", baselineFile], compared.io), 0);
    const comparison = JSON.parse(compared.logs.join("\n")) as { comparison: { changes: unknown[] } };
    assert.deepEqual(comparison.comparison.changes, []);

    const gated = capture();
    assert.equal(await main(["surface", root, "--min", "99"], gated.io), 1);
    assert.match(gated.errors.join("\n"), /below --min 99%/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
