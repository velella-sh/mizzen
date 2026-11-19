/**
 * The deterministic half of the task contract: parse untrusted input into {@link TaskContract}, or
 * explain every way it is malformed.
 *
 * The shape is checked against `../../schema/task-contract.schema.json` with ajv; ajv's findings
 * become a JSON Pointer and a sentence that says what to write instead. Once the shape is valid,
 * the cross-field rules run: scope cannot be empty, a reference cannot repeat after trimming, an
 * acceptance criterion must name an existing check (when the caller supplies the check set) or
 * explicitly require human review, criterion ids are unique, and a supplied snapshot id must equal
 * the id derived from the four hashes. The parser fills permissions defaults and trims strings, so
 * a valid contract has one stable form: two runs on the same input give the same bytes.
 *
 * Parsing is local and synchronous: no network, no model, no clock, no file read. It never guesses
 * a snapshot id or an acceptance check: both are computed or refused.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { ErrorObject } from "ajv";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import type {
  TaskAcceptanceCriterion,
  TaskBudget,
  TaskContract,
  TaskParseResult,
  TaskPermissions,
  TaskProblem,
  TaskScope,
  TaskSnapshot,
} from "../contracts/task.ts";
import { snapshotIdOf } from "./identity.ts";
import { validateScopeReferences, type TaskReferenceIndex } from "./scope.ts";

/** The only task-contract version this parser accepts. */
export const TASK_CONTRACT_VERSION = 1;

/** What validation needs besides the document. */
export interface TaskParseOptions {
  /** The ids of checks that exist. A `check` criterion outside this set is refused. */
  readonly checks?: readonly string[];
  /** The known scope references. A kind left out is not checked. */
  readonly references?: TaskReferenceIndex;
}

// ajv is CommonJS: its default export is the class at run time, but its types name it.
const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;
const schema = JSON.parse(
  readFileSync(new URL("../../schema/task-contract.schema.json", import.meta.url), "utf8"),
) as object;
const validateShape = new Ajv2020({ strict: true, allErrors: true, verbose: true }).compile(schema);

/** A scope as validation leaves it, before the lists are filled. */
interface RawScope {
  readonly pages?: readonly string[];
  readonly blocks?: readonly string[];
  readonly collections?: readonly string[];
  readonly symbols?: readonly string[];
  readonly files?: readonly string[];
}

/** A snapshot as validation leaves it: the id may be absent. */
interface RawSnapshot {
  readonly content: string;
  readonly data: string;
  readonly config: string;
  readonly tooling: string;
  readonly id?: string;
}

/** A permissions object before the defaults are filled. */
interface RawPermissions {
  readonly read?: readonly string[];
  readonly write?: readonly string[];
  readonly check?: readonly string[];
}

/** One criterion as validation leaves it. */
interface RawCriterion {
  readonly id: string;
  readonly statement: string;
  readonly check?: string;
  readonly review?: true;
}

/** A contract as validation leaves it: optional fields are still optional. */
interface RawContract {
  readonly version: 1;
  readonly idempotencyKey: string;
  readonly goal: string;
  readonly scope: RawScope;
  readonly snapshot: RawSnapshot;
  readonly budget: TaskBudget;
  readonly permissions?: RawPermissions;
  readonly acceptance: readonly RawCriterion[];
}

/** What a missing field should have held, by field name. */
const MISSING_FIELD_HELP: Readonly<Record<string, string>> = {
  version: "Set `version` to 1, the only task-contract version.",
  idempotencyKey: "Give the registration a stable `idempotencyKey`.",
  goal: "Describe the task in `goal` as one sentence.",
  scope: "Name at least one page, block, collection, symbol, or file in `scope`.",
  snapshot: "Give the four SHA-256 input hashes in `snapshot`.",
  content: "Set `snapshot.content` to the SHA-256 of the effective content.",
  data: "Set `snapshot.data` to the SHA-256 of the effective data.",
  config: "Set `snapshot.config` to the SHA-256 of the effective site config.",
  tooling: "Set `snapshot.tooling` to the SHA-256 of the engine and tool versions.",
  budget: "Give `budget` all three limits: `contextTokens`, `toolCalls`, and `timeMs`.",
  contextTokens: "Set it to a non-negative whole number of estimated tokens.",
  toolCalls: "Set it to a non-negative whole number of tool calls.",
  timeMs: "Set it to a non-negative whole number of milliseconds.",
  acceptance: "Name at least one acceptance criterion in `acceptance`.",
};

/** Parses a task contract from an already-decoded JSON value such as `JSON.parse(text)`. */
export function parseTaskContract(value: unknown, options: TaskParseOptions = {}): TaskParseResult {
  if (!validateShape(value)) {
    return { problems: problemsFromAjv(validateShape.errors ?? [], value) };
  }
  return normalize(value as RawContract, options);
}

/** Fills defaults and checks the rules a single field cannot express. */
function normalize(raw: RawContract, options: TaskParseOptions): TaskParseResult {
  const problems: TaskProblem[] = [];
  const scope = scopeOf(raw.scope, problems);
  if (scope !== undefined && scope.pages.length + scope.blocks.length + scope.collections.length + scope.symbols.length + scope.files.length === 0) {
    problems.push({
      path: "/scope",
      code: "task.scope-empty",
      message: "A task scope needs at least one page, block, collection, symbol, or file.",
    });
  }

  const snapshot = snapshotOf(raw.snapshot, problems);
  const permissions = permissionsOf(raw.permissions, problems);
  const acceptance = acceptanceOf(raw.acceptance, options.checks, problems);

  if (scope !== undefined && options.references !== undefined) {
    problems.push(...validateScopeReferences(scope, options.references));
  }

  if (scope === undefined || snapshot === undefined || problems.length > 0) {
    return { problems };
  }

  return {
    contract: {
      version: TASK_CONTRACT_VERSION,
      idempotencyKey: raw.idempotencyKey.trim(),
      goal: raw.goal.trim(),
      scope,
      snapshot,
      budget: {
        contextTokens: raw.budget.contextTokens,
        toolCalls: raw.budget.toolCalls,
        timeMs: raw.budget.timeMs,
      },
      permissions,
      acceptance,
    },
    problems,
  };
}

/** The scope with all five lists present and trimmed. */
function scopeOf(raw: RawScope, problems: TaskProblem[]): TaskScope {
  return {
    pages: trimmed(raw.pages ?? [], "/scope/pages", problems),
    blocks: trimmed(raw.blocks ?? [], "/scope/blocks", problems),
    collections: trimmed(raw.collections ?? [], "/scope/collections", problems),
    symbols: trimmed(raw.symbols ?? [], "/scope/symbols", problems),
    files: trimmed(raw.files ?? [], "/scope/files", problems),
  };
}

/** The permissions with defaults filled and lists trimmed. */
function permissionsOf(raw: RawPermissions | undefined, problems: TaskProblem[]): TaskPermissions {
  return {
    read: trimmed(raw?.read ?? ["*"], "/permissions/read", problems),
    write: trimmed(raw?.write ?? [], "/permissions/write", problems),
    check: trimmed(raw?.check ?? [], "/permissions/check", problems),
  };
}

/** Trims a list and refuses a value that repeats an earlier one after trimming. */
function trimmed(
  values: readonly string[],
  prefix: string,
  problems: TaskProblem[],
): readonly string[] {
  const seen = new Set<string>();
  return values.map((value, index) => {
    const text = value.trim();
    if (seen.has(text)) {
      problems.push({
        path: `${prefix}/${index}`,
        code: "task.duplicate",
        message: `${whereOf(`${prefix}/${index}`)} repeats \`${text}\`; remove the duplicate.`,
      });
    }
    seen.add(text);
    return text;
  });
}

/** The criteria with every id unique and every check existing when a check set was supplied. */
function acceptanceOf(
  raw: readonly RawCriterion[],
  checks: readonly string[] | undefined,
  problems: TaskProblem[],
): readonly TaskAcceptanceCriterion[] {
  const known = checks === undefined ? undefined : new Set(checks);
  const seen = new Set<string>();

  return raw.map((criterion, index) => {
    if (seen.has(criterion.id)) {
      problems.push({
        path: `/acceptance/${index}/id`,
        code: "task.acceptance-duplicate",
        message: `Acceptance criterion id \`${criterion.id}\` is repeated; give each criterion a unique id.`,
      });
    }
    seen.add(criterion.id);

    const check = criterion.check?.trim();
    if (check !== undefined && known !== undefined && !known.has(check)) {
      const allowed = [...known].sort(byCodePoint).map((id) => `\`${id}\``).join(", ");
      problems.push({
        path: `/acceptance/${index}/check`,
        code: "task.acceptance-check-unknown",
        message: `\`${check}\` is not an existing check; use ${allowed === "" ? "an existing check" : `one of ${allowed}`} or set \`review: true\` to require human review.`,
      });
    }

    return {
      id: criterion.id,
      statement: criterion.statement.trim(),
      ...(check === undefined ? {} : { check }),
      ...(criterion.review === undefined ? {} : { review: true }),
    };
  });
}

/** The snapshot with its id verified or computed. */
function snapshotOf(raw: RawSnapshot, problems: TaskProblem[]): TaskSnapshot | undefined {
  const base = {
    content: raw.content,
    data: raw.data,
    config: raw.config,
    tooling: raw.tooling,
  };
  const id = snapshotIdOf(base);
  if (raw.id !== undefined && raw.id !== id) {
    problems.push({
      path: "/snapshot/id",
      code: "task.snapshot-id",
      message: `\`snapshot.id\` must be \`${id}\`, the SHA-256 of the four input hashes; remove the field to have it computed.`,
    });
    return undefined;
  }
  return { ...base, id };
}

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The JSON Pointer of an ajv finding, with a missing key or duplicate index appended. */
function pointerOf(error: ErrorObject): string {
  if (error.keyword === "required") return joinPointer(error.instancePath, String(error.params.missingProperty ?? ""));
  if (error.keyword === "uniqueItems" && typeof error.params.i === "number") {
    return joinPointer(error.instancePath, String(error.params.i));
  }
  return error.instancePath;
}

/** JSON Pointer escaping for `~` and `/`. */
function joinPointer(base: string, segment: string): string {
  const escaped = segment.replace(/~/g, "~0").replace(/\//g, "~1");
  return base === "" ? `/${escaped}` : `${base}/${escaped}`;
}

/** The value at a pointer in the document, for naming its type or explaining a choice. */
function valueAt(root: unknown, pointer: string): unknown {
  let value: unknown = root;
  for (const raw of pointer.split("/").slice(1)) {
    const segment = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(value)) {
      value = value[Number(segment)];
    } else if (typeof value === "object" && value !== null) {
      value = (value as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return value;
}

/** A value's type as a sentence fragment, such as `a string` or `an array`. */
function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  switch (typeof value) {
    case "string":
      return "a string";
    case "number":
      return Number.isInteger(value) ? "an integer" : "a number";
    case "boolean":
      return "a boolean";
    case "object":
      return "an object";
    default:
      return `a ${typeof value}`;
  }
}

/** The expected JSON type as a sentence fragment. */
function expectedType(type: unknown): string {
  switch (type) {
    case "integer":
      return "an integer";
    case "number":
      return "a number";
    case "string":
      return "a string";
    case "boolean":
      return "a boolean";
    case "array":
      return "an array";
    case "object":
      return "an object";
    case "null":
      return "null";
    default:
      return String(type);
  }
}

/** The document or value a message is about. */
function whereOf(pointer: string): string {
  return pointer === "" ? "The contract" : `\`${pointer}\``;
}

/** What a pattern-constrained field should look like, so the message says what to write. */
function formatHint(pointer: string): string {
  if (pointer.endsWith("/version")) return "1, the only task-contract version";
  if (pointer.includes("/snapshot/")) return "a 64-character lowercase SHA-256 digest";
  if (pointer.endsWith("/idempotencyKey")) return "a non-empty key";
  if (pointer.includes("/scope/blocks/")) return "a block id such as `install-steps`";
  if (pointer.includes("/scope/collections/")) return "a collection name such as `blog`";
  if (pointer.includes("/scope/symbols/")) return "an exported name such as `build` or `Site.page`";
  if (pointer.includes("/scope/files/")) return "a relative file path with forward slashes";
  if (pointer.endsWith("/acceptance")) return "a criterion with `check` or `review: true`";
  return "a non-empty string";
}

/**
 * Translates ajv findings into stable codes, pointers, and sentences. Errors under a `oneOf`
 * failure are folded into that failure: the branch's own `required` errors describe alternatives,
 * not missing fields a caller can act on.
 */
function problemsFromAjv(errors: readonly ErrorObject[], root: unknown): readonly TaskProblem[] {
  const branchPaths = new Set(errors.filter((error) => error.keyword === "oneOf").map((error) => error.instancePath));
  return errors
    .filter(
      (error) =>
        error.keyword === "oneOf" ||
        ![...branchPaths].some((path) =>
          error.instancePath === path ? true : error.instancePath.startsWith(`${path}/`),
        ),
    )
    .map((error) => problemFromAjv(error, root));
}

/** Translates one ajv finding into a stable code, a pointer, and a sentence to act on. */
function problemFromAjv(error: ErrorObject, root: unknown): TaskProblem {
  const path = pointerOf(error);

  switch (error.keyword) {
    case "required": {
      const key = String(error.params.missingProperty ?? "");
      const help = MISSING_FIELD_HELP[key];
      return {
        path,
        code: "task.missing",
        message: `Missing required field \`${key}\`.${help === undefined ? "" : ` ${help}`}`,
      };
    }
    case "additionalProperties": {
      const key = String(error.params.additionalProperty ?? "");
      const allowed = Object.keys(
        (error.parentSchema?.properties ?? {}) as Record<string, unknown>,
      ).sort(byCodePoint);
      return {
        path: joinPointer(error.instancePath, key),
        code: "task.unknown-key",
        message: `Unknown field \`${key}\`. Use one of: ${allowed.map((name) => `\`${name}\``).join(", ")}.`,
      };
    }
    case "oneOf": {
      const value = valueAt(root, path);
      const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
      const both = record.check !== undefined && record.review !== undefined;
      return {
        path,
        code: "task.acceptance-shape",
        message: both
          ? `${whereOf(path)} names both \`check\` and \`review\`; keep exactly one, because a check proves the criterion and a review requires a person.`
          : `${whereOf(path)} needs exactly one of \`check\` (the id of an existing check) or \`review: true\` (explicit human review).`,
      };
    }
    case "type":
      return {
        path,
        code: "task.type",
        message: `${whereOf(path)} must be ${expectedType(error.params.type)}; found ${typeOf(valueAt(root, path))}.`,
      };
    case "const":
      return {
        path,
        code: path === "/version" ? "task.version" : "task.const",
        message:
          path === "/version"
            ? "Only task-contract version 1 is supported."
            : `${whereOf(path)} must be ${JSON.stringify(error.params.allowedValue)}.`,
      };
    case "enum": {
      const allowed = (error.params.allowedValues as readonly unknown[] | undefined) ?? [];
      return {
        path,
        code: "task.enum",
        message: `${whereOf(path)} must be one of: ${allowed.map((value) => `\`${String(value)}\``).join(", ")}.`,
      };
    }
    case "pattern":
      return {
        path,
        code: "task.format",
        message: `${whereOf(path)} must be ${formatHint(path)}.`,
      };
    case "minimum":
      return {
        path,
        code: "task.range",
        message: `${whereOf(path)} must be at least ${String(error.params.limit)}.`,
      };
    case "maximum":
      return {
        path,
        code: "task.range",
        message: `${whereOf(path)} must be at most ${String(error.params.limit)}.`,
      };
    case "maxLength":
      return {
        path,
        code: "task.range",
        message: `${whereOf(path)} must have at most ${String(error.params.limit)} characters.`,
      };
    case "minLength":
    case "minItems":
      return {
        path,
        code: "task.empty",
        message: `${whereOf(path)} must not be empty.`,
      };
    case "maxItems":
      return {
        path,
        code: "task.range",
        message: `${whereOf(path)} must have at most ${String(error.params.limit)} entries.`,
      };
    case "uniqueItems": {
      const entries = valueAt(root, error.instancePath);
      const index = typeof error.params.i === "number" ? error.params.i : undefined;
      const value = Array.isArray(entries) && index !== undefined ? entries[index] : undefined;
      return {
        path,
        code: "task.duplicate",
        message:
          value === undefined
            ? `${whereOf(path)} must not repeat an entry.`
            : `${whereOf(path)} repeats \`${String(value)}\`; remove the duplicate.`,
      };
    }
    default:
      return {
        path,
        code: `task.${error.keyword}`,
        message: `${whereOf(path)} ${error.message ?? "is invalid"}.`,
      };
  }
}
