import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import {
  applyEditTransaction,
  EditTransactionError,
  parseEditTransaction,
  readEditTransaction,
  rebaseEditTransaction,
  rollbackEditTransaction,
  transactionIdOf,
} from "../src/edits/edit-transaction.ts";
import { releaseIntents, reserveIntents } from "../src/edits/intent-lock.ts";
import { hashSource, type Patch } from "../src/edits/patch.ts";
import type { EditTransaction, EditTransactionInvariant } from "../src/contracts/edit-transaction.ts";

/** A temporary folder holding `files`, removed by the caller. */
function tree(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "edits-transaction-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** Every path under `root` with its bytes, for an exact residue check. */
function snapshot(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const walk = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      const key = relative(root, path).split("\\").join("/");
      if (entry.isDirectory()) {
        entries[`${key}/`] = "dir";
        walk(path);
      } else if (entry.isSymbolicLink()) {
        entries[key] = "link";
      } else {
        entries[key] = readFileSync(path, "utf8");
      }
    }
  };
  walk(root);
  return entries;
}

/** A patch from `expected` to `replacement` at one 1-based span. */
function patch(
  line: number,
  column: number,
  endLine: number,
  endColumn: number,
  expected: string,
  replacement: string,
  source: string,
): Patch {
  return {
    span: { line, column, endLine, endColumn },
    expected,
    replacement,
    beforeHash: hashSource(source),
  };
}

/** A parsed transaction for the files currently on disk, with one patch per entry. */
function transactionFor(
  root: string,
  entries: readonly { readonly file: string; readonly patches: readonly Patch[] }[],
  extra: {
    readonly scope?: EditTransaction["scope"];
    readonly invariants?: readonly EditTransactionInvariant[];
    readonly task?: string;
    readonly requireBeforeHash?: boolean;
    readonly validateContent?: boolean;
  } = {},
): EditTransaction {
  const snapshotFiles: Record<string, string> = {};
  for (const entry of entries) snapshotFiles[entry.file] = hashSource(readFileSync(join(root, entry.file), "utf8"));
  const parsed = parseEditTransaction({
    version: 1,
    task: { id: extra.task ?? "task-one" },
    snapshot: { files: snapshotFiles },
    patches: entries.map((entry) => ({ file: entry.file, patches: entry.patches })),
    ...(extra.invariants === undefined ? {} : { invariants: extra.invariants }),
    ...(extra.scope === undefined ? {} : { scope: extra.scope }),
    preconditions: {
      ...(extra.requireBeforeHash === undefined ? {} : { requireBeforeHash: extra.requireBeforeHash }),
      ...(extra.validateContent === undefined ? {} : { validateContent: extra.validateContent }),
    },
  });
  assert.deepEqual(parsed.problems, []);
  assert.ok(parsed.transaction);
  return parsed.transaction;
}

/** Applies a transaction with records beside it and returns its result. */
async function apply(root: string, transaction: EditTransaction, hooks?: Parameters<typeof applyEditTransaction>[0]["transactionHooks"]) {
  return applyEditTransaction({
    siteRoot: root,
    transaction,
    receipt: join(root, "tx.receipt.json"),
    audit: join(root, "tx.audit.jsonl"),
    ...(hooks === undefined ? {} : { transactionHooks: hooks }),
  });
}

/** The files a transaction result names. */
function files(result: { readonly files: readonly { readonly file: string }[] }): string[] {
  return result.files.map((file) => file.file);
}

test("a versioned transaction parses deterministically and refuses malformed patches", () => {
  const valid = {
    version: 1,
    task: { id: "task-one", requestId: "request-one", goal: "Fix the heading" },
    snapshot: { files: { "docs/a.md": "a".repeat(64) } },
    patches: [
      {
        file: "docs/a.md",
        patches: [{ span: { line: 1, column: 1, endLine: 1, endColumn: 1 }, expected: "#", replacement: "##", beforeHash: "a".repeat(64) }],
      },
    ],
    invariants: [{ id: "url", kind: "contains", file: "docs/a.md", text: "/install/" }],
    preconditions: { requireBeforeHash: true, validateContent: true, commit: "0123456" },
    scope: { files: ["docs/a.md"], blocks: ["install"] },
  };
  const first = parseEditTransaction(valid);
  const second = parseEditTransaction(JSON.parse(JSON.stringify(valid)) as unknown);
  assert.deepEqual(first.problems, []);
  assert.deepEqual(second.problems, []);
  assert.ok(first.transaction);
  assert.ok(second.transaction);
  assert.equal(first.transaction.id, second.transaction.id);
  assert.equal(first.transaction.id, transactionIdOf(first.transaction));
  assert.equal(first.transaction.snapshot.id, first.transaction.snapshot.id);
  assert.equal(first.transaction.preconditions.requireBeforeHash, true);
  assert.equal(first.transaction.preconditions.validateContent, true);

  const invalid = parseEditTransaction({
    version: 2,
    task: {},
    snapshot: { files: { "../outside.md": "not-a-hash" } },
    patches: [
      {
        file: "docs/a.md",
        patches: [
          { span: { line: 0, column: 1, endLine: 1, endColumn: 1 }, replacement: "x" },
          { span: { line: 1, column: 1, endLine: 1, endColumn: 1 }, replacement: "y", beforeHash: "short" },
        ],
      },
      { file: "docs/a.md", patches: [] },
    ],
    invariants: [{ id: "a", kind: "contains", file: "docs/a.md" }],
  });
  const codes = invalid.problems.map((problem) => problem.code);
  assert.ok(codes.includes("transaction.version"));
  assert.ok(codes.includes("transaction.invalid-task"));
  assert.ok(codes.includes("transaction.invalid-file"));
  assert.ok(codes.includes("transaction.invalid-hash"));
  assert.ok(codes.includes("transaction.invalid-span"));
  assert.ok(codes.includes("transaction.duplicate-file"));
  assert.ok(codes.includes("transaction.invalid-invariant"));

  const missingSnapshot = parseEditTransaction({
    version: 1,
    task: { id: "task" },
    patches: [{ file: "docs/a.md", patches: [{ span: { line: 1, column: 1, endLine: 1, endColumn: 1 }, replacement: "x" }] }],
  });
  assert.ok(missingSnapshot.problems.some((problem) => problem.code === "transaction.invalid-snapshot"));
});

test("invalid patches are rejected before a write", async () => {
  const source = "# Old\n";
  const root = tree({ "docs/a.md": source });
  const badFile = join(root, "bad.json");
  writeFileSync(
    badFile,
    JSON.stringify({
      version: 1,
      task: { id: "task" },
      snapshot: { files: { "docs/a.md": hashSource(source) } },
      patches: [
        {
          file: "docs/a.md",
          patches: [{ span: { line: 1, column: 1, endLine: 1, endColumn: 1 }, replacement: "x", beforeHash: "not-a-hash" }],
        },
      ],
    }),
  );
  const before = snapshot(root);
  try {
    await assert.rejects(readEditTransaction(badFile), (error: unknown) => {
      assert.ok(error instanceof EditTransactionError);
      assert.equal(error.code, "edit.transaction-invalid");
      return true;
    });
    assert.deepEqual(snapshot(root), before, "the invalid document changed nothing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("several patches to one file are applied together and overlapping spans are refused first", async () => {
  const source = "# A\n\nBody\n";
  const root = tree({ "docs/a.md": source });
  try {
    const transaction = transactionFor(root, [
      {
        file: "docs/a.md",
        patches: [patch(1, 3, 1, 3, "A", "B", source), patch(3, 1, 3, 4, "Body", "Text", source)],
      },
    ]);
    const result = await apply(root, transaction);
    assert.equal(readFileSync(join(root, "docs/a.md"), "utf8"), "# B\n\nText\n");
    assert.deepEqual(files(result), ["docs/a.md"]);
    assert.equal(result.files[0]?.spans.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const overlapping = tree({ "docs/a.md": source });
  const exact = snapshot(overlapping);
  try {
    const transaction = transactionFor(overlapping, [
      {
        file: "docs/a.md",
        patches: [patch(1, 1, 1, 3, "# A", "###", source), patch(1, 1, 1, 2, "# ", "## ", source)],
      },
    ]);
    await assert.rejects(apply(overlapping, transaction), (error: unknown) => {
      assert.ok(error instanceof EditTransactionError);
      assert.equal(error.code, "edit.transaction-conflict");
      assert.equal(error.conflicts[0]?.kind, "span-overlap");
      assert.equal(error.conflicts[0]?.spans?.length, 2);
      return true;
    });
    assert.deepEqual(snapshot(overlapping), exact, "an overlap leaves every byte alone");
  } finally {
    rmSync(overlapping, { recursive: true, force: true });
  }
});

test("a final-file failure leaves every earlier file and record untouched", async () => {
  const root = tree({ "docs/a.md": "# A\n", "docs/b.md": "# B\n" });
  const before = snapshot(root);
  try {
    const transaction = transactionFor(root, [
      { file: "docs/a.md", patches: [patch(1, 3, 1, 3, "A", "AA", "# A\n")] },
      { file: "docs/b.md", patches: [patch(1, 3, 1, 3, "B", "BB", "# B\n")] },
    ]);
    await assert.rejects(
      apply(root, transaction, {
        beforeRename: (index) => {
          if (index === 1) throw new Error("injected second source failure");
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof EditTransactionError);
        assert.equal(error.code, "edit.transaction-write-failed");
        assert.match(error.message, /restored|nothing was written/);
        return true;
      },
    );
    assert.deepEqual(snapshot(root), before, "the first source was restored; no proof, ledger, or receipt survived");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a receipt failure after every source was committed rolls the sources back", async () => {
  const root = tree({ "docs/a.md": "# A\n", "docs/b.md": "# B\n" });
  const before = snapshot(root);
  try {
    const transaction = transactionFor(root, [
      { file: "docs/a.md", patches: [patch(1, 3, 1, 3, "A", "AA", "# A\n")] },
      { file: "docs/b.md", patches: [patch(1, 3, 1, 3, "B", "BB", "# B\n")] },
    ]);
    // Two sources, then proof, ledger, receipt; the receipt is the last artifact.
    await assert.rejects(
      apply(root, transaction, {
        beforeRename: (index) => {
          if (index === 4) throw new Error("injected receipt failure");
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof EditTransactionError);
        assert.equal(error.code, "edit.transaction-write-failed");
        return true;
      },
    );
    assert.deepEqual(snapshot(root), before, "activation is all or nothing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("snapshot and beforeHash mismatches stop apply and keep the old version", async () => {
  const source = "# Old\n";
  const root = tree({ "docs/a.md": source });
  const before = snapshot(root);
  try {
    const transaction = transactionFor(root, [
      { file: "docs/a.md", patches: [patch(1, 3, 1, 5, "Old", "New", source)] },
    ]);
    writeFileSync(join(root, "docs/a.md"), "# Changed\n");
    const changed = snapshot(root);
    await assert.rejects(apply(root, transaction), (error: unknown) => {
      assert.ok(error instanceof EditTransactionError);
      assert.equal(error.conflicts[0]?.kind, "stale-snapshot");
      assert.ok(error.conflicts[0]?.options.includes("rebase"));
      return true;
    });
    assert.deepEqual(snapshot(root), changed);

    const second = transactionFor(root, [
      { file: "docs/a.md", patches: [patch(1, 3, 1, 7, "Changed", "New", "# Changed\n")] },
    ]);
    const wrongHash = {
      ...second,
      patches: second.patches.map((entry) => ({
        ...entry,
        patches: entry.patches.map((item) => ({ ...item, beforeHash: "0".repeat(64) })),
      })),
    };
    await assert.rejects(apply(root, wrongHash), (error: unknown) => {
      assert.ok(error instanceof EditTransactionError);
      assert.equal(error.conflicts[0]?.kind, "stale-file");
      return true;
    });
    assert.deepEqual(snapshot(root), changed);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the first transaction wins by hash and the stale second is refused", async () => {
  const source = "# Old\n";
  const root = tree({ "docs/a.md": source });
  try {
    const first = transactionFor(root, [
      { file: "docs/a.md", patches: [patch(1, 3, 1, 5, "Old", "First", source)] },
    ]);
    const second = transactionFor(root, [
      { file: "docs/a.md", patches: [patch(1, 3, 1, 5, "Old", "Second", source)] },
    ]);
    await apply(root, first);
    const afterFirst = readFileSync(join(root, "docs/a.md"), "utf8");
    assert.equal(afterFirst, "# First\n");
    await assert.rejects(apply(root, second), (error: unknown) => {
      assert.ok(error instanceof EditTransactionError);
      assert.equal(error.conflicts[0]?.kind, "stale-snapshot");
      return true;
    });
    assert.equal(readFileSync(join(root, "docs/a.md"), "utf8"), afterFirst);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("intent reservations conflict only on the same semantic reference", async () => {
  const root = tree({ "docs/a.md": "# A\n", "docs/b.md": "# B\n" });
  try {
    const held = await reserveIntents({
      siteRoot: root,
      task: "other-task",
      intents: [{ kind: "block", value: "install" }],
    });
    try {
      await assert.rejects(
        reserveIntents({ siteRoot: root, task: "task-one", intents: [{ kind: "block", value: "install" }] }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /reserved by task other-task/);
          return true;
        },
      );
      const different = await reserveIntents({
        siteRoot: root,
        task: "task-one",
        intents: [
          { kind: "block", value: "deploy" },
          { kind: "page", value: "/docs/" },
        ],
      });
      await releaseIntents(root, different);
    } finally {
      await releaseIntents(root, held);
    }
    const again = await reserveIntents({
      siteRoot: root,
      task: "task-one",
      intents: [{ kind: "block", value: "install" }],
    });
    await releaseIntents(root, again);
    assert.equal(existsSync(join(root, ".mizzen")), false, "released reservations leave no folder");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a transaction refuses an intent held by another task and names both tasks", async () => {
  const source = "# Old\n";
  const root = tree({ "docs/a.md": source });
  const secret = "TOKEN=super-secret-value";
  try {
    const transaction = transactionFor(
      root,
      [{ file: "docs/a.md", patches: [patch(1, 3, 1, 5, "Old", secret, source)] }],
      { scope: { pages: [], blocks: ["install"], symbols: [], records: [], files: [] } },
    );
    const held = await reserveIntents({
      siteRoot: root,
      task: "other-task",
      intents: [{ kind: "block", value: "install" }],
    });
    try {
      await assert.rejects(apply(root, transaction), (error: unknown) => {
        assert.ok(error instanceof EditTransactionError);
        assert.equal(error.code, "edit.transaction-conflict");
        assert.equal(error.conflicts[0]?.kind, "intent-lock");
        assert.equal(error.conflicts[0]?.otherTask, "other-task");
        assert.ok(error.conflicts[0]?.options.includes("rebase"));
        assert.ok(error.conflicts[0]?.options.includes("approve"));
        assert.equal(JSON.stringify(error.conflicts).includes("super-secret-value"), false);
        return true;
      });
      assert.equal(readFileSync(join(root, "docs/a.md"), "utf8"), source);
    } finally {
      await releaseIntents(root, held);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scope and real-path boundaries refuse a file outside the task or the site", async () => {
  const parent = tree({ "outside.md": "# Old\n", "site/docs/a.md": "# Old\n", "site/docs/b.md": "# Old\n" });
  const site = join(parent, "site");
  const before = snapshot(parent);
  try {
    const outsideScope = transactionFor(
      site,
      [{ file: "docs/b.md", patches: [patch(1, 3, 1, 5, "Old", "New", "# Old\n")] }],
      { scope: { pages: [], blocks: [], symbols: [], records: [], files: ["docs/a.md"] } },
    );
    await assert.rejects(apply(site, outsideScope), (error: unknown) => {
      assert.ok(error instanceof EditTransactionError);
      assert.equal(error.code, "edit.transaction-scope");
      assert.equal(error.conflicts[0]?.kind, "scope");
      return true;
    });

    symlinkSync(join(parent, "outside.md"), join(site, "docs", "link.md"));
    const linkSource = "# Old\n";
    const linked = transactionFor(site, [
      { file: "docs/link.md", patches: [patch(1, 3, 1, 5, "Old", "New", linkSource)] },
    ]);
    await assert.rejects(apply(site, linked), (error: unknown) => {
      assert.ok(error instanceof EditTransactionError);
      assert.equal(error.code, "edit.transaction-boundary");
      assert.match(error.message, /symbolic link/);
      return true;
    });
    assert.equal(readFileSync(join(parent, "outside.md"), "utf8"), "# Old\n");
    assert.equal(readFileSync(join(site, "docs", "a.md"), "utf8"), "# Old\n");
    assert.equal(readFileSync(join(site, "docs", "b.md"), "utf8"), "# Old\n");
    assert.equal(existsSync(join(site, "tx.receipt.json")), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("custom invariants run after patching and a violation rolls the transaction back", async () => {
  const source = "# Old\n\n/old-url/\n";
  const root = tree({ "docs/a.md": source });
  const before = snapshot(root);
  try {
    const good = transactionFor(
      root,
      [{ file: "docs/a.md", patches: [patch(1, 3, 1, 5, "Old", "New", source)] }],
      {
        invariants: [
          { id: "url", kind: "unchanged", file: "docs/a.md", text: "/old-url/" },
          { id: "body", kind: "contains", file: "docs/a.md", text: "New" },
        ],
      },
    );
    await apply(root, good);
    assert.match(readFileSync(join(root, "docs/a.md"), "utf8"), /\/old-url\//);

    const bad = tree({ "docs/a.md": source });
    const badBefore = snapshot(bad);
    try {
      const transaction = transactionFor(
        bad,
        [{ file: "docs/a.md", patches: [patch(1, 3, 1, 5, "Old", "New", source)] }],
        {
          invariants: [
            { id: "url", kind: "unchanged", file: "docs/a.md", text: "/missing-url/" },
            { id: "secret", kind: "absent", file: "docs/a.md", text: "Old" },
          ],
        },
      );
      await assert.rejects(
        applyEditTransaction({
          siteRoot: bad,
          transaction,
          receipt: join(bad, "tx.receipt.json"),
          audit: join(bad, "tx.audit.jsonl"),
        }),
        (error: unknown) => {
          assert.ok(error instanceof EditTransactionError);
          assert.equal(error.code, "edit.transaction-check-failed");
          assert.ok(error.checks.some((check) => check.id === "url" && check.status === "failed"));
          return true;
        },
      );
      assert.deepEqual(snapshot(bad), badBefore);
    } finally {
      rmSync(bad, { recursive: true, force: true });
    }

    const custom = tree({ "docs/a.md": source });
    try {
      const transaction = transactionFor(custom, [
        { file: "docs/a.md", patches: [patch(1, 3, 1, 5, "Old", "New", source)] },
      ]);
      await assert.rejects(
        applyEditTransaction({
          siteRoot: custom,
          transaction,
          receipt: join(custom, "tx.receipt.json"),
          audit: join(custom, "tx.audit.jsonl"),
          customInvariants: [{ id: "custom", check: () => "the custom rule failed" }],
        }),
        (error: unknown) => {
          assert.ok(error instanceof EditTransactionError);
          assert.equal(error.code, "edit.transaction-check-failed");
          assert.ok(error.checks.some((check) => check.id === "custom" && check.status === "failed"));
          return true;
        },
      );
      assert.equal(readFileSync(join(custom, "docs/a.md"), "utf8"), source);
    } finally {
      rmSync(custom, { recursive: true, force: true });
    }
    assert.notDeepEqual(snapshot(root), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("JSON data invariants check values and schemas before activation", async () => {
  const source = '{"name": "old", "count": 1}\n';
  const root = tree({ "data/site.json": source });
  try {
    const transaction = transactionFor(
      root,
      [{ file: "data/site.json", patches: [patch(1, 11, 1, 13, "old", "new", source)] }],
      {
        invariants: [
          { id: "name", kind: "json-equals", file: "data/site.json", pointer: "/name", value: "new" },
          { id: "shape", kind: "json-schema", file: "data/site.json", schema: { type: "object", properties: { name: { type: "string" }, count: { type: "number" } }, required: ["name", "count"] } },
        ],
      },
    );
    const result = await apply(root, transaction);
    assert.equal(readFileSync(join(root, "data/site.json"), "utf8"), '{"name": "new", "count": 1}\n');
    assert.deepEqual(result.files.map((file) => file.file), ["data/site.json"]);

    const bad = tree({ "data/site.json": source });
    try {
      const failing = transactionFor(
        bad,
        [{ file: "data/site.json", patches: [patch(1, 11, 1, 13, "old", "new", source)] }],
        {
          invariants: [
            { id: "shape", kind: "json-schema", file: "data/site.json", schema: { type: "object", properties: { missing: { type: "string" } }, required: ["missing"] } },
          ],
        },
      );
      await assert.rejects(apply(bad, failing), (error: unknown) => {
        assert.ok(error instanceof EditTransactionError);
        assert.equal(error.code, "edit.transaction-check-failed");
        assert.ok(error.checks.some((check) => check.id === "shape" && check.status === "failed"));
        return true;
      });
      assert.equal(readFileSync(join(bad, "data/site.json"), "utf8"), source);
    } finally {
      rmSync(bad, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unparseable front matter or JSON never becomes active", async () => {
  const markdown = "---\ntitle: ok\n---\n# A\n";
  const root = tree({ "docs/a.md": markdown });
  const before = snapshot(root);
  try {
    const transaction = transactionFor(root, [
      { file: "docs/a.md", patches: [patch(3, 1, 3, 3, "---", "oops", markdown)] },
    ]);
    await assert.rejects(apply(root, transaction), (error: unknown) => {
      assert.ok(error instanceof EditTransactionError);
      assert.equal(error.code, "edit.transaction-check-failed");
      assert.ok(error.checks.some((check) => check.id === "content:docs/a.md" && check.status === "failed"));
      assert.match(error.message, /front matter|Front matter|unclosed/i);
      return true;
    });
    assert.deepEqual(snapshot(root), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const json = tree({ "data/site.json": '{"a": 1}\n' });
  const jsonBefore = snapshot(json);
  try {
    const transaction = transactionFor(json, [
      { file: "data/site.json", patches: [patch(1, 7, 1, 7, "1", "}", '{"a": 1}\n')] },
    ]);
    await assert.rejects(apply(json, transaction), (error: unknown) => {
      assert.ok(error instanceof EditTransactionError);
      assert.equal(error.code, "edit.transaction-check-failed");
      return true;
    });
    assert.deepEqual(snapshot(json), jsonBefore);
  } finally {
    rmSync(json, { recursive: true, force: true });
  }
});

test("a dry run prints one aggregate diff and writes no lock, record, or file", async () => {
  const root = tree({ "docs/a.md": "# Old A\n", "docs/b.md": "# Old B\n" });
  const before = snapshot(root);
  try {
    const transaction = transactionFor(
      root,
      [
        { file: "docs/a.md", patches: [patch(1, 3, 1, 7, "Old A", "New A", "# Old A\n")] },
        { file: "docs/b.md", patches: [patch(1, 3, 1, 7, "Old B", "New B", "# Old B\n")] },
      ],
      { scope: { pages: [], blocks: ["install"], symbols: [], records: [], files: [] } },
    );
    const result = await applyEditTransaction({
      siteRoot: root,
      transaction,
      receipt: join(root, "tx.receipt.json"),
      audit: join(root, "tx.audit.jsonl"),
      dryRun: true,
    });
    assert.equal(result.dryRun, true);
    assert.equal(result.applied, false);
    assert.match(result.diff ?? "", /^--- a\/docs\/a\.md$/m);
    assert.match(result.diff ?? "", /^--- a\/docs\/b\.md$/m);
    assert.ok(result.checks.some((check) => check.id === "content:docs/a.md" && check.status === "passed"));
    assert.deepEqual(snapshot(root), before, "no source, record, lock, or staging residue");
    assert.equal(existsSync(join(root, ".mizzen")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a low-confidence rebase previews the move and needs approval before applying", async () => {
  const source = "# Old\n\nBody\n";
  const root = tree({ "docs/a.md": source });
  try {
    const transaction = transactionFor(root, [
      { file: "docs/a.md", patches: [patch(1, 3, 1, 5, "Old", "New", source)] },
    ]);
    writeFileSync(join(root, "docs/a.md"), "Intro\n\n# Old\n\nBody\n");
    const exact = await rebaseEditTransaction({ siteRoot: root, transaction, approve: true });
    assert.equal(exact.confidence, "low");
    assert.equal(exact.moves.length, 1);
    assert.equal(exact.moves[0]?.to.line, 3);
    assert.match(exact.diff, /^\+# New$/m);

    await assert.rejects(
      rebaseEditTransaction({ siteRoot: root, transaction, approve: false }),
      (error: unknown) => {
        assert.ok(error instanceof EditTransactionError);
        assert.equal(error.code, "edit.transaction-approval-required");
        assert.ok(error.conflicts[0]?.options.includes("approve"));
        return true;
      },
    );
    assert.match(readFileSync(join(root, "docs/a.md"), "utf8"), /^Intro\n\n# Old\n/);

    await applyEditTransaction({
      siteRoot: root,
      transaction: exact.transaction,
      receipt: join(root, "tx.receipt.json"),
      audit: join(root, "tx.audit.jsonl"),
    });
    assert.equal(readFileSync(join(root, "docs/a.md"), "utf8"), "Intro\n\n# New\n\nBody\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rollback restores this transaction's files and preserves a later independent edit", async () => {
  const root = tree({ "docs/a.md": "# A\n", "docs/b.md": "# B\n" });
  try {
    const transaction = transactionFor(root, [
      { file: "docs/a.md", patches: [patch(1, 3, 1, 3, "A", "AA", "# A\n")] },
      { file: "docs/b.md", patches: [patch(1, 3, 1, 3, "B", "BB", "# B\n")] },
    ]);
    await apply(root, transaction);
    assert.equal(readFileSync(join(root, "docs/a.md"), "utf8"), "# AA\n");
    assert.equal(readFileSync(join(root, "docs/b.md"), "utf8"), "# BB\n");
    writeFileSync(join(root, "docs/b.md"), "# independent\n");

    const result = await rollbackEditTransaction({
      siteRoot: root,
      receipt: join(root, "tx.receipt.json"),
    });
    assert.deepEqual(result.restored, ["docs/a.md"]);
    assert.deepEqual(result.preserved, ["docs/b.md"]);
    assert.equal(readFileSync(join(root, "docs/a.md"), "utf8"), "# A\n");
    assert.equal(readFileSync(join(root, "docs/b.md"), "utf8"), "# independent\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a successful transaction links the proof, audit lines, and receipt only after the sources", async () => {
  const root = tree({ "docs/a.md": "# A\n", "docs/b.md": "# B\n" });
  try {
    const transaction = transactionFor(root, [
      { file: "docs/a.md", patches: [patch(1, 3, 1, 3, "A", "AA", "# A\n")] },
      { file: "docs/b.md", patches: [patch(1, 3, 1, 3, "B", "BB", "# B\n")] },
    ]);
    const result = await apply(root, transaction);
    assert.equal(result.applied, true);
    assert.equal(result.receipt, "tx.receipt.json");
    assert.equal(result.audit?.length, 2);
    const proof = JSON.parse(readFileSync(join(root, "tx.receipt.json.proof.json"), "utf8")) as {
      files: { path: string; before: string; after: string }[];
    };
    assert.deepEqual(proof.files.map((file) => file.path), ["docs/a.md", "docs/b.md"]);
    assert.equal(proof.files[0]?.after, hashSource("# AA\n"));
    const receipt = JSON.parse(readFileSync(join(root, "tx.receipt.json"), "utf8")) as {
      id: string;
      files: { file: string; before: string }[];
      audit: string[];
    };
    assert.equal(receipt.id, transaction.id);
    assert.equal(receipt.files[0]?.before, "# A\n");
    assert.deepEqual(receipt.audit, result.audit);
    const lines = readFileSync(join(root, "tx.audit.jsonl"), "utf8").split("\n").filter((line) => line !== "");
    assert.equal(lines.length, 2);
    assert.deepEqual(
      lines.map((line) => (JSON.parse(line) as { id: string }).id),
      result.audit,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the receipt is self-contained and refuses a damaged before hash", async () => {
  const root = tree({ "docs/a.md": "# A\n" });
  try {
    const transaction = transactionFor(root, [
      { file: "docs/a.md", patches: [patch(1, 3, 1, 3, "A", "AA", "# A\n")] },
    ]);
    await apply(root, transaction);
    const receiptPath = join(root, "tx.receipt.json");
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as { files: { before: string }[] };
    receipt.files[0]!.before = "# changed\n";
    writeFileSync(receiptPath, JSON.stringify(receipt));
    await assert.rejects(rollbackEditTransaction({ siteRoot: root, receipt: receiptPath }), (error: unknown) => {
      assert.ok(error instanceof EditTransactionError);
      assert.equal(error.code, "edit.rollback-invalid");
      return true;
    });
    assert.equal(readFileSync(join(root, "docs/a.md"), "utf8"), "# AA\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an exact rebase keeps the transaction id distinct and reports no moves", async () => {
  const source = "# Old\n";
  const root = tree({ "docs/a.md": source });
  try {
    const transaction = transactionFor(root, [
      { file: "docs/a.md", patches: [patch(1, 3, 1, 5, "Old", "New", source)] },
    ]);
    const rebased = await rebaseEditTransaction({ siteRoot: root, transaction, approve: false });
    assert.equal(rebased.confidence, "exact");
    assert.deepEqual(rebased.moves, []);
    assert.equal(rebased.transaction.snapshot.files["docs/a.md"], hashSource(source));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
