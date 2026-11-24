import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import { buildModel } from "../src/model/build.ts";
import { behaviorReportOf, behaviorReportWith, queryBehaviors } from "../src/behavior/report.ts";
import { behaviorMatrixHtml } from "../src/behavior/matrix.ts";
import { formatBehaviorJson } from "../src/behavior/format.ts";
import { behavior as behaviorOutput } from "../src/outputs/behavior.ts";
import {
  behavior,
  behaviorPage,
  behaviorTree,
  evidenceLock,
  FIXTURE_CONFIG,
  symbol,
  testFile,
} from "./behavior-fixture.ts";

const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;
const schema = JSON.parse(readFileSync(new URL("../schema/behavior-report.schema.json", import.meta.url), "utf8")) as object;
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

/** A fixture with a public behavior, an unverified one, a deprecated replacement, and private data. */
function matrixSite(): string {
  const entries = [
    behavior({
      id: "public.escape",
      title: "<script>alert(1)</script>",
      normative: "A < B & C.",
      surface: ["symbol:greet"],
      testFile: "test/greet.test.ts",
      testName: "greet returns the name",
      evidenceUrl: "https://ci.example.org/run",
      evidenceKind: "ci",
    }),
    behavior({
      id: "public.unverified",
      surface: ["symbol:greet"],
      testFile: "test/greet.test.ts",
      testName: "greet returns the name",
    }),
    behavior({
      id: "public.deprecated",
      status: "deprecated",
      deprecated: "2.0.0",
      replacement: "public.escape",
      surface: ["symbol:farewell"],
      evidenceUrl: "/evidence/deprecation",
      evidenceKind: "document",
    }),
    behavior({
      id: "private.secret",
      title: "Secret behavior",
      public: false,
      surface: ["symbol:greet"],
      testFile: "test/greet.test.ts",
      testName: "greet returns the name",
      evidenceUrl: "https://secret.example.org/run",
    }),
    behavior({
      id: "public.private-evidence",
      surface: ["symbol:greet"],
      testFile: "test/greet.test.ts",
      testName: "greet returns the name",
      evidenceUrl: "https://secret.example.org/private-run",
      evidencePublic: false,
    }),
  ];
  return behaviorTree({
    "mizzen.yml": [
      "title: Behavior matrix",
      "base: /mizzen",
      "exclude: [test]",
      "surface:",
      "  package: pkg/index.ts",
      "  docs: [docs]",
      "",
    ].join("\n"),
    "pkg/index.ts": [symbol("greet", "(name: string): string"), symbol("farewell", "(name: string): string")].join("\n"),
    "test/greet.test.ts": testFile("greet returns the name"),
    ".mizzen/evidence.lock.json": evidenceLock("unused"),
    "docs/api.md": behaviorPage(entries),
  });
}

test("#1355 the public matrix has JSON and HTML by status, version, and environment, with evidence links", async () => {
  const root = matrixSite();
  try {
    const model = await buildModel(root);
    const { report } = await behaviorReportOf({ site: model.site, root, version: "2.5.0" });
    const versioned = behaviorReportWith(report, queryBehaviors(report, { version: "2.5.0" }).behaviors);
    const json = formatBehaviorJson(versioned);
    assert.equal(validate(JSON.parse(json)), true, JSON.stringify(validate.errors));
    assert.match(json, /"public\.escape"/);
    assert.match(json, /"public\.deprecated"/);
    assert.match(json, /"statusAtVersion"/);

    const html = behaviorMatrixHtml(versioned, { base: "/mizzen" });
    assert.match(html, /Behavior contracts at 2\.5\.0/);
    assert.match(html, /id="behavior-public\.escape"/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.equal(html.includes("<script>alert(1)</script>"), false, "the title is escaped");
    assert.match(html, /href="https:\/\/ci\.example\.org\/run"/);
    assert.match(html, /href="\/mizzen\/evidence\/deprecation"/, "a root-relative evidence link is written under base");
    assert.match(html, /href="#behavior-public\.escape"/, "a replacement links to its target row");
    assert.match(html, /unverified/);
    assert.match(html, /2 private withheld|private withheld/);
    assert.equal(html.includes("private.secret"), false);
    assert.equal(html.includes("Secret behavior"), false);
    assert.equal(html.includes("secret.example.org"), false, "private evidence values never reach the page");
    assert.match(html, /\.\.\/behavior\.json/);
    assert.match(html, /<table>/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1355 the behavior output writes behavior.json and behavior/index.html only when a page declares a behavior", async () => {
  const root = matrixSite();
  try {
    const model = await buildModel(root);
    const ctx = {
      renderPage: () => Promise.reject(new Error("no render in this test")),
      build: { root, workers: 1 },
      report: () => {},
    };
    const files = await behaviorOutput.run(model.site, ctx);
    const paths = files.map((file) => file.path);
    assert.deepEqual(paths, ["behavior.json", "behavior/index.html"]);
    const json = JSON.parse(String(files.find((file) => file.path === "behavior.json")?.contents)) as { version: number };
    assert.equal(validate(json), true, JSON.stringify(validate.errors));
    const html = String(files.find((file) => file.path === "behavior/index.html")?.contents);
    assert.match(html, /public\.escape/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1355 a site without behavior declarations writes no behavior files", async () => {
  const root = mkdtempSync(join(tmpdir(), "behavior-empty-"));
  try {
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "mizzen.yml"), "title: Empty\n");
    writeFileSync(join(root, "docs", "index.md"), "# Home\n");
    const model = await buildModel(root);
    const files = await behaviorOutput.run(model.site, {
      renderPage: () => Promise.reject(new Error("no render")),
      build: { root, workers: 1 },
      report: () => {},
    });
    assert.deepEqual(files, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
