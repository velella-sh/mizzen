/**
 * Apply one versioned, all-or-nothing multi-file edit transaction (#1163–#1176).
 *
 * A transaction is checked completely before any byte is written: its snapshot hashes and every
 * patch's `beforeHash` must match the files on disk, its spans must not overlap, its files must stay
 * inside the task's scope and the site root, the patched text must parse, and every invariant must
 * hold. Only then are the source files, the proof, the audit lines, and the receipt staged and
 * renamed in. A failure at any rename restores the files already replaced, so a caller never sees
 * half an edit or a success record for an edit that did not finish.
 *
 * Two transactions on the same file are ordered by the hashes they were planned against: the first
 * commits, the second's stale hash refuses it. Semantic reservations (`intent-lock.ts`) stop two
 * tasks from planning the same page, block, symbol, or record at the same time without locking an
 * unrelated part of the same file.
 *
 * The receipt carries the exact before bytes of every changed file, so `rollbackEditTransaction`
 * can restore this transaction alone and leave a later independent edit of another file untouched.
 */
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Ajv } from "ajv";
import { parseDocument } from "yaml";
import { parseFrontMatter } from "../content/frontmatter.ts";
import { parseMarkdown } from "../markdown/parse.ts";
import { unifiedDiff } from "../diff/unified.ts";
import { isEditAuditPath, createEditAudit, formatEditAudit } from "./audit.ts";
import { intentsOf, releaseIntents, reserveIntents, IntentLockError, type HeldIntent } from "./intent-lock.ts";
import {
  applyFilePatches,
  hashSource,
  PatchError,
  sliceBySpan,
  spanToOffsets,
  type FilePatches,
  type Patch,
  type PatchSpan,
  type PatchedFile,
} from "./patch.ts";
import { createProof, formatProof } from "./proof.ts";
import { commitArtifacts, TransactionError, type TransactionArtifact, type TransactionHooks } from "./transaction.ts";
import type {
  EditRollbackResult,
  EditTransaction,
  EditTransactionCheck,
  EditTransactionConflict,
  EditTransactionConflictKind,
  EditTransactionFile,
  EditTransactionFileResult,
  EditTransactionInvariant,
  EditTransactionParseResult,
  EditTransactionPatch,
  EditTransactionPreconditions,
  EditTransactionProblem,
  EditTransactionReceipt,
  EditTransactionResult,
  EditTransactionScope,
  EditTransactionSnapshot,
  EditTransactionSpan,
  EditTransactionTask,
} from "../contracts/edit-transaction.ts";

export type { EditTransactionResult } from "../contracts/edit-transaction.ts";

/** The transaction format version. Only 1 exists. */
export const EDIT_TRANSACTION_VERSION = 1;

/** Why a transaction was refused. Each code names one situation so the CLI can pick an exit code. */
export type EditTransactionErrorCode =
  | "edit.transaction-missing"
  | "edit.transaction-invalid"
  | "edit.transaction-conflict"
  | "edit.transaction-scope"
  | "edit.transaction-boundary"
  | "edit.transaction-check-failed"
  | "edit.transaction-approval-required"
  | "edit.transaction-write-failed"
  | "edit.rollback-invalid";

/** A refused or failed transaction. Nothing is written unless `writeFailed` is set and its rollback failed. */
export class EditTransactionError extends Error {
  readonly code: EditTransactionErrorCode;
  /** True when the request itself is malformed (exit 2). */
  readonly usage: boolean;
  /** Every conflict found, in a fixed order. */
  readonly conflicts: readonly EditTransactionConflict[];
  /** The checks that ran before the refusal, when the refusal happened after checking. */
  readonly checks: readonly EditTransactionCheck[];

  constructor(
    code: EditTransactionErrorCode,
    message: string,
    usage: boolean,
    options: {
      readonly conflicts?: readonly EditTransactionConflict[];
      readonly checks?: readonly EditTransactionCheck[];
    } = {},
  ) {
    super(message);
    this.name = "EditTransactionError";
    this.code = code;
    this.usage = usage;
    this.conflicts = options.conflicts ?? [];
    this.checks = options.checks ?? [];
  }
}

/** A caller-supplied invariant, for rules a document cannot express. */
export interface CustomTransactionInvariant {
  /** Stable id, reported with the other checks. */
  readonly id: string;
  /** Return a failure sentence, or undefined when the invariant holds. */
  readonly check: (files: ReadonlyMap<string, string>) => string | undefined;
}

/** What {@link applyEditTransaction} needs. */
export interface ApplyEditTransactionOptions {
  /** The site root every file path is resolved against. */
  readonly siteRoot: string;
  /** The validated transaction. Use {@link readEditTransaction} for a JSON file. */
  readonly transaction: EditTransaction;
  /** The receipt's path. A relative path is resolved against the site root. */
  readonly receipt: string;
  /** The proof's path; defaults to `<receipt>.proof.json`. */
  readonly proof?: string;
  /** The JSON Lines audit ledger; omitted means no ledger is written. */
  readonly audit?: string;
  /** Check everything, print the aggregate diff, and write nothing (not even a reservation). */
  readonly dryRun?: boolean;
  /** Allow a rebased transaction whose relocated spans are low confidence. */
  readonly approve?: boolean;
  /** Test seam for the commit; production callers pass nothing. */
  readonly transactionHooks?: TransactionHooks;
  /** Additional invariants checked after patching and before activation. */
  readonly customInvariants?: readonly CustomTransactionInvariant[];
  /** The record's date, as an ISO string or Date. Default: SOURCE_DATE_EPOCH, else no date. */
  readonly date?: string | Date;
}

/** A dry-run preview: the aggregate diff and everything that was checked. */
export interface EditTransactionPreview extends EditTransactionResult {
  readonly dryRun: true;
  readonly applied: false;
}

/** One file after planning, before any write. */
interface PlannedFile {
  readonly file: string;
  readonly target: string;
  readonly before: string;
  readonly beforeHash: string;
  readonly after: string;
  readonly afterHash: string;
  readonly spans: readonly PatchSpan[];
  readonly firstSpan: PatchSpan;
}

/** The checked result of one transaction. */
interface Planned {
  readonly files: readonly PlannedFile[];
  readonly checks: readonly EditTransactionCheck[];
}

/** Whether `value` is a plain object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A positive whole line or column. */
function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/** True when `value` is a SHA-256 in either case. */
function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-fA-F]{64}$/.test(value);
}

/** Key-sorted JSON, so two equal values hash alike whatever order their keys were built in. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (isObject(value)) {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** SHA-256 of a string. */
function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The snapshot id: a hash over the sorted file hashes. */
export function transactionSnapshotId(files: Readonly<Record<string, string>>): string {
  return sha256(`mizzen-edit-transaction-snapshot\0${canonicalJson(files)}`);
}

/** The transaction id: a hash over the normalized contract. */
export function transactionIdOf(transaction: Omit<EditTransaction, "id">): string {
  return sha256(
    `mizzen-edit-transaction\0${canonicalJson({
      version: transaction.version,
      task: transaction.task,
      snapshot: transaction.snapshot.files,
      patches: transaction.patches,
      invariants: transaction.invariants,
      preconditions: transaction.preconditions,
      scope: transaction.scope,
    })}`,
  );
}

/** The default scope: every list present and empty. */
function emptyScope(): EditTransactionScope {
  return { pages: [], blocks: [], symbols: [], records: [], files: [] };
}

/** Accumulates parser problems without throwing, so one document reports every problem. */
class Problems {
  readonly list: EditTransactionProblem[] = [];

  add(path: string, code: string, message: string): undefined {
    this.list.push({ path, code, message });
    return undefined;
  }
}

/** Parses one span, or records why it is not usable. */
function parseSpan(value: unknown, path: string, problems: Problems): EditTransactionSpan | undefined {
  if (!isObject(value)) return problems.add(path, "transaction.invalid-span", `${path}: the span is not an object.`);
  for (const key of ["line", "column", "endLine", "endColumn"] as const) {
    if (!positiveInteger(value[key])) {
      return problems.add(
        `${path}/${key}`,
        "transaction.invalid-span",
        `${path}.${key} is not a 1-based whole number.`,
      );
    }
  }
  if (value.file !== undefined && !isEditAuditPath(value.file)) {
    return problems.add(
      `${path}/file`,
      "transaction.invalid-file",
      `${path}.file is not a path relative to the site root with forward slashes.`,
    );
  }
  return {
    ...(value.file === undefined ? {} : { file: value.file as string }),
    line: value.line as number,
    column: value.column as number,
    endLine: value.endLine as number,
    endColumn: value.endColumn as number,
  };
}

/** Parses one patch, or records why it is not usable. */
function parsePatch(
  value: unknown,
  path: string,
  file: string,
  problems: Problems,
): EditTransactionPatch | undefined {
  if (!isObject(value)) return problems.add(path, "transaction.invalid-patch", `${path}: the patch is not an object.`);
  if (typeof value.replacement !== "string") {
    return problems.add(`${path}/replacement`, "transaction.invalid-patch", `${path}.replacement is not a string.`);
  }
  for (const key of ["expected", "beforeHash"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      problems.add(`${path}/${key}`, "transaction.invalid-patch", `${path}.${key} is not a string.`);
    }
  }
  if (value.beforeHash !== undefined && !isHash(value.beforeHash)) {
    problems.add(
      `${path}/beforeHash`,
      "transaction.invalid-hash",
      `${path}.beforeHash is not 64 hexadecimal characters.`,
    );
  }
  const span = parseSpan(value.span, `${path}/span`, problems);
  if (span === undefined) return undefined;
  if (span.file !== undefined && span.file !== file) {
    return problems.add(
      `${path}/span/file`,
      "transaction.file-mismatch",
      `${path}: the span names "${span.file}" but the patch belongs to "${file}".`,
    );
  }
  return {
    span,
    ...(value.expected === undefined ? {} : { expected: value.expected as string }),
    replacement: value.replacement,
    ...(value.beforeHash === undefined ? {} : { beforeHash: (value.beforeHash as string).toLowerCase() }),
  };
}

/** Parses the invariants, refusing an unknown kind or a missing field. */
function parseInvariant(
  value: unknown,
  path: string,
  problems: Problems,
): EditTransactionInvariant | undefined {
  if (!isObject(value)) return problems.add(path, "transaction.invalid-invariant", `${path}: the invariant is not an object.`);
  if (typeof value.id !== "string" || value.id === "") {
    return problems.add(`${path}/id`, "transaction.invalid-invariant", `${path}.id is not a non-empty string.`);
  }
  if (!isEditAuditPath(value.file)) {
    return problems.add(
      `${path}/file`,
      "transaction.invalid-invariant",
      `${path}.file is not a path relative to the site root.`,
    );
  }
  const kind = value.kind;
  if (kind === "contains" || kind === "absent" || kind === "unchanged") {
    if (typeof value.text !== "string") {
      return problems.add(`${path}/text`, "transaction.invalid-invariant", `${path}.text is not a string.`);
    }
    return { id: value.id, kind, file: value.file, text: value.text };
  }
  if (kind === "json-equals") {
    if (typeof value.pointer !== "string") {
      return problems.add(`${path}/pointer`, "transaction.invalid-invariant", `${path}.pointer is not a string.`);
    }
    return { id: value.id, kind, file: value.file, pointer: value.pointer, value: value.value };
  }
  if (kind === "json-schema") {
    if (!isObject(value.schema)) {
      return problems.add(`${path}/schema`, "transaction.invalid-invariant", `${path}.schema is not an object.`);
    }
    return { id: value.id, kind, file: value.file, schema: value.schema };
  }
  return problems.add(
    `${path}/kind`,
    "transaction.invalid-invariant",
    `${path}.kind is not contains, absent, unchanged, json-equals, or json-schema.`,
  );
}

/** A string list from a scope, with duplicates removed and a stable order. */
function stringList(value: unknown, path: string, problems: Problems): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return problems.add(path, "transaction.invalid-scope", `${path} is not an array.`) ?? [];
  const values: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item === "") {
      problems.add(path, "transaction.invalid-scope", `${path} contains a value that is not a non-empty string.`);
      continue;
    }
    values.push(item);
  }
  return [...new Set(values)].sort();
}

/**
 * Validates an untrusted transaction document. A malformed patch, a missing snapshot hash, a
 * duplicate file, or an unknown invariant is a problem; no caller writes anything until the list is
 * empty. The returned transaction has its derived ids.
 */
export function parseEditTransaction(value: unknown): EditTransactionParseResult {
  const problems = new Problems();
  if (!isObject(value)) {
    problems.add("", "transaction.invalid", "The transaction is not a JSON object.");
    return { problems: problems.list };
  }
  if (value.version !== EDIT_TRANSACTION_VERSION) {
    problems.add("/version", "transaction.version", `The transaction version is not ${EDIT_TRANSACTION_VERSION}.`);
  }

  let task: EditTransactionTask | undefined;
  if (!isObject(value.task) || typeof value.task.id !== "string" || value.task.id === "") {
    problems.add("/task", "transaction.invalid-task", "task.id is not a non-empty string.");
  } else {
    for (const key of ["requestId", "goal"] as const) {
      if (value.task[key] !== undefined && (typeof value.task[key] !== "string" || value.task[key] === "")) {
        problems.add(`/task/${key}`, "transaction.invalid-task", `task.${key} is not a non-empty string.`);
      }
    }
    task = {
      id: value.task.id,
      ...(value.task.requestId === undefined ? {} : { requestId: value.task.requestId as string }),
      ...(value.task.goal === undefined ? {} : { goal: value.task.goal as string }),
    };
  }

  let snapshot: EditTransactionSnapshot | undefined;
  if (!isObject(value.snapshot) || !isObject(value.snapshot.files)) {
    problems.add("/snapshot", "transaction.invalid-snapshot", "snapshot.files is not an object of path to SHA-256.");
  } else {
    const files: Record<string, string> = {};
    for (const [file, hash] of Object.entries(value.snapshot.files)) {
      if (!isEditAuditPath(file)) {
        problems.add(`/snapshot/files/${file}`, "transaction.invalid-file", `"${file}" is not a site-relative path.`);
      } else if (!isHash(hash)) {
        problems.add(
          `/snapshot/files/${file}`,
          "transaction.invalid-hash",
          `snapshot.files["${file}"] is not 64 hexadecimal characters.`,
        );
      } else {
        files[file] = hash.toLowerCase();
      }
    }
    snapshot = { files, id: transactionSnapshotId(files) };
  }

  const patches: EditTransactionFile[] = [];
  if (!Array.isArray(value.patches) || value.patches.length === 0) {
    problems.add("/patches", "transaction.invalid-patches", "patches is not a non-empty array.");
  } else {
    const seen = new Set<string>();
    for (let index = 0; index < value.patches.length; index += 1) {
      const entry = value.patches[index];
      const path = `/patches/${index}`;
      if (!isObject(entry)) {
        problems.add(path, "transaction.invalid-patches", `${path} is not an object.`);
        continue;
      }
      if (!isEditAuditPath(entry.file)) {
        problems.add(`${path}/file`, "transaction.invalid-file", `${path}.file is not a site-relative path.`);
        continue;
      }
      const file = entry.file;
      if (seen.has(file)) {
        problems.add(`${path}/file`, "transaction.duplicate-file", `${file}: the transaction lists this file more than once.`);
        continue;
      }
      seen.add(file);
      if (!Array.isArray(entry.patches) || entry.patches.length === 0) {
        problems.add(`${path}/patches`, "transaction.invalid-patches", `${file}: the file has no patches.`);
        continue;
      }
      const list: EditTransactionPatch[] = [];
      for (let patchIndex = 0; patchIndex < entry.patches.length; patchIndex += 1) {
        const patch = parsePatch(entry.patches[patchIndex], `${path}/patches/${patchIndex}`, file, problems);
        if (patch !== undefined) list.push(patch);
      }
      if (list.length > 0) patches.push({ file, patches: list });
    }
  }

  const invariants: EditTransactionInvariant[] = [];
  if (value.invariants !== undefined) {
    if (!Array.isArray(value.invariants)) {
      problems.add("/invariants", "transaction.invalid-invariant", "invariants is not an array.");
    } else {
      const seen = new Set<string>();
      for (let index = 0; index < value.invariants.length; index += 1) {
        const invariant = parseInvariant(value.invariants[index], `/invariants/${index}`, problems);
        if (invariant === undefined) continue;
        if (seen.has(invariant.id)) {
          problems.add(
            `/invariants/${index}/id`,
            "transaction.duplicate-invariant",
            `invariant id "${invariant.id}" appears more than once.`,
          );
          continue;
        }
        seen.add(invariant.id);
        invariants.push(invariant);
      }
    }
  }

  let preconditions: EditTransactionPreconditions = { requireBeforeHash: true, validateContent: true };
  if (value.preconditions !== undefined) {
    if (!isObject(value.preconditions)) {
      problems.add("/preconditions", "transaction.invalid-preconditions", "preconditions is not an object.");
    } else {
      for (const key of ["requireBeforeHash", "validateContent"] as const) {
        if (value.preconditions[key] !== undefined && typeof value.preconditions[key] !== "boolean") {
          problems.add(`/preconditions/${key}`, "transaction.invalid-preconditions", `preconditions.${key} is not a boolean.`);
        }
      }
      if (value.preconditions.commit !== undefined && typeof value.preconditions.commit !== "string") {
        problems.add("/preconditions/commit", "transaction.invalid-preconditions", "preconditions.commit is not a string.");
      }
      preconditions = {
        requireBeforeHash: value.preconditions.requireBeforeHash !== false,
        validateContent: value.preconditions.validateContent !== false,
        ...(typeof value.preconditions.commit === "string" ? { commit: value.preconditions.commit } : {}),
      };
    }
  }

  const scope = emptyScope();
  let normalizedScope: EditTransactionScope = scope;
  if (value.scope !== undefined) {
    if (!isObject(value.scope)) {
      problems.add("/scope", "transaction.invalid-scope", "scope is not an object.");
    } else {
      normalizedScope = {
        pages: stringList(value.scope.pages, "/scope/pages", problems),
        blocks: stringList(value.scope.blocks, "/scope/blocks", problems),
        symbols: stringList(value.scope.symbols, "/scope/symbols", problems),
        records: stringList(value.scope.records, "/scope/records", problems),
        files: stringList(value.scope.files, "/scope/files", problems),
      };
    }
  }

  if (problems.list.length > 0) return { problems: problems.list };
  if (task === undefined || snapshot === undefined) {
    return { problems: [{ path: "", code: "transaction.invalid", message: "The transaction is incomplete." }] };
  }
  const base: Omit<EditTransaction, "id"> = {
    version: EDIT_TRANSACTION_VERSION,
    task,
    snapshot,
    patches,
    invariants,
    preconditions,
    scope: normalizedScope,
  };
  return { transaction: { ...base, id: transactionIdOf(base) }, problems: [] };
}

/** The reason an errno error gives, as one phrase. */
function reasonOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return "it does not exist";
  if (code === "EISDIR") return "it is a directory";
  if (code === "EACCES" || code === "EPERM") return "it is not readable";
  return error instanceof Error ? error.message : String(error);
}

/** Reads and validates a transaction JSON file. */
export async function readEditTransaction(path: string): Promise<EditTransaction> {
  let text: string;
  try {
    text = await readFile(resolve(path), "utf8");
  } catch (error) {
    throw new EditTransactionError(
      "edit.transaction-missing",
      `${path}: cannot read the transaction: ${reasonOf(error)}.`,
      true,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new EditTransactionError(
      "edit.transaction-invalid",
      `${path}: the transaction is not JSON: ${reasonOf(error)}.`,
      true,
    );
  }
  const parsed = parseEditTransaction(value);
  if (parsed.transaction === undefined) {
    throw new EditTransactionError(
      "edit.transaction-invalid",
      `${path}: the transaction is invalid: ${parsed.problems
        .map((problem) => `${problem.path === "" ? "/" : problem.path}: ${problem.message}`)
        .join("; ")}.`,
      true,
    );
  }
  return parsed.transaction;
}

/** The real site root, or the path as given when it cannot be resolved. */
async function realRootOf(root: string): Promise<string> {
  try {
    return await realpath(root);
  } catch {
    return root;
  }
}

/** Whether a real path is the root or sits below it. */
function withinReal(root: string, path: string): boolean {
  const inside = relative(root, path);
  return inside === "" || (inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside));
}

/** The target of one transaction file: real parents, no symlink target, inside the root. */
async function targetOf(
  siteRoot: string,
  realRoot: string,
  file: string,
  task: string,
): Promise<{ readonly path: string; readonly real: string }> {
  const lexical = resolve(siteRoot, file);
  const inside = relative(siteRoot, lexical);
  if (
    file === "" ||
    isAbsolute(file) ||
    file.includes("\\") ||
    /^[a-zA-Z]:/.test(file) ||
    inside === "" ||
    inside === ".." ||
    inside.startsWith(`..${sep}`) ||
    isAbsolute(inside)
  ) {
    throw new EditTransactionError(
      "edit.transaction-boundary",
      `${file}: the transaction names a path outside the site root "${siteRoot}"; refusing it.`,
      false,
      {
        conflicts: [
          {
            kind: "boundary",
            task,
            file,
            options: ["resolve"],
            message: `${file}: the path is outside the site root; nothing was written.`,
          },
        ],
      },
    );
  }

  let realParent: string;
  try {
    realParent = await realpath(dirname(lexical));
  } catch (error) {
    throw new EditTransactionError(
      "edit.transaction-boundary",
      `${file}: the parent folder cannot be resolved: ${reasonOf(error)}; nothing was written.`,
      false,
      {
        conflicts: [
          {
            kind: "boundary",
            task,
            file,
            options: ["resolve"],
            message: `${file}: the parent folder cannot be resolved; nothing was written.`,
          },
        ],
      },
    );
  }
  if (!withinReal(realRoot, realParent)) {
    throw new EditTransactionError(
      "edit.transaction-boundary",
      `${file}: the path resolves outside the site root "${realRoot}"; refusing it.`,
      false,
      {
        conflicts: [
          {
            kind: "boundary",
            task,
            file,
            options: ["resolve"],
            message: `${file}: the path resolves outside the site root; nothing was written.`,
          },
        ],
      },
    );
  }

  const target = join(realParent, basename(lexical));
  try {
    if ((await lstat(target)).isSymbolicLink()) {
      throw new EditTransactionError(
        "edit.transaction-boundary",
        `${file}: the target is a symbolic link, so the edit would read one file and write another; refusing it.`,
        false,
        {
          conflicts: [
            {
              kind: "boundary",
              task,
              file,
              options: ["resolve"],
              message: `${file}: the target is a symbolic link; nothing was written.`,
            },
          ],
        },
      );
    }
  } catch (error) {
    if (error instanceof EditTransactionError) throw error;
    // A missing target is reported by the read that follows.
  }
  return { path: lexical, real: target };
}

/** A stale or boundary conflict, with no source content. */
function conflictOf(
  kind: EditTransactionConflictKind,
  task: string,
  message: string,
  detail: {
    readonly file?: string;
    readonly otherTask?: string;
    readonly spans?: readonly EditTransactionSpan[];
    readonly options?: readonly ("rebase" | "approve" | "resolve")[];
  } = {},
): EditTransactionConflict {
  return {
    kind,
    task,
    ...(detail.file === undefined ? {} : { file: detail.file }),
    ...(detail.otherTask === undefined ? {} : { otherTask: detail.otherTask }),
    ...(detail.spans === undefined ? {} : { spans: detail.spans }),
    options: detail.options ?? ["rebase", "approve"],
    message,
  };
}

/** Detects two spans in one file that share text before the patch engine runs. */
function assertNoOverlap(file: string, source: string, patches: readonly Patch[], task: string): void {
  const checked: { readonly span: PatchSpan; readonly start: number; readonly end: number }[] = [];
  for (const patch of patches) {
    try {
      checked.push({ span: patch.span, ...spanToOffsets(source, patch.span) });
    } catch (error) {
      if (error instanceof PatchError) continue; // applyPatches reports the out-of-range span.
      throw error;
    }
  }
  checked.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let index = 1; index < checked.length; index += 1) {
    const previous = checked[index - 1]!;
    const current = checked[index]!;
    if (current.start >= previous.end) continue;
    const identical = current.start === previous.start && current.end === previous.end;
    throw new EditTransactionError(
      "edit.transaction-conflict",
      `${file}: spans ${previous.span.line}:${previous.span.column}-${previous.span.endLine}:${previous.span.endColumn} and ${current.span.line}:${current.span.column}-${current.span.endLine}:${current.span.endColumn} ${identical ? "name the same text" : "overlap"}; nothing was written.`,
      false,
      {
        conflicts: [
          conflictOf("span-overlap", task, `${file}: two patches ${identical ? "name the same text" : "overlap"}; nothing was written.`, {
            file,
            spans: [previous.span, current.span],
            options: ["resolve"],
          }),
        ],
      },
    );
  }
}

/** Parses a JSON file, or returns why it cannot. */
function parseJson(text: string): { value?: unknown; problem?: string } {
  try {
    return { value: JSON.parse(text) as unknown };
  } catch (error) {
    return { problem: reasonOf(error) };
  }
}

/** The value at a JSON pointer, or a sentinel when the pointer does not exist. */
const MISSING = Symbol("missing");

function pointerValue(value: unknown, pointer: string): unknown {
  if (pointer === "") return value;
  if (!pointer.startsWith("/")) return MISSING;
  let current = value;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return MISSING;
      current = current[index];
    } else if (isObject(current) && Object.hasOwn(current, key)) {
      current = current[key];
    } else {
      return MISSING;
    }
  }
  return current;
}

/** Visits every mdast position and proves it maps inside `text`. */
function sourceMapProblem(tree: unknown, text: string, file: string): string | undefined {
  const lineCount = text.split("\n").length;
  const visit = (node: unknown): string | undefined => {
    if (!isObject(node)) return undefined;
    const position = node.position;
    if (isObject(position)) {
      const start = position.start;
      const end = position.end;
      if (isObject(start) && positiveInteger(start.line) && positiveInteger(start.column)) {
        if (start.line > lineCount) return `${file}: a parsed node starts on line ${start.line}, past the end of the file.`;
      }
      if (isObject(end) && positiveInteger(end.line) && positiveInteger(end.column)) {
        if (end.line > lineCount) return `${file}: a parsed node ends on line ${end.line}, past the end of the file.`;
      }
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        const problem = visit(child);
        if (problem !== undefined) return problem;
      }
    }
    return undefined;
  };
  return visit(tree);
}

/** Checks that the patched text parses and that its positions stay inside the file. */
async function contentCheck(file: string, text: string): Promise<EditTransactionCheck> {
  const lower = file.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".mdx")) {
    const frontMatter = parseFrontMatter(text, file);
    const errors = frontMatter.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    if (errors.length > 0) {
      return { id: `content:${file}`, status: "failed", message: errors[0]!.message };
    }
    try {
      const tree = await parseMarkdown(frontMatter.body, frontMatter.bodyLine);
      const problem = sourceMapProblem(tree, text, file);
      if (problem !== undefined) return { id: `content:${file}`, status: "failed", message: problem };
    } catch (error) {
      return { id: `content:${file}`, status: "failed", message: `${file}: Markdown cannot be parsed: ${reasonOf(error)}.` };
    }
    return { id: `content:${file}`, status: "passed" };
  }
  if (lower.endsWith(".json")) {
    const parsed = parseJson(text);
    return parsed.problem === undefined
      ? { id: `content:${file}`, status: "passed" }
      : { id: `content:${file}`, status: "failed", message: `${file}: JSON cannot be parsed: ${parsed.problem}.` };
  }
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) {
    const document = parseDocument(text);
    return document.errors.length === 0
      ? { id: `content:${file}`, status: "passed" }
      : { id: `content:${file}`, status: "failed", message: `${file}: YAML cannot be parsed: ${document.errors[0]!.message}.` };
  }
  return { id: `content:${file}`, status: "skipped" };
}

/** Runs one built-in invariant over the patched contents. */
function invariantCheck(
  invariant: EditTransactionInvariant,
  files: ReadonlyMap<string, string>,
): EditTransactionCheck {
  const text = files.get(invariant.file);
  if (text === undefined) {
    return {
      id: invariant.id,
      status: "failed",
      message: `${invariant.file}: the invariant names a file the transaction does not change.`,
    };
  }
  if (invariant.kind === "contains" || invariant.kind === "unchanged") {
    return text.includes(invariant.text)
      ? { id: invariant.id, status: "passed" }
      : { id: invariant.id, status: "failed", message: `${invariant.file}: the required text does not survive the edit.` };
  }
  if (invariant.kind === "absent") {
    return text.includes(invariant.text)
      ? { id: invariant.id, status: "failed", message: `${invariant.file}: the forbidden text is still present.` }
      : { id: invariant.id, status: "passed" };
  }
  const parsed = parseJson(text);
  if (parsed.problem !== undefined) {
    return { id: invariant.id, status: "failed", message: `${invariant.file}: JSON cannot be parsed: ${parsed.problem}.` };
  }
  if (invariant.kind === "json-equals") {
    const actual = pointerValue(parsed.value, invariant.pointer);
    if (actual === MISSING) {
      return { id: invariant.id, status: "failed", message: `${invariant.file}: the pointer "${invariant.pointer}" does not exist.` };
    }
    return canonicalJson(actual) === canonicalJson(invariant.value)
      ? { id: invariant.id, status: "passed" }
      : { id: invariant.id, status: "failed", message: `${invariant.file}: the value at "${invariant.pointer}" differs.` };
  }
  try {
    const ajv = new Ajv({ strict: true, allErrors: true });
    const validate = ajv.compile(invariant.schema);
    return validate(parsed.value)
      ? { id: invariant.id, status: "passed" }
      : {
          id: invariant.id,
          status: "failed",
          message: `${invariant.file}: the JSON Schema rejected the value${validate.errors?.[0]?.message === undefined ? "" : ` (${validate.errors[0].message})`}.`,
        };
  } catch (error) {
    return { id: invariant.id, status: "failed", message: `${invariant.file}: the JSON Schema cannot be compiled: ${reasonOf(error)}.` };
  }
}

/** Reads every file, checks the whole set, and produces the planned contents without writing. */
async function planTransaction(
  siteRoot: string,
  transaction: EditTransaction,
  customInvariants: readonly CustomTransactionInvariant[],
): Promise<Planned> {
  const realRoot = await realRootOf(siteRoot);
  const inputs: FilePatches[] = [];
  const files: { file: string; target: string; source: string; beforeHash: string; patches: readonly Patch[] }[] = [];
  const checks: EditTransactionCheck[] = [];

  for (const entry of transaction.patches) {
    if (transaction.scope.files.length > 0 && !transaction.scope.files.includes(entry.file)) {
      throw new EditTransactionError(
        "edit.transaction-scope",
        `${entry.file}: the transaction's scope does not permit this file; nothing was written.`,
        false,
        {
          conflicts: [
            conflictOf("scope", transaction.task.id, `${entry.file}: the file is outside the task's scope; nothing was written.`, {
              file: entry.file,
              options: ["resolve"],
            }),
          ],
        },
      );
    }

    const target = await targetOf(siteRoot, realRoot, entry.file, transaction.task.id);
    let source: string;
    try {
      source = await readFile(target.real, "utf8");
    } catch (error) {
      throw new EditTransactionError(
        "edit.transaction-conflict",
        `${entry.file}: the file cannot be read: ${reasonOf(error)}; nothing was written.`,
        false,
        {
          conflicts: [
            conflictOf("boundary", transaction.task.id, `${entry.file}: the file cannot be read; nothing was written.`, {
              file: entry.file,
              options: ["resolve"],
            }),
          ],
        },
      );
    }
    const beforeHash = hashSource(source);
    const snapshotHash = transaction.snapshot.files[entry.file];
    if (snapshotHash === undefined) {
      throw new EditTransactionError(
        "edit.transaction-conflict",
        `${entry.file}: the snapshot has no hash for this file; nothing was written.`,
        false,
        {
          conflicts: [
            conflictOf("stale-snapshot", transaction.task.id, `${entry.file}: the snapshot does not cover this file; rebase to plan it again.`, {
              file: entry.file,
            }),
          ],
        },
      );
    }
    if (snapshotHash !== beforeHash) {
      throw new EditTransactionError(
        "edit.transaction-conflict",
        `${entry.file}: the snapshot expected ${snapshotHash}, but the file hashes to ${beforeHash}; nothing was written.`,
        false,
        {
          conflicts: [
            conflictOf("stale-snapshot", transaction.task.id, `${entry.file}: the file changed since the snapshot; rebase onto the current bytes.`, {
              file: entry.file,
            }),
          ],
        },
      );
    }
    checks.push({ id: `snapshot:${entry.file}`, status: "passed" });

    for (const patch of entry.patches) {
      if (patch.beforeHash === undefined) {
        if (transaction.preconditions.requireBeforeHash) {
          throw new EditTransactionError(
            "edit.transaction-conflict",
            `${entry.file}: a patch has no beforeHash; a stale source cannot be ruled out.`,
            false,
            {
              conflicts: [
                conflictOf("stale-file", transaction.task.id, `${entry.file}: a patch carries no beforeHash; nothing was written.`, {
                  file: entry.file,
                }),
              ],
            },
          );
        }
      } else if (patch.beforeHash.toLowerCase() !== beforeHash) {
        throw new EditTransactionError(
          "edit.transaction-conflict",
          `${entry.file}: a patch expected ${patch.beforeHash}, but the file hashes to ${beforeHash}; nothing was written.`,
          false,
          {
            conflicts: [
              conflictOf("stale-file", transaction.task.id, `${entry.file}: a patch was computed for a different version; rebase it.`, {
                file: entry.file,
              }),
            ],
          },
        );
      }
    }
    checks.push({ id: `hash:${entry.file}`, status: "passed" });

    assertNoOverlap(entry.file, source, entry.patches, transaction.task.id);
    const patches: Patch[] = entry.patches.map((patch) => ({
      span: patch.span,
      replacement: patch.replacement,
      ...(patch.expected === undefined ? {} : { expected: patch.expected }),
      ...(patch.beforeHash === undefined ? {} : { beforeHash: patch.beforeHash }),
    }));
    inputs.push({ file: entry.file, source, patches });
    files.push({ file: entry.file, target: target.real, source, beforeHash, patches });
  }

  let patched: readonly PatchedFile[];
  try {
    patched = applyFilePatches(inputs, {
      requireHash: transaction.preconditions.requireBeforeHash,
      requireExpected: true,
    });
  } catch (error) {
    if (error instanceof PatchError) {
      throw new EditTransactionError(
        "edit.transaction-conflict",
        `${error.span.file ?? "the transaction"}: the patch was refused and nothing was written: ${error.message}`,
        false,
        {
          conflicts: [
            conflictOf(
              error.code === "overlapping-spans" || error.code === "ambiguous-span" ? "span-overlap" : "stale-file",
              transaction.task.id,
              `${error.span.file ?? "the transaction"}: ${error.code}; nothing was written.`,
              { ...(error.span.file === undefined ? {} : { file: error.span.file }), spans: [error.span] },
            ),
          ],
        },
      );
    }
    throw error;
  }

  const afterByFile = new Map(patched.map((file) => [file.file, file.after]));
  if (transaction.preconditions.validateContent) {
    for (const file of patched) {
      const check = await contentCheck(file.file, file.after);
      checks.push(check);
      if (check.status === "failed") {
        throw new EditTransactionError(
          "edit.transaction-check-failed",
          `${check.message ?? file.file}: the edited content is not valid; nothing was written.`,
          false,
          { checks },
        );
      }
    }
  }

  for (const invariant of transaction.invariants) {
    const check = invariantCheck(invariant, afterByFile);
    checks.push(check);
    if (check.status === "failed") {
      throw new EditTransactionError(
        "edit.transaction-check-failed",
        `${check.message ?? invariant.id}: the invariant failed; nothing was written.`,
        false,
        { checks },
      );
    }
  }
  for (const invariant of customInvariants) {
    let message: string | undefined;
    try {
      message = invariant.check(afterByFile);
    } catch (error) {
      message = reasonOf(error);
    }
    const check: EditTransactionCheck =
      message === undefined
        ? { id: invariant.id, status: "passed" }
        : { id: invariant.id, status: "failed", message };
    checks.push(check);
    if (message !== undefined) {
      throw new EditTransactionError(
        "edit.transaction-check-failed",
        `${invariant.id}: ${message}; nothing was written.`,
        false,
        { checks },
      );
    }
  }

  const planned: PlannedFile[] = [];
  for (const file of files) {
    const result = patched.find((candidate) => candidate.file === file.file);
    if (result === undefined) continue;
    planned.push({
      file: file.file,
      target: file.target,
      before: file.source,
      beforeHash: file.beforeHash,
      after: result.after,
      afterHash: result.afterHash,
      spans: result.spans,
      firstSpan: file.patches[0]?.span ?? { line: 1, column: 1, endLine: 1, endColumn: 1 },
    });
  }
  planned.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return { files: planned, checks };
}

/** A path as a record shows it: relative with forward slashes when inside the root. */
function displayPath(siteRoot: string, path: string): string {
  const inside = relative(siteRoot, path);
  if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return path;
  return inside.split(sep).join("/");
}

/** The record date: an explicit date, SOURCE_DATE_EPOCH, or undefined. Never the wall clock. */
function recordDate(date: string | Date | undefined): string | undefined {
  if (date instanceof Date) return date.toISOString();
  if (typeof date === "string") return date;
  const epoch = process.env.SOURCE_DATE_EPOCH;
  if (epoch === undefined || epoch === "") return undefined;
  const seconds = Number(epoch);
  if (!Number.isFinite(seconds)) return undefined;
  return new Date(seconds * 1000).toISOString();
}

/** The audit line for one changed file. */
function auditLine(file: PlannedFile, transaction: EditTransaction, date: string | undefined): string {
  return formatEditAudit(
    createEditAudit({
      outcome: "applied",
      plan: {
        file: file.file,
        span: {
          line: file.firstSpan.line,
          column: file.firstSpan.column,
          endLine: file.firstSpan.endLine,
          endColumn: file.firstSpan.endColumn,
        },
        beforeHash: file.beforeHash,
        afterHash: file.afterHash,
      },
      ...(date === undefined ? {} : { date }),
    }),
  );
}

/** Reads a text file, returning "" when it does not exist. */
async function readOptional(path: string): Promise<{ readonly text: string; readonly exists: boolean }> {
  try {
    return { text: await readFile(path, "utf8"), exists: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { text: "", exists: false };
    throw error;
  }
}

/** The aggregate diff of every planned file, sorted by path. */
function aggregateDiff(files: readonly PlannedFile[]): string {
  return files.map((file) => unifiedDiff(file.before, file.after, file.file)).join("");
}

/** The result shared by a dry run and an applied transaction. */
function resultOf(
  siteRoot: string,
  transaction: EditTransaction,
  planned: Planned,
  extra: { readonly receipt?: string; readonly proof?: string; readonly audit?: readonly string[]; readonly diff?: string },
): EditTransactionResult {
  return {
    dryRun: extra.diff !== undefined,
    applied: extra.diff === undefined,
    id: transaction.id,
    task: transaction.task.id,
    siteRoot,
    files: planned.files.map((file) => ({
      file: file.file,
      beforeHash: file.beforeHash,
      afterHash: file.afterHash,
      spans: file.spans.map((span) => ({
        ...(span.file === undefined ? {} : { file: span.file }),
        line: span.line,
        column: span.column,
        endLine: span.endLine,
        endColumn: span.endColumn,
      })),
    })),
    checks: planned.checks,
    ...(extra.receipt === undefined ? {} : { receipt: extra.receipt }),
    ...(extra.proof === undefined ? {} : { proof: extra.proof }),
    ...(extra.audit === undefined ? {} : { audit: extra.audit }),
    ...(extra.diff === undefined ? {} : { diff: extra.diff }),
  };
}

/**
 * Checks the whole transaction and, unless `dryRun`, commits every source file, the proof, the
 * audit lines, and the receipt as one all-or-nothing set. A dry run acquires no reservation and
 * writes nothing.
 */
export async function applyEditTransaction(options: ApplyEditTransactionOptions): Promise<EditTransactionResult> {
  const siteRoot = resolve(options.siteRoot);
  const transaction = options.transaction;
  const custom = options.customInvariants ?? [];

  if (options.dryRun === true) {
    const planned = await planTransaction(siteRoot, transaction, custom);
    return resultOf(siteRoot, transaction, planned, { diff: aggregateDiff(planned.files) });
  }

  const intents = intentsOf(transaction.scope);
  let held: readonly HeldIntent[] = [];
  if (intents.length > 0) {
    try {
      held = await reserveIntents({ siteRoot, task: transaction.task.id, intents });
    } catch (error) {
      if (error instanceof IntentLockError) {
        throw new EditTransactionError(
          "edit.transaction-conflict",
          error.message,
          false,
          {
            conflicts: error.conflicts.map((conflict) =>
              conflictOf("intent-lock", transaction.task.id, conflict.message, {
                otherTask: conflict.otherTask,
                options: ["rebase", "approve"],
              }),
            ),
          },
        );
      }
      throw error;
    }
  }

  try {
    const planned = await planTransaction(siteRoot, transaction, custom);
    const date = recordDate(options.date);
    const receiptPath = resolve(siteRoot, options.receipt);
    const proofPath = options.proof === undefined ? `${receiptPath}.proof.json` : resolve(siteRoot, options.proof);
    const auditPath = options.audit === undefined ? undefined : resolve(siteRoot, options.audit);

    let proofText: string;
    try {
      proofText = formatProof(
        createProof({
          siteRoot,
          files: planned.files.map((file) => file.file),
          before: Object.fromEntries(planned.files.map((file) => [file.file, file.before])),
          after: Object.fromEntries(planned.files.map((file) => [file.file, file.after])),
          spans: Object.fromEntries(planned.files.map((file) => [file.file, file.spans])),
          ...(date === undefined ? {} : { date }),
        }),
      );
    } catch (error) {
      throw new EditTransactionError(
        "edit.transaction-write-failed",
        `the proof cannot be built: ${reasonOf(error)}; nothing was written.`,
        false,
      );
    }

    const artifacts: TransactionArtifact[] = planned.files.map((file) => ({
      path: file.target,
      label: file.file,
      content: file.after,
      expectedBeforeHash: file.beforeHash,
    }));

    artifacts.push({ path: proofPath, label: displayPath(siteRoot, proofPath), content: proofText });

    const auditIds: string[] = [];
    if (auditPath !== undefined) {
      let existing: { readonly text: string; readonly exists: boolean };
      try {
        existing = await readOptional(auditPath);
      } catch (error) {
        throw new EditTransactionError(
          "edit.transaction-write-failed",
          `${displayPath(siteRoot, auditPath)}: the audit ledger cannot be read: ${reasonOf(error)}; nothing was written.`,
          false,
        );
      }
      if (existing.text !== "" && !existing.text.endsWith("\n")) {
        throw new EditTransactionError(
          "edit.transaction-write-failed",
          `${displayPath(siteRoot, auditPath)}: the audit ledger does not end with a line feed; refusing to append to a damaged ledger; nothing was written.`,
          false,
        );
      }
      let ledger = existing.text;
      const lines = new Set(existing.text.split("\n"));
      for (const file of planned.files) {
        const line = auditLine(file, transaction, date);
        const id = (JSON.parse(line) as { id: string }).id;
        auditIds.push(id);
        if (!lines.has(line.slice(0, -1))) {
          ledger += line;
          lines.add(line.slice(0, -1));
        }
      }
      artifacts.push({
        path: auditPath,
        label: displayPath(siteRoot, auditPath),
        content: ledger,
        expectedBeforeHash: existing.exists ? hashSource(existing.text) : null,
      });
    }

    const receipt: EditTransactionReceipt = {
      version: 1,
      id: transaction.id,
      task: transaction.task,
      snapshot: transaction.snapshot,
      ...(transaction.preconditions.commit === undefined ? {} : { sourceCommit: transaction.preconditions.commit }),
      proof: displayPath(siteRoot, proofPath),
      audit: auditIds,
      files: planned.files.map((file) => ({
        file: file.file,
        beforeHash: file.beforeHash,
        afterHash: file.afterHash,
        spans: file.spans.map((span) => ({
          ...(span.file === undefined ? {} : { file: span.file }),
          line: span.line,
          column: span.column,
          endLine: span.endLine,
          endColumn: span.endColumn,
        })),
        before: file.before,
      })),
      invariants: transaction.invariants.map((invariant) => invariant.id),
      ...(date === undefined ? {} : { date }),
    };

    let priorReceipt: { readonly text: string; readonly exists: boolean };
    try {
      priorReceipt = await readOptional(receiptPath);
    } catch (error) {
      throw new EditTransactionError(
        "edit.transaction-write-failed",
        `${displayPath(siteRoot, receiptPath)}: the receipt cannot be read: ${reasonOf(error)}; nothing was written.`,
        false,
      );
    }
    artifacts.push({
      path: receiptPath,
      label: displayPath(siteRoot, receiptPath),
      content: `${JSON.stringify(receipt, null, 2)}\n`,
      expectedBeforeHash: priorReceipt.exists ? hashSource(priorReceipt.text) : null,
    });

    try {
      await commitArtifacts(artifacts, options.transactionHooks);
    } catch (error) {
      if (error instanceof TransactionError) {
        if (error.code === "stale-input") {
          const file = error.path ?? "the transaction";
          throw new EditTransactionError(
            "edit.transaction-conflict",
            `${file}: the file changed before it could be written; nothing was written.`,
            false,
            {
              conflicts: [
                conflictOf("stale-file", transaction.task.id, `${file}: the file changed before it could be written; rebase it.`, {
                  ...(error.path === undefined ? {} : { file: error.path }),
                }),
              ],
            },
          );
        }
        throw new EditTransactionError(
          "edit.transaction-write-failed",
          error.message,
          false,
        );
      }
      throw new EditTransactionError(
        "edit.transaction-write-failed",
        `committing the transaction failed: ${reasonOf(error)}; nothing was written.`,
        false,
      );
    }

    return resultOf(siteRoot, transaction, planned, {
      receipt: displayPath(siteRoot, receiptPath),
      proof: displayPath(siteRoot, proofPath),
      ...(auditPath === undefined ? {} : { audit: auditIds }),
    });
  } finally {
    if (held.length > 0) await releaseIntents(siteRoot, held);
  }
}

/** One patch relocation the rebase made. */
export interface RebaseMove {
  readonly file: string;
  readonly from: EditTransactionSpan;
  readonly to: EditTransactionSpan;
}

/** A rebased transaction, its confidence, and the preview of the result. */
export interface RebasedEditTransaction {
  readonly transaction: EditTransaction;
  /** `exact` means every patch still matches its file and span; anything else needs approval. */
  readonly confidence: "exact" | "low";
  /** Every span the rebase moved, in file order. */
  readonly moves: readonly RebaseMove[];
  /** The aggregate diff of the rebased result. */
  readonly diff: string;
}

/** Every UTF-16 offset where `needle` starts in `text`. */
function occurrences(text: string, needle: string): number[] {
  if (needle === "") return [];
  const found: number[] = [];
  let index = text.indexOf(needle);
  while (index !== -1) {
    found.push(index);
    index = text.indexOf(needle, index + needle.length);
  }
  return found;
}

/** The span of a UTF-16 range, or undefined when the range cannot be named. */
function spanOfOffsets(source: string, start: number, end: number): EditTransactionSpan | undefined {
  if (end <= start || source[end - 1] === "\n") return undefined;
  const beforeStart = source.slice(0, start);
  const beforeEnd = source.slice(0, end);
  const line = 1 + (beforeStart.match(/\n/g)?.length ?? 0);
  const endLine = 1 + (beforeEnd.match(/\n/g)?.length ?? 0);
  const column = Array.from(beforeStart.slice(beforeStart.lastIndexOf("\n") + 1)).length + 1;
  const endColumn = Array.from(beforeEnd.slice(beforeEnd.lastIndexOf("\n") + 1)).length;
  return { line, column, endLine, endColumn };
}

/** The reason a rebase could not place a patch. */
function rebaseConflict(
  kind: "rebase-missing" | "rebase-ambiguous",
  task: string,
  file: string,
  message: string,
): EditTransactionError {
  return new EditTransactionError(
    "edit.transaction-conflict",
    message,
    false,
    {
      conflicts: [
        conflictOf(kind, task, message, {
          file,
          options: ["resolve"],
        }),
      ],
    },
  );
}

/**
 * Relocates a transaction onto the bytes that are on disk now (#1174). A patch whose expected text
 * is still at its span keeps it; one whose text moved is moved to its unique new occurrence. A text
 * that vanished or appears more than once cannot be rebased. Any change to the source, even one
 * outside the span, marks the result low confidence: it needs `approve` before it can be applied.
 */
export async function rebaseEditTransaction(options: {
  readonly siteRoot: string;
  readonly transaction: EditTransaction;
  readonly approve?: boolean;
}): Promise<RebasedEditTransaction> {
  const siteRoot = resolve(options.siteRoot);
  const transaction = options.transaction;
  const realRoot = await realRootOf(siteRoot);
  const files: EditTransactionFile[] = [];
  const snapshotFiles: Record<string, string> = {};
  const moves: RebaseMove[] = [];
  let low = false;

  for (const entry of transaction.patches) {
    const target = await targetOf(siteRoot, realRoot, entry.file, transaction.task.id);
    let source: string;
    try {
      source = await readFile(target.real, "utf8");
    } catch (error) {
      throw rebaseConflict(
        "rebase-missing",
        transaction.task.id,
        entry.file,
        `${entry.file}: the file cannot be read: ${reasonOf(error)}; the transaction cannot be rebased.`,
      );
    }
    const hash = hashSource(source);
    snapshotFiles[entry.file] = hash;
    const patches: EditTransactionPatch[] = [];
    for (const patch of entry.patches) {
      const original = patch.span;
      let currentText: string | undefined;
      try {
        currentText = sliceBySpan(source, original);
      } catch {
        currentText = undefined;
      }
      if (patch.expected === undefined) {
        if (patch.beforeHash?.toLowerCase() !== hash) {
          throw rebaseConflict(
            "rebase-missing",
            transaction.task.id,
            entry.file,
            `${entry.file}: a patch has no expected text and its source changed; it cannot be rebased.`,
          );
        }
        patches.push({ ...patch, beforeHash: hash });
        continue;
      }

      if (currentText === patch.expected) {
        if (patch.beforeHash?.toLowerCase() !== hash) low = true;
        patches.push({ ...patch, beforeHash: hash });
        continue;
      }

      const offsets = occurrences(source, patch.expected);
      if (offsets.length === 0) {
        throw rebaseConflict(
          "rebase-missing",
          transaction.task.id,
          entry.file,
          `${entry.file}: the patch's expected text no longer appears; it cannot be rebased.`,
        );
      }
      if (offsets.length > 1) {
        throw rebaseConflict(
          "rebase-ambiguous",
          transaction.task.id,
          entry.file,
          `${entry.file}: the patch's expected text appears ${offsets.length} times; the destination is ambiguous.`,
        );
      }
      const start = offsets[0]!;
      const span = spanOfOffsets(source, start, start + patch.expected.length);
      if (span === undefined) {
        throw rebaseConflict(
          "rebase-missing",
          transaction.task.id,
          entry.file,
          `${entry.file}: the patch's new span cannot be represented; it cannot be rebased.`,
        );
      }
      const next = { ...span, ...(original.file === undefined ? {} : { file: original.file }) };
      moves.push({ file: entry.file, from: original, to: next });
      low = true;
      patches.push({ ...patch, span: next, beforeHash: hash });
    }
    files.push({ file: entry.file, patches });
  }

  if (low && options.approve !== true) {
    throw new EditTransactionError(
      "edit.transaction-approval-required",
      `the transaction can be rebased, but its source changed since it was planned; pass --approve to apply the low-confidence result.`,
      false,
      {
        conflicts: [
          conflictOf("stale-snapshot", transaction.task.id, "the rebased transaction needs approval because the source changed.", {
            options: ["approve", "rebase"],
          }),
        ],
      },
    );
  }

  const snapshot = { files: snapshotFiles, id: transactionSnapshotId(snapshotFiles) };
  const base = {
    version: transaction.version,
    task: transaction.task,
    snapshot,
    patches: files,
    invariants: transaction.invariants,
    preconditions: transaction.preconditions,
    scope: transaction.scope,
  };
  const rebased: EditTransaction = { ...base, id: transactionIdOf(base) };
  // Apply the rebased set in memory to produce the preview and prove it is valid.
  const previewFiles: FilePatches[] = [];
  for (const entry of files) {
    const target = await targetOf(siteRoot, realRoot, entry.file, transaction.task.id);
    const source = await readFile(target.real, "utf8");
    previewFiles.push({
      file: entry.file,
      source,
      patches: entry.patches.map((patch) => ({
        span: patch.span,
        replacement: patch.replacement,
        ...(patch.expected === undefined ? {} : { expected: patch.expected }),
        ...(patch.beforeHash === undefined ? {} : { beforeHash: patch.beforeHash }),
      })),
    });
  }
  let patched: readonly PatchedFile[];
  try {
    patched = applyFilePatches(previewFiles, { requireHash: true, requireExpected: true });
  } catch (error) {
    if (error instanceof PatchError) {
      throw new EditTransactionError(
        "edit.transaction-conflict",
        `the rebased transaction is refused: ${error.message}`,
        false,
        {
          conflicts: [
            conflictOf("stale-file", transaction.task.id, `the rebased transaction is refused: ${error.code}.`, {
              ...(error.span.file === undefined ? {} : { file: error.span.file }),
              spans: [error.span],
            }),
          ],
        },
      );
    }
    throw error;
  }
  return {
    transaction: rebased,
    confidence: low ? "low" : "exact",
    moves,
    diff: patched.map((file) => unifiedDiff(file.before, file.after, file.file)).join(""),
  };
}

/** Validates a receipt read from disk. */
function receiptOf(value: unknown): EditTransactionReceipt {
  if (!isObject(value) || value.version !== 1 || typeof value.id !== "string" || !Array.isArray(value.files)) {
    throw new EditTransactionError("edit.rollback-invalid", "the receipt is not a version 1 transaction receipt.", false);
  }
  const files = value.files;
  for (const file of files) {
    if (
      !isObject(file) ||
      !isEditAuditPath(file.file) ||
      !isHash(file.beforeHash) ||
      !isHash(file.afterHash) ||
      typeof file.before !== "string" ||
      hashSource(file.before) !== file.beforeHash
    ) {
      throw new EditTransactionError(
        "edit.rollback-invalid",
        "the receipt has a file entry whose path, hashes, or before bytes do not agree.",
        false,
      );
    }
  }
  if (!isObject(value.task) || typeof value.task.id !== "string") {
    throw new EditTransactionError("edit.rollback-invalid", "the receipt has no task id.", false);
  }
  if (!isObject(value.snapshot) || !isObject(value.snapshot.files)) {
    throw new EditTransactionError("edit.rollback-invalid", "the receipt has no snapshot.", false);
  }
  return value as unknown as EditTransactionReceipt;
}

/** Reads a receipt file and validates it. */
export async function readEditReceipt(path: string): Promise<EditTransactionReceipt> {
  let text: string;
  try {
    text = await readFile(resolve(path), "utf8");
  } catch (error) {
    throw new EditTransactionError(
      "edit.rollback-invalid",
      `${path}: cannot read the receipt: ${reasonOf(error)}.`,
      true,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new EditTransactionError(
      "edit.rollback-invalid",
      `${path}: the receipt is not JSON: ${reasonOf(error)}.`,
      true,
    );
  }
  return receiptOf(value);
}

/**
 * Restores only the files a receipt names, and only when they still hold the receipt's `afterHash`.
 * A file changed by a later independent edit is preserved and reported, never overwritten.
 */
export async function rollbackEditTransaction(options: {
  readonly siteRoot: string;
  readonly receipt: string | EditTransactionReceipt;
  readonly transactionHooks?: TransactionHooks;
}): Promise<EditRollbackResult> {
  const siteRoot = resolve(options.siteRoot);
  const receipt = typeof options.receipt === "string" ? await readEditReceipt(options.receipt) : receiptOf(options.receipt);
  const realRoot = await realRootOf(siteRoot);
  const restored: string[] = [];
  const preserved: string[] = [];
  const artifacts: TransactionArtifact[] = [];

  const files = [...receipt.files].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  for (const file of files) {
    const target = await targetOf(siteRoot, realRoot, file.file, receipt.task.id);
    let current: string;
    try {
      current = await readFile(target.real, "utf8");
    } catch {
      preserved.push(file.file);
      continue;
    }
    const hash = hashSource(current);
    if (hash === file.afterHash) {
      artifacts.push({
        path: target.real,
        label: file.file,
        content: file.before,
        expectedBeforeHash: file.afterHash,
      });
      restored.push(file.file);
    } else {
      preserved.push(file.file);
    }
  }

  if (artifacts.length > 0) {
    try {
      await commitArtifacts(artifacts, options.transactionHooks);
    } catch (error) {
      throw new EditTransactionError(
        "edit.transaction-write-failed",
        `the rollback failed: ${error instanceof Error ? error.message : String(error)}; check the tree.`,
        false,
      );
    }
  }
  return { id: receipt.id, restored, preserved };
}
