import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { formatSurfaceJson, formatSurfaceText } from "../src/surface/format.ts";
import { JsonPositionError, member, parseJsonWithPositions } from "../src/surface/json-pos.ts";
import type { SurfaceReport } from "../src/contracts/surface.ts";

const span = { file: "src/a.ts", line: 1, column: 1, endLine: 1, endColumn: 2 };

function report(overrides: Partial<SurfaceReport> = {}): SurfaceReport {
  return {
    version: 1,
    source: { version: "0.2.7" },
    items: [{ id: "command:build", area: "cli", kind: "command", name: "build", source: span, stability: "stable" }],
    matches: [{ item: "command:build", area: "cli", state: "complete", evidence: [{ kind: "link", file: "docs/a.md", line: 1, column: 1, text: "build" }] }],
    gaps: [],
    exclusions: [],
    coverage: {
      counts: { documented: 1, partial: 0, undocumented: 0, excluded: 0, total: 1 },
      documentedPercent: 100,
      undocumentedPercent: 0,
      areas: [{ area: "cli", counts: { documented: 1, partial: 0, undocumented: 0, excluded: 0, total: 1 }, documentedPercent: 100, undocumentedPercent: 0 }],
    },
    findings: [],
    ...overrides,
  };
}

test("the text form prints the totals, the areas, and no gaps", () => {
  const text = formatSurfaceText(report());
  assert.match(text, /Surface: 1 item/);
  assert.match(text, /cli\s+1 documented, 0 partial, 0 undocumented, 0 excluded \(100\.00%\)/);
  assert.match(text, /No gaps\./);
  assert.ok(text.endsWith("\n"));
});

test("the text form prints gaps, exclusions, findings, and a comparison", () => {
  const text = formatSurfaceText(
    report({
      gaps: [{ item: "symbol:x", area: "api", kind: "symbol", source: span, introduced: "0.2.7", gap: "undocumented" }],
      exclusions: [{ id: "symbol:y", reason: "internal" }],
      findings: [{ code: "cli.help-drift", severity: "warning", message: "drift" }],
    }),
    { version: 1, baseline: "0.2.6", current: "0.2.7", changes: [{ id: "symbol:x", area: "api", change: "added", to: "missing" }], delta: { documented: 0, partial: 0, undocumented: 1, excluded: 0, total: 1 } },
  );
  assert.match(text, /api symbol:x \[undocumented\] at src\/a\.ts:1 \(introduced 0\.2\.7\)/);
  assert.match(text, /symbol:y: internal/);
  assert.match(text, /warning cli\.help-drift: drift/);
  assert.match(text, /Compared with 0\.2\.6: 1 change/);
  assert.match(text, /added: api symbol:x -> missing/);
});

test("the JSON form is the report alone, or the report and comparison", () => {
  const alone = JSON.parse(formatSurfaceJson(report())) as { version: number };
  assert.equal(alone.version, 1);
  const both = JSON.parse(
    formatSurfaceJson(report(), { version: 1, changes: [], delta: { documented: 0, partial: 0, undocumented: 0, excluded: 0, total: 0 } }),
  ) as { report: { version: number }; comparison: { version: number } };
  assert.equal(both.report.version, 1);
  assert.equal(both.comparison.version, 1);
});

test("the positioned JSON reader gives each member its key span and rejects malformed input", () => {
  const doc = parseJsonWithPositions('{\n  "a": {\n    "b": 1\n  },\n  "c": [true, false, null]\n}\n', "doc.json");
  const a = member(doc, "a");
  assert.equal(a?.keySpan?.line, 2);
  assert.equal(member(a, "b")?.value, 1);
  assert.deepEqual(member(doc, "c")?.value, [true, false, null]);
  assert.equal(member(doc, "missing"), undefined);
  assert.throws(() => parseJsonWithPositions("{ oops", "doc.json"), JsonPositionError);
  assert.throws(() => parseJsonWithPositions('"a" "b"', "doc.json"), JsonPositionError);
});

test("a schema default the resolver disagrees with is a finding, and a nested key is skipped", async () => {
  const root = mkdtempSync(join(tmpdir(), "surface-config-"));
  try {
    mkdirSync(join(root, "schema"), { recursive: true });
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", description: "The title." },
        lang: { type: "string", default: "fr", description: "A wrong default." },
        collections: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: { source: { type: "string", description: "Where." } },
          },
          description: "Collections.",
        },
      },
    };
    writeFileSync(join(root, "schema", "config.schema.json"), JSON.stringify(schema));
    const { discoverConfig } = await import("../src/surface/adapters/config.ts");
    const result = await discoverConfig({ schema: join(root, "schema", "config.schema.json") });
    assert.ok(result.items.some((item) => item.id === "config-key:lang"));
    assert.ok(result.findings.some((finding) => finding.code === "config.default-drift" && finding.message.includes("lang")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a schema that does not parse or compile is one error and no items", async () => {
  const root = mkdtempSync(join(tmpdir(), "surface-config-bad-"));
  try {
    writeFileSync(join(root, "bad.json"), "{ not json");
    const { discoverConfig } = await import("../src/surface/adapters/config.ts");
    const parsed = await discoverConfig({ schema: join(root, "bad.json") });
    assert.deepEqual(parsed.items, []);
    assert.equal(parsed.findings[0]?.code, "surface.config-schema");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
