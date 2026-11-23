import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { surfaceReportOf } from "../src/surface/report.ts";

/** A minimal site model with one page. */
function site(surface: Record<string, unknown>) {
  return {
    config: {
      title: "S",
      base: "",
      lang: "en",
      dir: "ltr" as const,
      languages: [],
      source: ".",
      include: [],
      exclude: [],
      navigation: "_data/navigation.yml",
      collections: {},
      feeds: {},
      defaults: [],
      theme: {},
      search: {} as const,
      redirects: {},
      outputs: {},
      surface,
    },
    pages: [],
    nav: {},
    collections: {},
    data: {},
  };
}

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "surface-report-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const VALID_ADAPTER = `
export default () => ({
  version: 1,
  area: "api",
  items: [{ id: "symbol:extra", area: "api", kind: "symbol", name: "extra", source: { file: "a.ts", line: 1, column: 1, endLine: 1, endColumn: 1 }, stability: "stable" }],
  findings: [],
});
`;

const INVALID_ADAPTER = `
export default () => ({ version: 1, area: "api", items: [{ id: "" }], findings: [] });
`;

test("a valid external adapter adds its items", async () => {
  const root = tree({ "adapters/extra.mjs": VALID_ADAPTER });
  try {
    const model = site({ adapters: [{ area: "api", source: "adapters/extra.mjs" }] });
    const { report, diagnostics } = await surfaceReportOf({ root, site: model as never });
    assert.ok(report.items.some((item) => item.id === "symbol:extra"));
    assert.deepEqual(diagnostics.filter((finding) => finding.severity === "error"), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an adapter that exports no function is one error and contributes nothing", async () => {
  const root = tree({ "adapters/empty.mjs": "export const notAnAdapter = 1;\n" });
  try {
    const model = site({ adapters: [{ area: "api", source: "adapters/empty.mjs" }] });
    const { report, diagnostics } = await surfaceReportOf({ root, site: model as never });
    assert.ok(diagnostics.some((finding) => finding.id === "surface.adapter-shape"));
    assert.ok(!report.items.some((item) => item.id === "symbol:extra"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an adapter whose result is not the contract is rejected whole, with one error", async () => {
  const root = tree({ "adapters/bad.mjs": INVALID_ADAPTER });
  try {
    const model = site({ adapters: [{ area: "api", source: "adapters/bad.mjs" }] });
    const { report, diagnostics } = await surfaceReportOf({ root, site: model as never });
    const invalid = diagnostics.filter((finding) => finding.id === "surface.invalid-adapter");
    assert.equal(invalid.length, 1);
    assert.equal(invalid[0]?.severity, "error");
    assert.ok(!report.items.some((item) => item.id.startsWith("symbol:")) || report.items.every((item) => item.id !== "symbol:extra"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an adapter module that fails to import is one error, not a crash", async () => {
  const root = tree({ "adapters/throws.mjs": "throw new Error('boom');\n" });
  try {
    const model = site({ adapters: [{ area: "api", source: "adapters/throws.mjs" }] });
    const { diagnostics } = await surfaceReportOf({ root, site: model as never });
    assert.ok(diagnostics.some((finding) => finding.id === "surface.invalid-adapter" && /boom/.test(finding.message)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
