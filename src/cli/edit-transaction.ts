/**
 * `mizzen edit transaction <transaction.json> [dir]` and `mizzen edit rollback <receipt.json> [dir]`.
 *
 * The transaction file is the versioned contract in `src/contracts/edit-transaction.ts`. The command
 * checks it, previews it with `--dry-run`, and otherwise commits every file and its records as one
 * transaction. `edit rollback` restores only the files the receipt names and only when they still
 * hold the receipt's after hash, so a later independent edit is preserved.
 *
 * Exit codes match the rest of the CLI: `0` applied or a clean preview, `1` a conflict, invariant,
 * invalid content, or failed write, `2` a malformed request or transaction.
 */
import { resolve } from "node:path";
import type { AccessGrant, AccessPolicy } from "../contracts/permissions.ts";
import { checkWriteTarget } from "../permissions/write.ts";
import {
  applyEditTransaction,
  EditTransactionError,
  readEditTransaction,
  rebaseEditTransaction,
  rollbackEditTransaction,
  type EditTransactionResult,
} from "../edits/edit-transaction.ts";
import { unifiedDiff } from "../diff/unified.ts";
import type { EditTransactionConflict, EditTransactionReceipt } from "../contracts/edit-transaction.ts";

/** How `--format` prints the result. */
export type TransactionFormat = "text" | "json";

/** Options for {@link editTransactionCommand}. */
export interface EditTransactionCommandOptions {
  /** The transaction JSON file. */
  readonly transaction: string;
  /** The site root. */
  readonly siteRoot: string;
  readonly dryRun?: boolean;
  readonly rebase?: boolean;
  readonly approve?: boolean;
  readonly receipt?: string;
  readonly proof?: string;
  readonly audit?: string;
  readonly format?: TransactionFormat;
  /** An access policy; every patched file needs an allowed path and a matching scope. */
  readonly access?: AccessPolicy;
  /** Approvals the caller holds; stale ones never authorize a changed snapshot. */
  readonly approvals?: readonly AccessGrant[];
}

/** Options for {@link editRollbackCommand}. */
export interface EditRollbackCommandOptions {
  /** The receipt JSON file. */
  readonly receipt: string;
  /** The site root. */
  readonly siteRoot: string;
  readonly format?: TransactionFormat;
}

/** The JSON `edit transaction` prints, for a result or a refusal. */
export interface EditTransactionReport {
  readonly version: 1;
  readonly command: "edit.transaction";
  readonly status: "ok" | "failed" | "invalid";
  readonly ok: boolean;
  readonly exitCode: number;
  readonly dryRun: boolean;
  readonly applied: boolean;
  readonly id: string | null;
  readonly task: string | null;
  readonly files: EditTransactionResult["files"];
  readonly diff: string | null;
  readonly checks: EditTransactionResult["checks"];
  readonly receipt: string | null;
  readonly proof: string | null;
  readonly audit: readonly string[] | null;
  readonly conflicts: readonly EditTransactionConflict[];
  readonly diagnostics: readonly { readonly code: string; readonly message: string }[];
}

/** The JSON `edit rollback` prints. */
export interface EditRollbackReport {
  readonly version: 1;
  readonly command: "edit.rollback";
  readonly status: "ok" | "failed" | "invalid";
  readonly ok: boolean;
  readonly exitCode: number;
  readonly id: string | null;
  readonly restored: readonly string[];
  readonly preserved: readonly string[];
  readonly diagnostics: readonly { readonly code: string; readonly message: string }[];
}

/** The status an exit code names. */
function statusOf(exitCode: number): "ok" | "failed" | "invalid" {
  return exitCode === 0 ? "ok" : exitCode === 2 ? "invalid" : "failed";
}

/** The transaction's receipt path when the caller did not choose one. */
export function defaultReceiptPath(transactionFile: string): string {
  return `${resolve(transactionFile)}.receipt.json`;
}

/** The transaction's audit ledger when the caller did not choose one. */
export function defaultAuditPath(transactionFile: string): string {
  return `${resolve(transactionFile)}.audit.jsonl`;
}

/** The machine-readable result of a preview or an applied transaction. */
export function formatEditTransactionJson(
  result: EditTransactionResult | EditTransactionError,
  exitCode: number,
): string {
  const report: EditTransactionReport =
    result instanceof EditTransactionError
      ? {
          version: 1,
          command: "edit.transaction",
          status: statusOf(exitCode),
          ok: exitCode === 0,
          exitCode,
          dryRun: false,
          applied: false,
          id: null,
          task: null,
          files: [],
          diff: null,
          checks: result.checks,
          receipt: null,
          proof: null,
          audit: null,
          conflicts: result.conflicts,
          diagnostics: [{ code: result.code, message: result.message }],
        }
      : {
          version: 1,
          command: "edit.transaction",
          status: statusOf(exitCode),
          ok: exitCode === 0,
          exitCode,
          dryRun: result.dryRun,
          applied: result.applied,
          id: result.id,
          task: result.task,
          files: result.files,
          diff: result.diff ?? null,
          checks: result.checks,
          receipt: result.receipt ?? null,
          proof: result.proof ?? null,
          audit: result.audit ?? null,
          conflicts: [],
          diagnostics: [],
        };
  return `${JSON.stringify(report, null, 2)}\n`;
}

/** Runs `edit transaction`. */
export async function editTransactionCommand(options: EditTransactionCommandOptions): Promise<EditTransactionResult> {
  const original = await readEditTransaction(options.transaction);
  let transaction = original;
  if (options.rebase === true) {
    const rebased = await rebaseEditTransaction({
      siteRoot: options.siteRoot,
      transaction,
      approve: options.approve === true || options.dryRun === true,
    });
    transaction = rebased.transaction;
  }
  const receipt = options.receipt ?? defaultReceiptPath(options.transaction);
  if (options.access !== undefined) {
    for (const patched of transaction.patches) {
      const scope = {
        pages: transaction.scope.pages,
        blocks: transaction.scope.blocks,
        collections: transaction.scope.records,
        files: transaction.scope.files.length > 0 ? transaction.scope.files : [patched.file],
      };
      const checked = await checkWriteTarget({
        policy: options.access,
        siteRoot: options.siteRoot,
        path: patched.file,
        scope,
        task: transaction.task.id,
        snapshot: transaction.snapshot.id ?? "unversioned",
        ...(options.approvals === undefined ? {} : { approvals: options.approvals }),
      });
      if (!checked.decision.allowed) {
        throw new EditTransactionError(
          "edit.transaction-scope",
          `${patched.file}: the access policy denied the write (${checked.decision.rule}): ${checked.decision.reason}`,
          false,
        );
      }
    }
  }
  return applyEditTransaction({
    siteRoot: options.siteRoot,
    transaction,
    receipt,
    audit: options.audit ?? defaultAuditPath(options.transaction),
    ...(options.proof === undefined ? {} : { proof: options.proof }),
    ...(options.dryRun === true ? { dryRun: true } : {}),
    ...(options.approve === true ? { approve: true } : {}),
  });
}

/** The conflict lines of a refusal, without quoting either task's content. */
export function conflictLines(conflicts: readonly EditTransactionConflict[]): string[] {
  return conflicts.map((conflict) => {
    const files = conflict.file === undefined ? "" : `${conflict.file}: `;
    const tasks =
      conflict.otherTask === undefined
        ? `task ${conflict.task}`
        : `task ${conflict.task} and task ${conflict.otherTask}`;
    return `${files}${conflict.kind}: ${tasks}; options: ${conflict.options.join(", ")}.`;
  });
}

/** Runs `edit rollback`. */
export async function editRollbackCommand(options: EditRollbackCommandOptions): Promise<{ readonly report: EditRollbackReport }> {
  const result = await rollbackEditTransaction({ siteRoot: options.siteRoot, receipt: options.receipt });
  return {
    report: {
      version: 1,
      command: "edit.rollback",
      status: "ok",
      ok: true,
      exitCode: 0,
      id: result.id,
      restored: result.restored,
      preserved: result.preserved,
      diagnostics: [],
    },
  };
}

/** The machine-readable result of a rollback. */
export function formatEditRollbackJson(
  result: Awaited<ReturnType<typeof editRollbackCommand>>["report"] | EditTransactionError,
  exitCode: number,
): string {
  const report: EditRollbackReport =
    result instanceof EditTransactionError
      ? {
          version: 1,
          command: "edit.rollback",
          status: statusOf(exitCode),
          ok: exitCode === 0,
          exitCode,
          id: null,
          restored: [],
          preserved: [],
          diagnostics: [{ code: result.code, message: result.message }],
        }
      : { ...result, status: statusOf(exitCode), ok: exitCode === 0, exitCode };
  return `${JSON.stringify(report, null, 2)}\n`;
}

/** Re-exported for callers that print the preview themselves. */
export { unifiedDiff };

/** The receipt's files for a reader that only needs the paths. */
export function receiptFiles(receipt: EditTransactionReceipt): readonly string[] {
  return receipt.files.map((file) => file.file);
}
