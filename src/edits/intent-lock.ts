/**
 * Semantic edit reservations (#1168).
 *
 * A task reserves the pages, block ids, symbols, and records it intends to change. The reservation
 * lives in one small lock file per reference, so two tasks that edit different blocks of the same
 * file both proceed, while two tasks that reserve the same block conflict before either writes.
 *
 * Reservations are advisory across processes and are always removed by the writer; a reservation
 * left by a dead process is recovered on the next attempt, and one no process can claim expires
 * after {@link DEFAULT_STALE_MS}. The file hash preconditions in `edit-transaction.ts` remain the
 * final guard against a stale write, so a lost lock cannot turn into an unchecked edit.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EditTransactionScope } from "../contracts/edit-transaction.ts";

/** The semantic reference kinds a task may reserve. */
export type IntentKind = "page" | "block" | "symbol" | "record";

/** One reservation: a kind and the value it names. */
export interface Intent {
  readonly kind: IntentKind;
  readonly value: string;
}

/** One reservation this process holds. */
export interface HeldIntent extends Intent {
  readonly task: string;
  readonly path: string;
}

/** Two tasks asking for the same semantic reference. */
export interface IntentConflict {
  readonly kind: IntentKind;
  readonly value: string;
  readonly task: string;
  readonly otherTask: string;
  readonly message: string;
}

/** Why a reservation was refused. */
export class IntentLockError extends Error {
  readonly conflicts: readonly IntentConflict[];

  constructor(conflicts: readonly IntentConflict[]) {
    super(conflicts.map((conflict) => conflict.message).join("; "));
    this.name = "IntentLockError";
    this.conflicts = conflicts;
  }
}

/** How long a reservation no live process owns is kept before it is recovered. */
export const DEFAULT_STALE_MS = 15 * 60 * 1000;

/** The lock folder inside the site root. It exists only while a reservation is held. */
function lockDir(siteRoot: string): string {
  return join(siteRoot, ".mizzen", "transaction-locks");
}

/** The lock file for one reference, hashed so any value is a safe file name. */
function lockPath(siteRoot: string, intent: Intent): string {
  const key = createHash("sha256").update(`${intent.kind}\0${intent.value}`).digest("hex").slice(0, 40);
  return join(lockDir(siteRoot), `${key}.lock`);
}

/** The deterministic reservations a scope asks for, sorted and de-duplicated. */
export function intentsOf(scope: EditTransactionScope): Intent[] {
  const seen = new Set<string>();
  const intents: Intent[] = [];
  const add = (kind: IntentKind, values: readonly string[]): void => {
    for (const value of values) {
      const key = `${kind}\0${value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      intents.push({ kind, value });
    }
  };
  add("page", scope.pages);
  add("block", scope.blocks);
  add("symbol", scope.symbols);
  add("record", scope.records);
  return intents.sort(
    (a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.value < b.value ? -1 : a.value > b.value ? 1 : 0),
  );
}

/** Whether a process id still exists. `EPERM` means it exists and belongs to someone else. */
function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The reservation a lock file holds, or undefined when it cannot be read. */
async function readLock(path: string): Promise<{ task?: string; pid?: number } | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof value !== "object" || value === null) return undefined;
    const record = value as { task?: unknown; pid?: unknown };
    return {
      ...(typeof record.task === "string" ? { task: record.task } : {}),
      ...(typeof record.pid === "number" ? { pid: record.pid } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Removes a lock that no live process owns, or one older than the stale limit. */
async function recover(path: string, staleMs: number): Promise<boolean> {
  const held = await readLock(path);
  if (held?.pid !== undefined && isAlive(held.pid)) return false;
  if (held?.pid === undefined) {
    try {
      const info = await stat(path);
      if (Date.now() - info.mtimeMs < staleMs) return false;
    } catch {
      return true;
    }
  }
  try {
    await unlink(path);
    return true;
  } catch {
    return true;
  }
}

/** Removes the folders this module created, never a non-empty `.mizzen`. */
async function discardFolders(siteRoot: string): Promise<void> {
  for (const folder of [lockDir(siteRoot), join(siteRoot, ".mizzen")]) {
    try {
      await rmdir(folder);
    } catch {
      // A folder that gained another file, or was already removed, is not ours to delete.
    }
  }
}

/**
 * Reserves every semantic reference in `intents` for `task`, sorted so two tasks always take the
 * same order and cannot deadlock. A reference held by another live task refuses the whole set and
 * releases the ones already taken. A reference held by the same task is re-entrant.
 */
export async function reserveIntents(options: {
  readonly siteRoot: string;
  readonly task: string;
  readonly intents: readonly Intent[];
  readonly staleMs?: number;
}): Promise<readonly HeldIntent[]> {
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  await mkdir(lockDir(options.siteRoot), { recursive: true });

  const held: HeldIntent[] = [];
  const conflicts: IntentConflict[] = [];
  const ordered = [...options.intents].sort(
    (a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.value < b.value ? -1 : a.value > b.value ? 1 : 0),
  );

  for (const intent of ordered) {
    const path = lockPath(options.siteRoot, intent);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await writeFile(
          path,
          `${JSON.stringify({ version: 1, task: options.task, kind: intent.kind, value: intent.value, pid: process.pid })}\n`,
          { encoding: "utf8", flag: "wx" },
        );
        held.push({ ...intent, task: options.task, path });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new IntentLockError([
            {
              ...intent,
              task: options.task,
              otherTask: "unknown",
              message: `${intent.kind} "${intent.value}": the reservation cannot be written; nothing was changed.`,
            },
          ]);
        }
      }

      const existing = await readLock(path);
      if (existing?.task === options.task) {
        held.push({ ...intent, task: options.task, path });
        break;
      }
      if (attempt === 0 && (await recover(path, staleMs))) continue;

      const otherTask = existing?.task ?? "unknown";
      conflicts.push({
        ...intent,
        task: options.task,
        otherTask,
        message: `${intent.kind} "${intent.value}" is reserved by task ${otherTask}; task ${options.task} cannot reserve it.`,
      });
      break;
    }
  }

  if (conflicts.length > 0) {
    await releaseIntents(options.siteRoot, held);
    throw new IntentLockError(conflicts);
  }
  return held;
}

/** Releases only the reservations this process holds for the same task. */
export async function releaseIntents(siteRoot: string, held: readonly HeldIntent[]): Promise<void> {
  for (const intent of [...held].reverse()) {
    const existing = await readLock(intent.path);
    if (existing?.task === intent.task) {
      try {
        await unlink(intent.path);
      } catch {
        // An already-removed reservation needs no second removal.
      }
    }
  }
  await discardFolders(siteRoot);
}
