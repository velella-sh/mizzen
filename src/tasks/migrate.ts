/**
 * Explicit migration from older task documents to the current contract version.
 *
 * Version 1 is read as-is. Version 0 used `budget.maxTokens`, `maxToolCalls`, and
 * `maxMilliseconds`, and could omit permissions, acceptance criteria, and the idempotency key; the
 * migration renames the limits, fills the permissions default, adds an explicit human-review
 * criterion when none was recorded, and derives a stable key from the content. Every migrated
 * document is validated as version 1, so a broken source is refused rather than half-written.
 *
 * {@link migrateTaskFile} reads, migrates, and writes; the write goes to a temporary file beside
 * the target and one rename puts it in place only after migration succeeded. A failed migration
 * therefore leaves the source file byte-identical, whether the target is the source or another
 * path.
 */
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TaskContract, TaskProblem } from "../contracts/task.ts";
import { canonicalJson, sha256 } from "../data/lock.ts";
import { parseTaskContract } from "./contract.ts";

/** The current task document version. */
export const TASK_DOCUMENT_VERSION = 1;

/** What migration needs besides the document. */
export interface TaskMigrateOptions {
  /** The ids of checks that exist, when the source names any. */
  readonly checks?: readonly string[];
}

/** The result of migrating a decoded document. */
export interface TaskMigrateResult {
  /** The current contract; present exactly when `problems` is empty. */
  readonly contract?: TaskContract;
  /** Why the document could not be migrated; empty on success. */
  readonly problems: readonly TaskProblem[];
}

/** What {@link migrateTaskFile} needs. */
export interface TaskMigrateFileOptions extends TaskMigrateOptions {
  /** Where to write the migrated document. Default: the source path, replaced atomically. */
  readonly target?: string;
}

/** The result of migrating a file. */
export interface TaskMigrateFileResult extends TaskMigrateResult {
  /** The file that now holds the migrated document, when the write succeeded. */
  readonly written?: string;
}

/** Migrates a decoded task document. Supported versions: 0, migrated; 1, read as-is. */
export function migrateTaskDocument(
  value: unknown,
  options: TaskMigrateOptions = {},
): TaskMigrateResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      problems: [
        { path: "", code: "task.malformed", message: "A task document must be a JSON object." },
      ],
    };
  }

  const version = (value as { version?: unknown }).version;
  if (version === TASK_DOCUMENT_VERSION) return parseTaskContract(value, options);
  if (version === 0) return migrateV0(value as Record<string, unknown>, options);

  return {
    problems: [
      {
        path: "/version",
        code: "task.version",
        message: `Only task document versions 0 and 1 can be read; found ${JSON.stringify(version)}.`,
      },
    ],
  };
}

/** Migrates one version-0 document: renamed limits, filled permissions, explicit review. */
function migrateV0(raw: Record<string, unknown>, options: TaskMigrateOptions): TaskMigrateResult {
  const budget = isObject(raw.budget) ? raw.budget : {};
  const snapshot = raw.snapshot;
  const goal = typeof raw.goal === "string" ? raw.goal : "";
  const idempotencyKey =
    typeof raw.idempotencyKey === "string" && raw.idempotencyKey.trim() !== ""
      ? raw.idempotencyKey
      : `legacy-${sha256(canonicalJson({ goal, snapshot })).slice(0, 16)}`;

  const candidate = {
    version: 1,
    idempotencyKey,
    goal: raw.goal,
    scope: raw.scope,
    snapshot,
    budget: {
      contextTokens: budget.maxTokens,
      toolCalls: budget.maxToolCalls,
      timeMs: budget.maxMilliseconds,
    },
    permissions: raw.permissions ?? { read: ["*"], write: [], check: [] },
    acceptance: raw.acceptance ?? [
      {
        id: "human-review",
        statement: "A person reviewed the migrated task because version 0 recorded no acceptance criteria.",
        review: true,
      },
    ],
  };

  return parseTaskContract(candidate, options);
}

/** True for a plain JSON object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads, migrates, and atomically writes one task file. */
export async function migrateTaskFile(
  source: string,
  options: TaskMigrateFileOptions = {},
): Promise<TaskMigrateFileResult> {
  let text: string;
  try {
    text = await readFile(source, "utf8");
  } catch (error) {
    return {
      problems: [
        {
          path: "",
          code: "task.read",
          message: `Cannot read \`${source}\`: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return {
      problems: [
        {
          path: "",
          code: "task.json",
          message: `\`${source}\` is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }

  const migrated = migrateTaskDocument(value, options);
  if (migrated.contract === undefined) return migrated;

  const target = options.target ?? source;
  const folder = dirname(target);
  await mkdir(folder, { recursive: true });
  const temporary = await mkdtemp(join(folder, ".task-migrate-"));
  try {
    const file = join(temporary, "task.json");
    await writeFile(file, `${JSON.stringify(migrated.contract, null, 2)}\n`);
    await rename(file, target);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }

  return { contract: migrated.contract, written: target, problems: [] };
}
