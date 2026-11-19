import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { editApply, EditApplyError } from "../src/cli/edit-apply.ts";
import { editTransactionCommand } from "../src/cli/edit-transaction.ts";
import { EditTransactionError } from "../src/edits/edit-transaction.ts";
import { hashSource } from "../src/edits/patch.ts";
import type { AccessPolicy } from "../src/contracts/permissions.ts";
import { parseAccessPolicy } from "../src/permissions/policy.ts";
import { checkTransactionArtifacts, checkWriteTarget, resolveWriteTarget } from "../src/permissions/write.ts";

function policy(value: Record<string, unknown>): AccessPolicy {
  const result = parseAccessPolicy({ version: 1, approvals: { write: false }, ...value });
  assert.equal(result.problems.length, 0, JSON.stringify(result.problems));
  assert.ok(result.policy !== undefined);
  return result.policy;
}

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "permissions-write-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const scope = {
  pages: ["/guide/"],
  blocks: [],
  collections: [],
  files: ["docs/guide.md"],
};

test("a lexical traversal or absolute path is refused before the file system is read", async () => {
  const root = tree({});
  for (const path of ["../secret.md", "/etc/passwd", "docs/../../secret.md", "docs\\guide.md"]) {
    const resolved = await resolveWriteTarget(root, path);
    assert.equal(resolved.target, undefined, path);
    assert.ok(resolved.reason !== undefined);
  }
});

test("a symbolic link target or parent is refused", async () => {
  const root = tree({ "docs/guide.md": "old\n" });
  const outside = tree({ "secret.md": "secret\n" });
  symlinkSync(join(outside, "secret.md"), join(root, "link.md"));
  symlinkSync(outside, join(root, "docs-link"));

  assert.equal((await resolveWriteTarget(root, "link.md")).target, undefined);
  assert.equal((await resolveWriteTarget(root, "docs-link/secret.md")).target, undefined);
  const checked = await checkWriteTarget({
    policy: policy({ capabilities: { write: true }, write: { paths: ["docs-link/**"], scope: { pages: ["/guide/"] } } }),
    siteRoot: root,
    path: "docs-link/secret.md",
    scope: { ...scope, pages: ["/guide/"], files: ["docs-link/secret.md"] },
    task: "task",
    snapshot: "snapshot",
  });
  assert.equal(checked.decision.allowed, false);
  assert.equal(checked.decision.rule, "write.symlink");
});

test("a write needs both the path and the mapped page", async () => {
  const root = tree({ "docs/guide.md": "old\n" });
  const access = policy({ capabilities: { write: true }, write: { paths: ["docs/**"], scope: { pages: ["/guide/"] } } });
  const allowed = await checkWriteTarget({
    policy: access,
    siteRoot: root,
    path: "docs/guide.md",
    scope,
    task: "task",
    snapshot: "snapshot",
  });
  assert.equal(allowed.decision.allowed, true);

  const deniedPage = await checkWriteTarget({
    policy: access,
    siteRoot: root,
    path: "docs/guide.md",
    scope: { ...scope, pages: ["/private/"] },
    task: "task",
    snapshot: "snapshot",
  });
  assert.equal(deniedPage.decision.allowed, false);
  assert.equal(deniedPage.decision.rule, "write.scope");

  const deniedPath = await checkWriteTarget({
    policy: access,
    siteRoot: root,
    path: "other/guide.md",
    scope: { ...scope, files: ["other/guide.md"] },
    task: "task",
    snapshot: "snapshot",
  });
  assert.equal(deniedPath.decision.allowed, false);
  assert.equal(deniedPath.decision.rule, "write.path");
});

test("a transaction transfer outside the allowed path is refused", async () => {
  const root = tree({ "docs/guide.md": "old\n", "other/evil.md": "old\n" });
  const access = policy({ capabilities: { write: true }, write: { paths: ["docs/**"], scope: { pages: ["/guide/"] } } });
  const decision = await checkTransactionArtifacts(
    {
      policy: access,
      siteRoot: root,
      path: "docs/guide.md",
      scope,
      task: "task",
      snapshot: "snapshot",
    },
    [{ path: "docs/guide.md" }, { path: "other/evil.md" }],
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.rule, "write.path");
});

test("edit apply allows a mapped page and refuses the same file for another page", async () => {
  const root = tree({ "guide.md": "old\n" });
  const scratch = mkdtempSync(join(tmpdir(), "permissions-patch-"));
  const patch = join(scratch, "edit.patch.json");
  writeFileSync(
    patch,
    JSON.stringify({
      span: { file: "guide.md", line: 1, column: 1, endLine: 1, endColumn: 3 },
      expected: "old",
      replacement: "new",
      beforeHash: hashSource("old\n"),
    }),
  );
  const access = policy({
    capabilities: { write: true },
    write: { paths: ["guide.md"], scope: { pages: ["/guide/"] } },
  });
  const written = await editApply({ siteRoot: root, patch, access, page: "/guide/" });
  assert.equal(written.file, "guide.md");
  assert.equal(readFileSync(join(root, "guide.md"), "utf8"), "new\n");

  writeFileSync(join(root, "guide.md"), "old\n");
  const deniedPatch = join(scratch, "denied.patch.json");
  writeFileSync(
    deniedPatch,
    JSON.stringify({
      span: { file: "guide.md", line: 1, column: 1, endLine: 1, endColumn: 3 },
      expected: "old",
      replacement: "new",
      beforeHash: hashSource("old\n"),
    }),
  );
  await assert.rejects(
    editApply({ siteRoot: root, patch: deniedPatch, access, page: "/private/" }),
    (error: unknown) => error instanceof EditApplyError && error.code === "edit.access-denied",
  );
  assert.equal(readFileSync(join(root, "guide.md"), "utf8"), "old\n");
});

function transactionFile(root: string, file: string, pages: readonly string[]): string {
  const beforeHash = hashSource(readFileSync(join(root, file), "utf8"));
  const path = join(root, `tx-${file.replace(/[^a-z0-9]+/gi, "-")}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      task: { id: "task" },
      snapshot: { files: { [file]: beforeHash } },
      scope: { pages },
      patches: [
        {
          file,
          patches: [
            {
              span: { line: 1, column: 1, endLine: 1, endColumn: 3 },
              expected: "old",
              replacement: "new",
              beforeHash,
            },
          ],
        },
      ],
      preconditions: { requireBeforeHash: true, validateContent: true },
    }),
  );
  return path;
}

test("edit transaction writes only a file whose path and page the policy allows", async () => {
  const root = tree({ "docs/guide.md": "old\n", "other/guide.md": "old\n" });
  const access = policy({
    capabilities: { write: true },
    write: { paths: ["docs/**"], scope: { pages: ["/guide/"] } },
  });

  const inside = await editTransactionCommand({
    siteRoot: root,
    transaction: transactionFile(root, "docs/guide.md", ["/guide/"]),
    access,
  });
  assert.equal(inside.applied, true);
  assert.equal(readFileSync(join(root, "docs/guide.md"), "utf8"), "new\n");

  await assert.rejects(
    editTransactionCommand({
      siteRoot: root,
      transaction: transactionFile(root, "other/guide.md", ["/guide/"]),
      access,
    }),
    (error: unknown) => error instanceof EditTransactionError && error.code === "edit.transaction-scope",
  );
  assert.equal(readFileSync(join(root, "other/guide.md"), "utf8"), "old\n");

  await assert.rejects(
    editTransactionCommand({
      siteRoot: root,
      transaction: transactionFile(root, "docs/guide.md", ["/private/"]),
      access,
    }),
    (error: unknown) => error instanceof EditTransactionError && error.code === "edit.transaction-scope",
  );
});
