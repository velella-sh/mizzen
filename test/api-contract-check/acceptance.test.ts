import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { main } from "../../src/cli/index.ts";
import type { Diagnostic } from "../../src/contracts/index.ts";
import { buildModel } from "../../src/model/build.ts";
import { driftReportOf } from "../../src/outputs/drift-report.ts";

const THEME = fileURLToPath(new URL("../../../lateen", import.meta.url));
const HEALTHY = fileURLToPath(new URL("../../fixtures/api-contract-check/", import.meta.url));
const BREAKING = fileURLToPath(new URL("../../fixtures/api-contract-check-breaking/", import.meta.url));
const UNCHECKED = fileURLToPath(new URL("../../fixtures/api-contract-check-unchecked/", import.meta.url));

function capture(): { logs: string[] } {
  return { logs: [] };
}

async function doctorJson(root: string): Promise<{ code: number; diagnostics: readonly Diagnostic[] }> {
  const { logs } = capture();
  const code = await main(["doctor", root, "--theme", THEME, "--format", "json"], {
    log: (message) => logs.push(message),
    error: (message) => logs.push(message),
  });
  return { code, diagnostics: (JSON.parse(logs.join("\n")) as { diagnostics: Diagnostic[] }).diagnostics };
}

test("the healthy fixture is clean and writes no contract finding", async () => {
  const { code, diagnostics } = await doctorJson(HEALTHY);
  assert.equal(code, 0);
  assert.deepEqual(diagnostics.filter((diagnostic) => diagnostic.id.startsWith("drift.")), []);

  const report = await driftReportOf((await buildModel(HEALTHY)).site, { root: HEALTHY });
  assert.deepEqual(report.pages, {});
});

test("a changed signature fails the doctor at the claim, with its path and line", async () => {
  const { code, diagnostics } = await doctorJson(BREAKING);
  assert.equal(code, 1);
  const finding = diagnostics.find((diagnostic) => diagnostic.id === "drift.signature-mismatch");
  assert.equal(finding?.severity, "error");
  assert.equal(finding?.pos?.file, "docs/widgets.md");
  assert.equal(finding?.pos?.line, 3);
  assert.match(finding?.message ?? "", /"src\/widget\.ts"/);

  const report = await driftReportOf((await buildModel(BREAKING)).site, { root: BREAKING });
  const reported = Object.values(report.pages).flat()[0];
  assert.equal(reported?.kind, "drift.signature-mismatch");
  assert.equal(reported?.state, "mismatch");
  assert.equal(reported?.severity, "error");
  assert.equal(reported?.source?.file, "docs/widgets.md");
  assert.equal(reported?.source?.line, 3);
});

test("an unchecked claim stays visible and exits zero", async () => {
  const { code, diagnostics } = await doctorJson(UNCHECKED);
  assert.equal(code, 0);
  const finding = diagnostics.find((diagnostic) => diagnostic.id === "drift.signature-unchecked");
  assert.equal(finding?.severity, "warning");
  assert.equal(finding?.pos?.file, "docs/widgets.md");
  assert.equal(finding?.pos?.line, 3);

  const report = await driftReportOf((await buildModel(UNCHECKED)).site, { root: UNCHECKED });
  const reported = Object.values(report.pages).flat()[0];
  assert.equal(reported?.kind, "drift.signature-unchecked");
  assert.equal(reported?.state, "unchecked");
  assert.equal(reported?.severity, "warning");
  assert.equal(reported?.source?.line, 3);
});
