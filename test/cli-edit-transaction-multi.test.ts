import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const BIN = fileURLToPath(new URL("../bin/mizzen.ts", import.meta.url));

/** A temporary folder holding `files`, removed by the caller. */
function tree(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "cli-edit-transaction-multi-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** SHA-256, as the transaction and proof records write it. */
function hash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Runs the public CLI entry, as an installed caller would, and returns its output. */
function cli(cwd: string, args: readonly string[]): { readonly code: number; readonly stdout: string; readonly stderr: string } {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8" });
  return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

/** One patch from `expected` to `replacement` on one line. */
function patch(line: number, column: number, endLine: number, endColumn: number, expected: string, replacement: string) {
  return { span: { line, column, endLine, endColumn }, expected, replacement };
}

/** Writes a transaction JSON file for the current bytes of `entries`, with one patch each. */
function writeTransaction(
  root: string,
  name: string,
  entries: readonly { readonly file: string; readonly patches: readonly ReturnType<typeof patch>[] }[],
  extra: Record<string, unknown> = {},
): string {
  const files: Record<string, string> = {};
  for (const entry of entries) files[entry.file] = hash(readFileSync(join(root, entry.file), "utf8"));
  const path = join(root, name);
  writeFileSync(
    path,
    `${JSON.stringify({
      version: 1,
      task: { id: "task-1178" },
      snapshot: { files },
      patches: entries.map((entry) => ({
        file: entry.file,
        patches: entry.patches.map((item) => ({ ...item, beforeHash: files[entry.file] })),
      })),
      preconditions: { requireBeforeHash: true, validateContent: true },
      ...extra,
    }, null, 2)}\n`,
  );
  return path;
}

test("the public CLI previews, conflicts, rolls back, and completes an atomic edit transaction", () => {
  const root = tree({ "docs/a.md": "# A\n", "docs/b.md": "# B\n" });
  const firstTransaction = writeTransaction(root, "tx.json", [
    { file: "docs/a.md", patches: [patch(1, 3, 1, 3, "A", "AA")] },
    { file: "docs/b.md", patches: [patch(1, 3, 1, 3, "B", "BB")] },
  ]);
  const receipt = `${firstTransaction}.receipt.json`;
  // A second transaction planned against the same bytes goes stale when the first applies.
  writeFileSync(join(root, "second.json"), readFileSync(firstTransaction, "utf8"));
  try {
    const preview = cli(root, ["edit", "transaction", firstTransaction, root, "--dry-run", "--format", "json"]);
    assert.equal(preview.code, 0, preview.stderr);
    const previewReport = JSON.parse(preview.stdout) as { applied: boolean; dryRun: boolean; diff: string; checks: { id: string }[] };
    assert.equal(previewReport.dryRun, true);
    assert.equal(previewReport.applied, false);
    assert.match(previewReport.diff, /^--- a\/docs\/a\.md$/m);
    assert.match(previewReport.diff, /^--- a\/docs\/b\.md$/m);
    assert.ok(previewReport.checks.some((check) => check.id === "content:docs/a.md"));
    assert.equal(existsSync(receipt), false, "the preview writes no receipt");
    assert.equal(readFileSync(join(root, "docs/a.md"), "utf8"), "# A\n");

    // Mid-transaction failure: the proof destination is a directory, so nothing is committed.
    mkdirSync(`${receipt}.proof.json`);
    const failed = cli(root, ["edit", "transaction", firstTransaction, root, "--format", "json"]);
    assert.equal(failed.code, 1);
    const failedReport = JSON.parse(failed.stdout) as { applied: boolean; status: string };
    assert.equal(failedReport.applied, false);
    assert.equal(failedReport.status, "failed");
    assert.equal(readFileSync(join(root, "docs/a.md"), "utf8"), "# A\n");
    assert.equal(readFileSync(join(root, "docs/b.md"), "utf8"), "# B\n");
    assert.equal(existsSync(receipt), false);
    assert.equal(existsSync(`${firstTransaction}.audit.jsonl`), false);
    rmSync(`${receipt}.proof.json`, { recursive: true });

    const applied = cli(root, ["edit", "transaction", firstTransaction, root, "--format", "json"]);
    assert.equal(applied.code, 0, applied.stderr);
    const appliedReport = JSON.parse(applied.stdout) as {
      applied: boolean;
      files: { file: string; beforeHash: string; afterHash: string }[];
    };
    assert.equal(appliedReport.applied, true);
    assert.equal(readFileSync(join(root, "docs/a.md"), "utf8"), "# AA\n");
    assert.equal(readFileSync(join(root, "docs/b.md"), "utf8"), "# BB\n");
    assert.deepEqual(
      appliedReport.files.map((file) => [file.file, file.beforeHash, file.afterHash]),
      [
        ["docs/a.md", hash("# A\n"), hash("# AA\n")],
        ["docs/b.md", hash("# B\n"), hash("# BB\n")],
      ],
    );

    // The stale second transaction is refused by hash and changes nothing.
    const conflict = cli(root, ["edit", "transaction", join(root, "second.json"), root, "--format", "json"]);
    assert.equal(conflict.code, 1);
    const conflictReport = JSON.parse(conflict.stdout) as {
      applied: boolean;
      conflicts: { kind: string; options: string[] }[];
    };
    assert.equal(conflictReport.applied, false);
    assert.equal(conflictReport.conflicts[0]?.kind, "stale-snapshot");
    assert.ok(conflictReport.conflicts[0]?.options.includes("rebase"));
    assert.equal(readFileSync(join(root, "docs/a.md"), "utf8"), "# AA\n");

    // A later independent edit to b.md survives the rollback; only a.md is restored.
    writeFileSync(join(root, "docs/b.md"), "# independent\n");
    const rolledBack = cli(root, ["edit", "rollback", receipt, root, "--format", "json"]);
    assert.equal(rolledBack.code, 0, rolledBack.stderr);
    const rollbackReport = JSON.parse(rolledBack.stdout) as { restored: string[]; preserved: string[] };
    assert.deepEqual(rollbackReport.restored, ["docs/a.md"]);
    assert.deepEqual(rollbackReport.preserved, ["docs/b.md"]);
    assert.equal(readFileSync(join(root, "docs/a.md"), "utf8"), "# A\n");
    assert.equal(readFileSync(join(root, "docs/b.md"), "utf8"), "# independent\n");

    // Final success with the expected hashes at every stage.
    const finalTransaction = writeTransaction(root, "final.json", [
      { file: "docs/a.md", patches: [patch(1, 3, 1, 3, "A", "Final A")] },
      { file: "docs/b.md", patches: [patch(1, 3, 1, 13, "independent", "Final B")] },
    ]);
    const final = cli(root, ["edit", "transaction", finalTransaction, root, "--format", "json"]);
    assert.equal(final.code, 0, final.stderr);
    const finalReport = JSON.parse(final.stdout) as {
      applied: boolean;
      files: { file: string; beforeHash: string; afterHash: string }[];
    };
    assert.equal(finalReport.applied, true);
    assert.deepEqual(
      finalReport.files.map((file) => [file.file, file.beforeHash, file.afterHash]),
      [
        ["docs/a.md", hash("# A\n"), hash("# Final A\n")],
        ["docs/b.md", hash("# independent\n"), hash("# Final B\n")],
      ],
    );
    assert.equal(readFileSync(`${finalTransaction}.receipt.json`, "utf8").includes(hash("# Final A\n")), true);
    assert.equal(readFileSync(`${finalTransaction}.audit.jsonl`, "utf8").split("\n").filter((line) => line !== "").length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
