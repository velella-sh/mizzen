import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EditTransaction, EditTransactionInvariant } from "../src/contracts/edit-transaction.ts";
import {
  applyEditTransaction,
  EditTransactionError,
  parseEditTransaction,
  readEditReceipt,
  readEditTransaction,
  rebaseEditTransaction,
  rollbackEditTransaction,
  transactionIdOf,
  transactionSnapshotId,
} from "../src/edits/edit-transaction.ts";
import { hashSource, type Patch } from "../src/edits/patch.ts";

/** A temporary folder holding `files`, removed by the caller. */
function tree(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "edits-transaction-coverage-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
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

/** A parsed transaction for the files currently on disk. */
function transactionFor(
  root: string,
  entries: readonly { readonly file: string; readonly patches: readonly Patch[] }[],
  extra: {
    readonly invariants?: readonly EditTransactionInvariant[];
    readonly validateContent?: boolean;
    readonly requireBeforeHash?: boolean;
  } = {},
): EditTransaction {
  const snapshotFiles: Record<string, string> = {};
  for (const entry of entries) snapshotFiles[entry.file] = hashSource(readFileSync(join(root, entry.file), "utf8"));
  const parsed = parseEditTransaction({
    version: 1,
    task: { id: "task-one" },
    snapshot: { files: snapshotFiles },
    patches: entries.map((entry) => ({ file: entry.file, patches: entry.patches })),
    ...(extra.invariants === undefined ? {} : { invariants: extra.invariants }),
    preconditions: {
      ...(extra.validateContent === undefined ? {} : { validateContent: extra.validateContent }),
      ...(extra.requireBeforeHash === undefined ? {} : { requireBeforeHash: extra.requireBeforeHash }),
    },
  });
  assert.deepEqual(parsed.problems, []);
  assert.ok(parsed.transaction);
  return parsed.transaction;
}

/** A transaction built without the parser, to exercise the writer's own boundary checks. */
function rawTransaction(
  entries: EditTransaction["patches"],
  extra: Partial<Omit<EditTransaction, "id">> = {},
): EditTransaction {
  const base = {
    version: 1 as const,
    task: { id: "task-one" },
    snapshot: { files: {}, id: transactionSnapshotId({}) },
    patches: entries,
    invariants: [],
    preconditions: { requireBeforeHash: true, validateContent: true },
    scope: { pages: [], blocks: [], symbols: [], records: [], files: [] },
    ...extra,
  };
  return { ...base, id: transactionIdOf(base) } as EditTransaction;
}

/** Applies a transaction with its receipt and audit beside it. */
async function apply(root: string, transaction: EditTransaction, extra: Record<string, unknown> = {}) {
  return applyEditTransaction({
    siteRoot: root,
    transaction,
    receipt: join(root, "tx.receipt.json"),
    audit: join(root, "tx.audit.jsonl"),
    ...extra,
  });
}

test("the transaction parser reports every malformed field at once", () => {
  const valid = {
    version: 1,
    task: { id: "task-one" },
    snapshot: { files: { "docs/a.md": "a".repeat(64) } },
    patches: [
      {
        file: "docs/a.md",
        patches: [{ span: { line: 1, column: 1, endLine: 1, endColumn: 1 }, replacement: "x" }],
      },
    ],
  };
  const codes = (value: unknown): string[] => parseEditTransaction(value).problems.map((problem) => problem.code);
  const withPatch = (entry: Record<string, unknown>): unknown => ({
    ...valid,
    patches: [{ file: "docs/a.md", patches: [{ ...valid.patches[0]!.patches[0], ...entry }] }],
  });
  const cases: unknown[] = [
    null,
    [],
    "transaction",
    { ...valid, task: { id: "task-one", requestId: "" } },
    { ...valid, task: { id: "task-one", goal: 7 } },
    { ...valid, snapshot: { files: { "docs/a.md": "zzz" } } },
    { ...valid, patches: [] },
    { ...valid, patches: [null] },
    { ...valid, patches: [{ file: "../a.md", patches: [] }] },
    { ...valid, patches: [{ file: "docs/a.md", patches: [] }] },
    withPatch({ replacement: 7 }),
    withPatch({ expected: 7 }),
    withPatch({ span: { line: 0, column: 1, endLine: 1, endColumn: 1 } }),
    withPatch({ span: { line: 1, column: 1, endLine: 1, endColumn: 1, file: "../x" } }),
    withPatch({ span: { line: 1, column: 1, endLine: 1, endColumn: 1, file: "docs/b.md" } }),
    { ...valid, invariants: {} },
    { ...valid, invariants: [{ id: "", kind: "contains", file: "docs/a.md", text: "x" }] },
    { ...valid, invariants: [{ id: "x", kind: "contains", file: "../a.md", text: "x" }] },
    { ...valid, invariants: [{ id: "x", kind: "json-equals", file: "docs/a.md", pointer: 7 }] },
    { ...valid, invariants: [{ id: "x", kind: "json-schema", file: "docs/a.md", schema: [] }] },
    { ...valid, invariants: [{ id: "x", kind: "unknown", file: "docs/a.md" }] },
    { ...valid, invariants: [{ id: "x", kind: "contains", file: "docs/a.md", text: "x" }, { id: "x", kind: "contains", file: "docs/a.md", text: "y" }] },
    { ...valid, preconditions: null },
    { ...valid, preconditions: { requireBeforeHash: "yes" } },
    { ...valid, preconditions: { commit: 7 } },
    { ...valid, scope: null },
    { ...valid, scope: { pages: [7, ""] } },
  ];
  assert.deepEqual(codes(valid), []);
  const expected = [
    "transaction.invalid",
    "transaction.invalid",
    "transaction.invalid",
    "transaction.invalid-task",
    "transaction.invalid-task",
    "transaction.invalid-hash",
    "transaction.invalid-patches",
    "transaction.invalid-patches",
    "transaction.invalid-file",
    "transaction.invalid-patches",
    "transaction.invalid-patch",
    "transaction.invalid-patch",
    "transaction.invalid-span",
    "transaction.invalid-file",
    "transaction.file-mismatch",
    "transaction.invalid-invariant",
    "transaction.invalid-invariant",
    "transaction.invalid-invariant",
    "transaction.invalid-invariant",
    "transaction.invalid-invariant",
    "transaction.invalid-invariant",
    "transaction.duplicate-invariant",
    "transaction.invalid-preconditions",
    "transaction.invalid-preconditions",
    "transaction.invalid-preconditions",
    "transaction.invalid-scope",
    "transaction.invalid-scope",
  ];
  assert.deepEqual(
    cases.map((value) => codes(value)[0]),
    expected,
  );
});

test("reading a transaction refuses a missing file and non-JSON text", async () => {
  const root = tree();
  try {
    await assert.rejects(readEditTransaction(join(root, "missing.json")), (error: unknown) => {
      assert.ok(error instanceof EditTransactionError);
      assert.equal(error.code, "edit.transaction-missing");
      assert.match(error.message, /does not exist/);
      return true;
    });
    writeFileSync(join(root, "bad.json"), "{nope");
    await assert.rejects(readEditTransaction(join(root, "bad.json")), (error: unknown) => {
      assert.ok(error instanceof EditTransactionError);
      assert.equal(error.code, "edit.transaction-invalid");
      assert.match(error.message, /not JSON/);
      return true;
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the writer refuses paths outside the root, missing parents, and symlinked parents", async () => {
  const root = tree({ "docs/a.md": "# A\n" });
  const outside = tree({ "a.md": "# outside\n" });
  try {
    await assert.rejects(
      apply(root, rawTransaction([{ file: "..", patches: [] }])),
      (error: unknown) => {
        assert.ok(error instanceof EditTransactionError);
        assert.equal(error.code, "edit.transaction-boundary");
        assert.equal(error.conflicts[0]?.kind, "boundary");
        return true;
      },
    );

    const missingRoot = join(root, "no-such-site");
    await assert.rejects(
      apply(missingRoot, rawTransaction([{ file: "docs/a.md", patches: [] }])),
      (error: unknown) => {
        assert.ok(error instanceof EditTransactionError);
        assert.equal(error.code, "edit.transaction-boundary");
        assert.match(error.message, /parent folder cannot be resolved/);
        return true;
      },
    );

    symlinkSync(outside, join(root, "linked"));
    await assert.rejects(
      apply(root, rawTransaction([{ file: "linked/a.md", patches: [] }])),
      (error: unknown) => {
        assert.ok(error instanceof EditTransactionError);
        assert.equal(error.code, "edit.transaction-boundary");
        assert.match(error.message, /resolves outside/);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a missing file, a missing snapshot hash, and a missing patch hash are distinct refusals", async () => {
  const source = "# Old\n";
  const root = tree({ "docs/a.md": source });
  try {
    await assert.rejects(
      apply(root, rawTransaction([{ file: "docs/missing.md", patches: [] }])),
      (error: unknown) => {
        assert.ok(error instanceof EditTransactionError);
        assert.equal(error.code, "edit.transaction-conflict");
        assert.match(error.message, /cannot be read/);
        return true;
      },
    );

    const noSnapshot = transactionFor(root, [
      { file: "docs/a.md", patches: [patch(1, 3, 1, 5, "Old", "New", source)] },
    ]);
    await assert.rejects(apply(root, { ...noSnapshot, snapshot: { files: {} } }), (error: unknown) => {
      assert.ok(error instanceof EditTransactionError);
      assert.match(error.message, /snapshot has no hash/);
      assert.equal(error.conflicts[0]?.kind, "stale-snapshot");
      return true;
    });

    const noHash = parseEditTransaction({
      version: 1,
      task: { id: "task-one" },
      snapshot: { files: { "docs/a.md": hashSource(source) } },
      patches: [
        {
          file: "docs/a.md",
          patches: [{ span: { line: 1, column: 3, endLine: 1, endColumn: 5 }, expected: "Old", replacement: "New" }],
        },
      ],
    });
    assert.ok(noHash.transaction);
    await assert.rejects(apply(root, noHash.transaction), (error: unknown) => {
      assert.ok(error instanceof EditTransactionError);
      assert.match(error.message, /no beforeHash/);
      assert.equal(error.conflicts[0]?.kind, "stale-file");
      return true;
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a file outside the transaction scope and a stale snapshot hash are scope conflicts", async () => {
  const source = "# Old\n";
  const root = tree({ "docs/a.md": source, "docs/b.md": "# B\n" });
  try {
    const transaction = transactionFor(root, [
      { file: "docs/a.md", patches: [patch(1, 3, 1, 5, "Old", "New", source)] },
    ]);
    await assert.rejects(
      apply(root, { ...transaction, scope: { pages: [], blocks: [], symbols: [], records: [], files: ["docs/b.md"] } }),
      (error: unknown) => {
        assert.ok(error instanceof EditTransactionError);
        assert.equal(error.code, "edit.transaction-scope");
        assert.equal(error.conflicts[0]?.kind, "scope");
        return true;
      },
    );

    await assert.rejects(
      apply(root, { ...transaction, snapshot: { files: { "docs/a.md": "a".repeat(64) } } }),
      (error: unknown) => {
        assert.ok(error instanceof EditTransactionError);
        assert.equal(error.code, "edit.transaction-conflict");
        assert.match(error.message, /snapshot expected/);
        assert.equal(error.conflicts[0]?.kind, "stale-snapshot");
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an out-of-range span is a conflict and leaves the file alone", async () => {
  const source = "# Old\n";
  const root = tree({ "docs/a.md": source });
  try {
    const transaction = rawTransaction(
      [{ file: "docs/a.md", patches: [patch(99, 1, 99, 2, "x", "y", source)] }],
      { snapshot: { files: { "docs/a.md": hashSource(source) } } },
    );
    await assert.rejects(apply(root, transaction), (error: unknown) => {
      assert.ok(error instanceof EditTransactionError);
      assert.equal(error.code, "edit.transaction-conflict");
      assert.equal(error.conflicts[0]?.kind, "stale-file");
      return true;
    });
    assert.equal(readFileSync(join(root, "docs/a.md"), "utf8"), source);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unwritable reservation folder fails before any planning", async () => {
  const source = "# Old\n";
  const root = tree({ "docs/a.md": source });
  try {
    writeFileSync(join(root, ".mizzen"), "not a directory");
    const transaction = transactionFor(root, [
      { file: "docs/a.md", patches: [patch(1, 3, 1, 5, "Old", "New", source)] },
    ]);
    const scoped = {
      ...transaction,
      scope: { pages: [], blocks: ["install"], symbols: [], records: [], files: [] },
    };
    await assert.rejects(apply(root, scoped), (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, "ENOTDIR");
      return true;
    });
    assert.equal(readFileSync(join(root, "docs/a.md"), "utf8"), source);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("YAML and JSON content checks and JSON invariants refuse only bad results", async () => {
  const yaml = "a: 1\n";
  const root = tree({ "config.yml": yaml });
  try {
    const broken = transactionFor(root, [
      { file: "config.yml", patches: [patch(1, 4, 1, 4, "1", "[", yaml)] },
    ]);
    await assert.rejects(apply(root, broken), (error: unknown) => {
      assert.ok(error instanceof EditTransactionError);
      assert.equal(error.code, "edit.transaction-check-failed");
      assert.ok(error.checks.some((check) => check.status === "failed" && /YAML/.test(check.message ?? "")));
      return true;
    });

    const fixed = transactionFor(root, [
      { file: "config.yml", patches: [patch(1, 4, 1, 4, "1", "2", yaml)] },
    ]);
    const result = await apply(root, fixed);
    assert.equal(result.applied, true);
    assert.equal(readFileSync(join(root, "config.yml"), "utf8"), "a: 2\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const json = '{"a": 1}\n';
  const data = tree({ "data/site.json": json });
  try {
    const unparsed = transactionFor(
      data,
      [{ file: "data/site.json", patches: [patch(1, 7, 1, 7, "1", "}", json)] }],
      {
        validateContent: false,
        invariants: [{ id: "parse", kind: "json-equals", file: "data/site.json", pointer: "", value: 1 }],
      },
    );
    await assert.rejects(apply(data, unparsed), (error: unknown) => {
      assert.ok(error instanceof EditTransactionError);
      assert.ok(error.checks.some((check) => check.id === "parse" && /cannot be parsed/.test(check.message ?? "")));
      return true;
    });

    const pointer = transactionFor(
      data,
      [{ file: "data/site.json", patches: [patch(1, 7, 1, 7, "1", "2", json)] }],
      {
        invariants: [
          { id: "missing", kind: "json-equals", file: "data/site.json", pointer: "/b", value: 2 },
          { id: "schema", kind: "json-schema", file: "data/site.json", schema: { type: "no-such-type" } },
        ],
      },
    );
    await assert.rejects(apply(data, pointer), (error: unknown) => {
      assert.ok(error instanceof EditTransactionError);
      assert.ok(error.checks.some((check) => check.id === "missing" && /pointer/.test(check.message ?? "")));
      return true;
    });

    const schema = transactionFor(
      data,
      [{ file: "data/site.json", patches: [patch(1, 7, 1, 7, "1", "2", json)] }],
      { invariants: [{ id: "schema", kind: "json-schema", file: "data/site.json", schema: { type: "no-such-type" } }] },
    );
    await assert.rejects(apply(data, schema), (error: unknown) => {
      assert.ok(error instanceof EditTransactionError);
      assert.ok(error.checks.some((check) => check.id === "schema" && /cannot be compiled/.test(check.message ?? "")));
      return true;
    });
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("a JSON pointer into an array and an unknown file kind are checked without guessing", async () => {
  const root = tree({ "data/list.json": '{"items": [1]}\n', "notes.txt": "old\n" });
  try {
    const array = transactionFor(
      root,
      [{ file: "data/list.json", patches: [patch(1, 12, 1, 12, "1", "2", '{"items": [1]}\n')] }],
      { invariants: [{ id: "array", kind: "json-equals", file: "data/list.json", pointer: "/items/9", value: 2 }] },
    );
    await assert.rejects(apply(root, array), (error: unknown) => {
      assert.ok(error instanceof EditTransactionError);
      assert.ok(error.checks.some((check) => check.id === "array" && /pointer/.test(check.message ?? "")));
      return true;
    });

    const text = transactionFor(root, [
      { file: "notes.txt", patches: [patch(1, 1, 1, 3, "old", "new", "old\n")] },
    ]);
    const result = await apply(root, text);
    assert.ok(result.checks.some((check) => check.id === "content:notes.txt" && check.status === "skipped"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an invariant over an unchanged file and a passing absent check are checked", async () => {
  const source = "# A\n";
  const root = tree({ "docs/a.md": source, "docs/b.md": "# B\n" });
  try {
    const unpatched = transactionFor(
      root,
      [{ file: "docs/a.md", patches: [patch(1, 3, 1, 3, "A", "AA", source)] }],
      { invariants: [{ id: "other", kind: "contains", file: "docs/b.md", text: "B" }] },
    );
    await assert.rejects(apply(root, unpatched), (error: unknown) => {
      assert.ok(error instanceof EditTransactionError);
      assert.ok(error.checks.some((check) => check.id === "other" && /does not change/.test(check.message ?? "")));
      return true;
    });

    const absent = transactionFor(
      root,
      [{ file: "docs/a.md", patches: [patch(1, 3, 1, 3, "A", "AA", source)] }],
      { invariants: [{ id: "secret", kind: "absent", file: "docs/a.md", text: "TOKEN" }] },
    );
    const result = await apply(root, absent);
    assert.ok(result.checks.some((check) => check.id === "secret" && check.status === "passed"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a custom invariant that throws is a failed check, not a crash", async () => {
  const source = "# A\n";
  const root = tree({ "docs/a.md": source });
  try {
    const transaction = transactionFor(root, [
      { file: "docs/a.md", patches: [patch(1, 3, 1, 3, "A", "AA", source)] },
    ]);
    await assert.rejects(
      apply(root, transaction, {
        customInvariants: [
          {
            id: "throws",
            check: () => {
              throw new Error("the custom rule exploded");
            },
          },
        ],
      }),
      (error: unknown) => {
        assert.ok(error instanceof EditTransactionError);
        assert.equal(error.code, "edit.transaction-check-failed");
        assert.match(error.message, /the custom rule exploded/);
        return true;
      },
    );
    assert.equal(readFileSync(join(root, "docs/a.md"), "utf8"), source);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the record date comes from SOURCE_DATE_EPOCH and is omitted when it is empty", async () => {
  const source = "# A\n";
  const epoch = process.env.SOURCE_DATE_EPOCH;
  try {
    process.env.SOURCE_DATE_EPOCH = "1700000000";
    const dated = tree({ "docs/a.md": source });
    try {
      const transaction = transactionFor(dated, [
        { file: "docs/a.md", patches: [patch(1, 3, 1, 3, "A", "AA", source)] },
      ]);
      await apply(dated, transaction);
      const receipt = JSON.parse(readFileSync(join(dated, "tx.receipt.json"), "utf8")) as { date?: string };
      assert.equal(receipt.date, new Date(1_700_000_000_000).toISOString());
    } finally {
      rmSync(dated, { recursive: true, force: true });
    }

    process.env.SOURCE_DATE_EPOCH = "not-a-number";
    const invalid = tree({ "docs/a.md": source });
    try {
      const transaction = transactionFor(invalid, [
        { file: "docs/a.md", patches: [patch(1, 3, 1, 3, "A", "AA", source)] },
      ]);
      await assert.rejects(apply(invalid, transaction), (error: unknown) => {
        assert.ok(error instanceof EditTransactionError);
        assert.equal(error.code, "edit.transaction-write-failed");
        assert.match(error.message, /proof cannot be built/);
        return true;
      });
    } finally {
      rmSync(invalid, { recursive: true, force: true });
    }

    process.env.SOURCE_DATE_EPOCH = "";
    const undated = tree({ "docs/a.md": source });
    try {
      const transaction = transactionFor(undated, [
        { file: "docs/a.md", patches: [patch(1, 3, 1, 3, "A", "AA", source)] },
      ]);
      await apply(undated, transaction);
      const receipt = JSON.parse(readFileSync(join(undated, "tx.receipt.json"), "utf8")) as { date?: string };
      assert.equal(receipt.date, undefined);
    } finally {
      rmSync(undated, { recursive: true, force: true });
    }
  } finally {
    if (epoch === undefined) delete process.env.SOURCE_DATE_EPOCH;
    else process.env.SOURCE_DATE_EPOCH = epoch;
  }
});

test("a damaged audit ledger and an unreadable receipt stop the transaction", async () => {
  const source = "# A\n";
  const root = tree({ "docs/a.md": source });
  try {
    const transaction = transactionFor(root, [
      { file: "docs/a.md", patches: [patch(1, 3, 1, 3, "A", "AA", source)] },
    ]);
    await assert.rejects(
      applyEditTransaction({ siteRoot: root, transaction, receipt: join(root, "tx.receipt.json"), audit: root }),
      (error: unknown) => {
        assert.ok(error instanceof EditTransactionError);
        assert.equal(error.code, "edit.transaction-write-failed");
        assert.match(error.message, /JSONL|ledger/i);
        return true;
      },
    );

    writeFileSync(join(root, "tx.audit.jsonl"), "no trailing newline");
    await assert.rejects(apply(root, transaction), (error: unknown) => {
      assert.ok(error instanceof EditTransactionError);
      assert.equal(error.code, "edit.transaction-write-failed");
      assert.match(error.message, /does not end with a line feed/);
      return true;
    });
    assert.equal(readFileSync(join(root, "docs/a.md"), "utf8"), source);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const receiptRoot = tree({ "docs/a.md": source });
  try {
    const transaction = transactionFor(receiptRoot, [
      { file: "docs/a.md", patches: [patch(1, 3, 1, 3, "A", "AA", source)] },
    ]);
    await assert.rejects(
      applyEditTransaction({ siteRoot: receiptRoot, transaction, receipt: receiptRoot, audit: join(receiptRoot, "tx.audit.jsonl") }),
      (error: unknown) => {
        assert.ok(error instanceof EditTransactionError);
        assert.equal(error.code, "edit.transaction-write-failed");
        assert.match(error.message, /receipt cannot be read/);
        return true;
      },
    );
  } finally {
    rmSync(receiptRoot, { recursive: true, force: true });
  }
});

test("a file that changes while staged refuses the whole commit", async () => {
  const source = "# A\n";
  const root = tree({ "docs/a.md": source });
  try {
    const transaction = transactionFor(root, [
      { file: "docs/a.md", patches: [patch(1, 3, 1, 3, "A", "AA", source)] },
    ]);
    await assert.rejects(
      apply(root, transaction, {
        transactionHooks: {
          beforeCommit: () => writeFileSync(join(root, "docs/a.md"), "# someone else\n"),
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof EditTransactionError);
        assert.equal(error.code, "edit.transaction-conflict");
        assert.equal(error.conflicts[0]?.kind, "stale-file");
        assert.match(error.message, /changed before it could be written/);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a rebase reports a missing file, a vanished text, and an ambiguous text", async () => {
  const source = "# Old\n";
  const root = tree({ "docs/a.md": source });
  try {
    const transaction = transactionFor(root, [
      { file: "docs/a.md", patches: [patch(1, 3, 1, 5, "Old", "New", source)] },
    ]);

    rmSync(join(root, "docs/a.md"));
    await assert.rejects(rebaseEditTransaction({ siteRoot: root, transaction }), (error: unknown) => {
      assert.ok(error instanceof EditTransactionError);
      assert.equal(error.conflicts[0]?.kind, "rebase-missing");
      return true;
    });

    writeFileSync(join(root, "docs/a.md"), "Fresh\n");
    await assert.rejects(rebaseEditTransaction({ siteRoot: root, transaction }), (error: unknown) => {
      assert.ok(error instanceof EditTransactionError);
      assert.equal(error.conflicts[0]?.kind, "rebase-missing");
      assert.match(error.message, /no longer appears/);
      return true;
    });

    writeFileSync(join(root, "docs/a.md"), "xOld Old\n");
    await assert.rejects(rebaseEditTransaction({ siteRoot: root, transaction }), (error: unknown) => {
      assert.ok(error instanceof EditTransactionError);
      assert.equal(error.conflicts[0]?.kind, "rebase-ambiguous");
      assert.match(error.message, /appears 2 times/);
      return true;
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a rebase refuses a hash-only patch over changed bytes and a newline-ending span", async () => {
  const source = "# Old\n";
  const hashless = tree({ "docs/a.md": source });
  try {
    const parsed = parseEditTransaction({
      version: 1,
      task: { id: "task-one" },
      snapshot: { files: { "docs/a.md": hashSource(source) } },
      patches: [
        {
          file: "docs/a.md",
          patches: [{ span: { line: 1, column: 3, endLine: 1, endColumn: 5 }, replacement: "New", beforeHash: hashSource(source) }],
        },
      ],
    });
    assert.ok(parsed.transaction);
    writeFileSync(join(hashless, "docs/a.md"), "# Changed\n");
    await assert.rejects(rebaseEditTransaction({ siteRoot: hashless, transaction: parsed.transaction }), (error: unknown) => {
      assert.ok(error instanceof EditTransactionError);
      assert.equal(error.conflicts[0]?.kind, "rebase-missing");
      assert.match(error.message, /no expected text/);
      return true;
    });
    writeFileSync(join(hashless, "docs/a.md"), source);
    await assert.rejects(rebaseEditTransaction({ siteRoot: hashless, transaction: parsed.transaction }), (error: unknown) => {
      assert.ok(error instanceof EditTransactionError);
      assert.match(error.message, /no expected text/);
      return true;
    });
  } finally {
    rmSync(hashless, { recursive: true, force: true });
  }

  const newline = tree({ "docs/a.md": "# A\n" });
  try {
    const parsed = parseEditTransaction({
      version: 1,
      task: { id: "task-one" },
      snapshot: { files: { "docs/a.md": hashSource("# A\n") } },
      patches: [
        {
          file: "docs/a.md",
          patches: [{ span: { line: 1, column: 3, endLine: 1, endColumn: 4 }, expected: "A\n", replacement: "B\n", beforeHash: hashSource("# A\n") }],
        },
      ],
    });
    assert.ok(parsed.transaction);
    writeFileSync(join(newline, "docs/a.md"), "Intro\nA\n");
    await assert.rejects(rebaseEditTransaction({ siteRoot: newline, transaction: parsed.transaction }), (error: unknown) => {
      assert.ok(error instanceof EditTransactionError);
      assert.equal(error.conflicts[0]?.kind, "rebase-missing");
      assert.match(error.message, /cannot be represented/);
      return true;
    });
  } finally {
    rmSync(newline, { recursive: true, force: true });
  }
});

test("a rebased preview that would overlap is refused", async () => {
  const source = "# AB\n\n# A\n";
  const root = tree({ "docs/a.md": source });
  try {
    const transaction = transactionFor(root, [
      {
        file: "docs/a.md",
        patches: [
          patch(1, 3, 1, 5, "AB", "XY", source),
          patch(3, 3, 3, 4, "A", "Z", source),
        ],
      },
    ]);
    writeFileSync(join(root, "docs/a.md"), "AB\n");
    await assert.rejects(rebaseEditTransaction({ siteRoot: root, transaction, approve: true }), (error: unknown) => {
      assert.ok(error instanceof EditTransactionError);
      assert.equal(error.code, "edit.transaction-conflict");
      assert.ok(error.conflicts[0]?.kind === "stale-file" || error.conflicts[0]?.kind === "span-overlap");
      return true;
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unreadable or malformed receipt is refused before rollback", async () => {
  const root = tree({ "docs/a.md": "# A\n" });
  try {
    await assert.rejects(readEditReceipt(join(root, "missing.json")), (error: unknown) => {
      assert.ok(error instanceof EditTransactionError);
      assert.equal(error.code, "edit.rollback-invalid");
      assert.match(error.message, /cannot read/);
      return true;
    });

    writeFileSync(join(root, "bad.json"), "{nope");
    await assert.rejects(readEditReceipt(join(root, "bad.json")), (error: unknown) => {
      assert.ok(error instanceof EditTransactionError);
      assert.match(error.message, /not JSON/);
      return true;
    });

    const base = { id: "receipt", files: [] };
    const cases: unknown[] = [
      { ...base, version: 2 },
      { ...base, version: 1 },
      { ...base, version: 1, task: { id: "task-one" } },
      { ...base, version: 1, task: { id: "task-one" }, snapshot: { files: {} }, files: [{ file: "../x" }] },
    ];
    const messages = [
      /version 1 transaction receipt/,
      /no task id/,
      /no snapshot/,
      /path, hashes, or before bytes/,
    ];
    for (let index = 0; index < cases.length; index += 1) {
      const path = join(root, `receipt-${index}.json`);
      writeFileSync(path, JSON.stringify(cases[index]));
      await assert.rejects(readEditReceipt(path), (error: unknown) => {
        assert.ok(error instanceof EditTransactionError);
        assert.equal(error.code, "edit.rollback-invalid");
        assert.match(error.message, messages[index]!);
        return true;
      });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rollback preserves a missing file and reports a failed restore", async () => {
  const source = "# A\n";
  const root = tree({ "docs/a.md": source });
  try {
    const transaction = transactionFor(root, [
      { file: "docs/a.md", patches: [patch(1, 3, 1, 3, "A", "AA", source)] },
    ]);
    await apply(root, transaction);
    rmSync(join(root, "docs/a.md"));
    const preserved = await rollbackEditTransaction({ siteRoot: root, receipt: join(root, "tx.receipt.json") });
    assert.deepEqual(preserved.restored, []);
    assert.deepEqual(preserved.preserved, ["docs/a.md"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const failed = tree({ "docs/a.md": source });
  try {
    const transaction = transactionFor(failed, [
      { file: "docs/a.md", patches: [patch(1, 3, 1, 3, "A", "AA", source)] },
    ]);
    await apply(failed, transaction);
    await assert.rejects(
      rollbackEditTransaction({
        siteRoot: failed,
        receipt: join(failed, "tx.receipt.json"),
        transactionHooks: {
          beforeCommit: () => writeFileSync(join(failed, "docs/a.md"), "# changed again\n"),
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof EditTransactionError);
        assert.equal(error.code, "edit.transaction-write-failed");
        assert.match(error.message, /rollback failed/);
        return true;
      },
    );
  } finally {
    rmSync(failed, { recursive: true, force: true });
  }
});
