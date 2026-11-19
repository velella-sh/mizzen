import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main, parseArgs } from "../src/cli/index.ts";
import { formatVerificationProof } from "../src/verification/proof.ts";
import { provedProof } from "./verification-fixture.ts";
import { sha256 } from "../src/data/lock.ts";

/** Runs the CLI with captured output. */
async function run(args: readonly string[]): Promise<{ code: number; logs: string[]; errors: string[] }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const code = await main(args, {
    log: (message) => logs.push(message),
    error: (message) => errors.push(message),
  });
  return { code, logs, errors };
}

test("edit verify parses --input and passes a version 2 proof", async () => {
  assert.deepEqual(
    parseArgs(["edit", "verify", "proof.json", "--site", "site", "--input", "public.json", "--format", "json"]),
    {
      options: {
        command: "edit-verify",
        proof: "proof.json",
        site: "site",
        doctor: false,
        format: "json",
        input: "public.json",
      },
    },
  );

  const directory = mkdtempSync(join(tmpdir(), "cli-edit-verify-v2-"));
  try {
    const proof = provedProof();
    const proofPath = join(directory, "proof.json");
    const inputPath = join(directory, "input.json");
    writeFileSync(proofPath, formatVerificationProof(proof));
    writeFileSync(
      inputPath,
      `${JSON.stringify({
        files: { "docs/install.md": sha256("after\n") },
        before: { "docs/install.md": sha256("before\n") },
        checks: { doctor: { status: "passed", outputHash: sha256("ok\n") } },
        outputHash: proof.outputs.actualHash,
      })}\n`,
    );

    const result = await run(["edit", "verify", proofPath, "--site", directory, "--input", inputPath, "--format", "json"]);
    assert.equal(result.code, 0, result.errors.join(" "));
    const report = JSON.parse(result.logs[0]!) as {
      status: string;
      verification?: { ok: boolean; verdict: string; checked: { checks: number } };
      diagnostics: unknown[];
    };
    assert.equal(report.status, "ok");
    assert.deepEqual(report.diagnostics, []);
    assert.equal(report.verification?.ok, true);
    assert.equal(report.verification?.verdict, "proved");
    assert.equal(report.verification?.checked.checks, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("edit verify exits 2 when the public input cannot be read", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cli-edit-verify-input-"));
  try {
    const proofPath = join(directory, "proof.json");
    const inputPath = join(directory, "input.json");
    writeFileSync(proofPath, formatVerificationProof(provedProof()));
    writeFileSync(inputPath, "{not json\n");
    const result = await run(["edit", "verify", proofPath, "--input", inputPath, "--format", "json"]);
    assert.equal(result.code, 2);
    const report = JSON.parse(result.logs[0]!) as { status: string; diagnostics: { code: string }[] };
    assert.equal(report.status, "invalid");
    assert.deepEqual(report.diagnostics.map((diagnostic) => diagnostic.code), ["verify.input"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
