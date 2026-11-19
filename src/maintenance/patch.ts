/**
 * Accept a versioned patch from an external client (#1234), stop it when the source moved
 * (#1237), and tell a no-op from real work (#1240).
 *
 * The document is data, not instructions: a task id, a snapshot, per-file before hashes, span
 * replacements with the exact text they expect, and claims tied to acceptance criteria. Validation
 * is local and synchronous. Applying is also local: it patches strings in memory with the existing
 * `../edits/patch.ts` checks and never writes a file. A source that changed, disappeared, or was
 * replaced by a different snapshot is named and the task is marked `blocked` for rebase or review.
 */
import type { AccessPolicy } from "../contracts/permissions.ts";
import type { TaskDocument, TaskProblem } from "../contracts/task.ts";
import type {
  MaintenanceClaim,
  MaintenanceNoop,
  MaintenanceObservations,
  MaintenancePatch,
  MaintenancePatchEdit,
  MaintenancePatchFile,
  MaintenancePatchResult,
  MaintenanceProblem,
  MaintenanceStaleResult,
  MaintenanceStaleSource,
} from "../contracts/index.ts";
import { canonicalJson, sha256 } from "../data/lock.ts";
import { unifiedDiff } from "../diff/unified.ts";
import { applyFilePatches, EditFileError, hashSource, PatchError, sliceBySpan, type FilePatches } from "../edits/patch.ts";
import { writeRule } from "../permissions/evaluate.ts";
import { transitionTask } from "../tasks/lifecycle.ts";

const HASH = /^[0-9a-f]{64}$/u;

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** True for a non-empty relative path with forward slashes and no escape segment. */
export function safePatchPath(path: unknown): path is string {
  if (typeof path !== "string" || path === "") return false;
  if (path.includes("\\") || path.startsWith("/")) return false;
  return !path.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

/** True for a positive integer. */
function isPosition(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/** A problem at a JSON Pointer. */
function problem(path: string, code: string, message: string): MaintenanceProblem {
  return { path, code, message };
}

/** The parsed file, or every problem found in it. */
function fileOf(
  raw: unknown,
  index: number,
  problems: MaintenanceProblem[],
): MaintenancePatchFile | undefined {
  const path = `/files/${index}`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    problems.push(problem(path, "maintenance.patch-file", "A patch file must be an object."));
    return undefined;
  }
  const value = raw as Record<string, unknown>;
  if (!safePatchPath(value.path)) {
    problems.push(problem(`${path}/path`, "maintenance.patch-path", "A patch path must be relative with forward slashes and no `..` segment."));
    return undefined;
  }
  const filePath = value.path;
  if (typeof value.sha256 !== "string" || !HASH.test(value.sha256)) {
    problems.push(problem(`${path}/sha256`, "maintenance.patch-hash", "A patch file needs the lowercase SHA-256 of the source it was computed from."));
    return undefined;
  }
  if (!Array.isArray(value.edits) || value.edits.length === 0) {
    problems.push(problem(`${path}/edits`, "maintenance.patch-edits", "A patch file needs at least one edit."));
    return undefined;
  }

  const edits: MaintenancePatchEdit[] = [];
  value.edits.forEach((rawEdit, editIndex) => {
    const editPath = `${path}/edits/${editIndex}`;
    if (typeof rawEdit !== "object" || rawEdit === null || Array.isArray(rawEdit)) {
      problems.push(problem(editPath, "maintenance.patch-edit", "A patch edit must be an object."));
      return;
    }
    const edit = rawEdit as Record<string, unknown>;
    if (!isPosition(edit.line) || !isPosition(edit.column) || !isPosition(edit.endLine) || !isPosition(edit.endColumn)) {
      problems.push(problem(editPath, "maintenance.patch-span", "A patch edit needs 1-based positive integer lines and columns."));
      return;
    }
    if (typeof edit.expected !== "string" || typeof edit.replacement !== "string") {
      problems.push(problem(editPath, "maintenance.patch-text", "A patch edit needs `expected` and `replacement` strings."));
      return;
    }
    edits.push({
      file: filePath,
      line: edit.line,
      column: edit.column,
      endLine: edit.endLine,
      endColumn: edit.endColumn,
      expected: edit.expected,
      replacement: edit.replacement,
    });
  });
  if (edits.length !== value.edits.length) return undefined;
  return { path: filePath, sha256: value.sha256, edits };
}

/** The parsed claim, or a problem. */
function claimOf(raw: unknown, index: number, problems: MaintenanceProblem[]): MaintenanceClaim | undefined {
  const path = `/claims/${index}`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    problems.push(problem(path, "maintenance.claim", "A claim must be an object."));
    return undefined;
  }
  const value = raw as Record<string, unknown>;
  if (typeof value.criterion !== "string" || value.criterion.trim() === "") {
    problems.push(problem(`${path}/criterion`, "maintenance.claim-criterion", "A claim needs a non-empty criterion id."));
    return undefined;
  }
  if (typeof value.statement !== "string" || value.statement.trim() === "") {
    problems.push(problem(`${path}/statement`, "maintenance.claim-statement", "A claim needs a non-empty statement."));
    return undefined;
  }
  if (!Array.isArray(value.files) || value.files.some((file) => !safePatchPath(file))) {
    problems.push(problem(`${path}/files`, "maintenance.claim-files", "A claim's files must be relative site paths."));
    return undefined;
  }
  if (!Array.isArray(value.checks) || value.checks.some((check) => typeof check !== "string" || check.trim() === "")) {
    problems.push(problem(`${path}/checks`, "maintenance.claim-checks", "A claim's checks must be non-empty check ids."));
    return undefined;
  }
  return {
    criterion: value.criterion.trim(),
    statement: value.statement.trim(),
    files: [...new Set(value.files as string[])].sort(byCodePoint),
    checks: [...new Set((value.checks as string[]).map((check) => check.trim()))].sort(byCodePoint),
  };
}

/** What validation may check besides the document itself. */
export interface PatchValidateOptions {
  /** The task the patch was written for; its id, snapshot, scope, and criteria are enforced. */
  readonly task?: TaskDocument;
  /** Files the site allows; absent means the task scope alone decides. */
  readonly allowedFiles?: readonly string[];
  /** A site policy whose write rule must allow every patched file. */
  readonly policy?: AccessPolicy;
}

/**
 * Parses and validates an external patch. Nothing is read or written; a document with any problem
 * yields no patch, so a caller can never apply a partly valid set.
 */
export function parseMaintenancePatch(
  value: unknown,
  options: PatchValidateOptions = {},
): MaintenancePatchResult {
  const problems: MaintenanceProblem[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { problems: [problem("", "maintenance.patch", "A patch must be a JSON object.")] };
  }
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) {
    problems.push(problem("/version", "maintenance.patch-version", "Only maintenance patch version 1 is supported."));
  }
  for (const key of ["task", "snapshot", "proposal"] as const) {
    if (typeof raw[key] !== "string" || !HASH.test(raw[key] as string)) {
      problems.push(problem(`/${key}`, `maintenance.patch-${key}`, `\`${key}\` must be a lowercase SHA-256 id.`));
    }
  }
  if (!Array.isArray(raw.files) || raw.files.length === 0) {
    problems.push(problem("/files", "maintenance.patch-files", "A patch needs at least one file."));
  }
  const files: MaintenancePatchFile[] = [];
  if (Array.isArray(raw.files)) {
    raw.files.forEach((entry, index) => {
      const file = fileOf(entry, index, problems);
      if (file !== undefined) files.push(file);
    });
  }
  if (!Array.isArray(raw.claims)) {
    problems.push(problem("/claims", "maintenance.patch-claims", "A patch needs a claims list; use an empty list only when no criterion is claimed."));
  }
  const claims: MaintenanceClaim[] = [];
  if (Array.isArray(raw.claims)) {
    raw.claims.forEach((entry, index) => {
      const claim = claimOf(entry, index, problems);
      if (claim !== undefined) claims.push(claim);
    });
  }

  if (problems.length > 0) return { problems };

  const patch: MaintenancePatch = {
    version: 1,
    task: raw.task as string,
    snapshot: raw.snapshot as string,
    proposal: raw.proposal as string,
    files: [...files].sort((a, b) => byCodePoint(a.path, b.path)),
    claims: [...claims].sort((a, b) => byCodePoint(a.criterion, b.criterion)),
  };

  const task = options.task;
  if (task !== undefined) {
    if (patch.task !== task.id) {
      problems.push(problem("/task", "maintenance.patch-task", `The patch names task \`${patch.task}\`, not \`${task.id}\`.`));
    }
    if (patch.snapshot !== task.snapshot.id) {
      problems.push(problem("/snapshot", "maintenance.patch-snapshot", `The patch was written against another snapshot; the task is \`${task.snapshot.id}\`.`));
    }
    const allowed = new Set([...task.scope.files, ...task.scope.pages]);
    for (const file of patch.files) {
      if (!allowed.has(file.path)) {
        problems.push(problem(`/files/${file.path}/path`, "maintenance.patch-scope", `\`${file.path}\` is not in the task scope.`));
      }
    }
    const criteria = new Set(task.acceptance.map((criterion) => criterion.id));
    for (const claim of patch.claims) {
      if (!criteria.has(claim.criterion)) {
        problems.push(problem(`/claims/${claim.criterion}/criterion`, "maintenance.claim-unknown", `\`${claim.criterion}\` is not an acceptance criterion of the task.`));
      }
    }
  }

  if (options.allowedFiles !== undefined) {
    const allowed = new Set(options.allowedFiles);
    for (const file of patch.files) {
      if (!allowed.has(file.path)) {
        problems.push(problem(`/files/${file.path}/path`, "maintenance.patch-permission", `\`${file.path}\` is outside the site permission list.`));
      }
    }
  }

  if (options.policy !== undefined) {
    for (const file of patch.files) {
      if (!options.policy.capabilities.write) {
        problems.push(problem(`/files/${file.path}/path`, "maintenance.patch-policy", "The access policy denies write."));
        continue;
      }
      const decision = writeRule(options.policy, {
        capability: "write",
        task: task?.id ?? options.policy.task,
        snapshot: patch.snapshot,
        path: file.path,
        scope: task?.scope ?? { pages: [file.path], blocks: [], collections: [], symbols: [], files: [file.path] },
      });
      if (!decision.allowed) {
        problems.push(problem(`/files/${file.path}/path`, `maintenance.patch-${decision.rule}`, decision.reason));
      }
    }
  }

  return problems.length === 0 ? { patch, problems } : { problems };
}

/** One file after the patch was applied in memory. */
export interface AppliedMaintenanceFile {
  readonly path: string;
  readonly beforeHash: string;
  readonly afterHash: string;
  readonly before: string;
  readonly after: string;
  readonly diff: string;
}

/** The in-memory result; no file was written. */
export interface AppliedMaintenancePatch {
  readonly files: readonly AppliedMaintenanceFile[];
  readonly problems: readonly MaintenanceProblem[];
}

/**
 * Applies a validated patch to the supplied source text and returns the result. Every file hash,
 * span, and expected text is required; one stale edit refuses the whole set. The function never
 * reads or writes the filesystem.
 */
export function applyMaintenancePatch(
  patch: MaintenancePatch,
  sources: Readonly<Record<string, string>>,
): AppliedMaintenancePatch {
  const problems: MaintenanceProblem[] = [];
  const sets: FilePatches[] = [];
  for (const file of patch.files) {
    const source = sources[file.path];
    if (source === undefined) {
      problems.push(problem(`/files/${file.path}`, "maintenance.patch-missing", `\`${file.path}\` is not in the supplied sources.`));
      continue;
    }
    if (hashSource(source) !== file.sha256) {
      problems.push(problem(`/files/${file.path}`, "maintenance.patch-stale", `\`${file.path}\` no longer has the hash the patch was computed from.`));
      continue;
    }
    sets.push({
      file: file.path,
      source,
      patches: file.edits.map((edit) => ({
        span: {
          file: edit.file,
          line: edit.line,
          column: edit.column,
          endLine: edit.endLine,
          endColumn: edit.endColumn,
        },
        expected: edit.expected,
        replacement: edit.replacement,
        beforeHash: file.sha256,
      })),
    });
  }
  if (problems.length > 0) return { files: [], problems };

  try {
    const applied = applyFilePatches(sets, { requireExpected: true, requireHash: true });
    return {
      files: applied.map((file) => ({
        path: file.file,
        beforeHash: file.beforeHash,
        afterHash: file.afterHash,
        before: file.before,
        after: file.after,
        diff: unifiedDiff(file.before, file.after, file.file),
      })),
      problems,
    };
  } catch (err) {
    if (err instanceof PatchError) {
      problems.push(problem(`/files/${err.span.file ?? ""}`, `maintenance.patch-${err.code}`, err.message));
    } else if (err instanceof EditFileError) {
      problems.push(problem(`/files/${err.file}`, `maintenance.patch-${err.code}`, err.message));
    } else {
      problems.push(problem("", "maintenance.patch-apply", err instanceof Error ? err.message : String(err)));
    }
    return { files: [], problems };
  }
}

/** True when the supplied source already has the patch's replacement at that edit's span. */
function alreadyAt(source: string, edit: MaintenancePatchEdit): boolean {
  try {
    return sliceBySpan(source, edit) === edit.replacement;
  } catch {
    return false;
  }
}

/**
 * Whether a patch produces no change: either it changes no bytes, or the source already contains
 * every replacement while no longer matching the patch's base hash. The second case is a human
 * who already made the change; either way no pull request should be opened.
 */
export function maintenanceNoop(
  patch: MaintenancePatch,
  sources: Readonly<Record<string, string>>,
): MaintenanceNoop {
  const applied = applyMaintenancePatch(patch, sources);
  if (applied.problems.length > 0) {
    const everyPresent = patch.files.every((file) => {
      const source = sources[file.path];
      return source !== undefined && file.edits.every((edit) => alreadyAt(source, edit));
    });
    if (everyPresent) {
      return {
        noop: true,
        reason: "already-resolved",
        evidence: patch.files.map((file) => `${file.path}: every replacement is already present at its span`).sort(byCodePoint),
      };
    }
    return { noop: false, reason: "none", evidence: [] };
  }
  const unchanged = applied.files.every((file) => file.beforeHash === file.afterHash);
  return unchanged
    ? {
        noop: true,
        reason: "empty-diff",
        evidence: applied.files.map((file) => `${file.path}: no bytes differ`).sort(byCodePoint),
      }
    : { noop: false, reason: "none", evidence: [] };
}

/**
 * Checks whether a patch still applies to the current sources. A different snapshot, a missing
 * file, or a changed hash names each stale source and asks for a rebase. `markStalePatch` moves a
 * task that can still move to `blocked`; a task already in `verify` asks for review instead.
 */
export function staleMaintenancePatch(
  patch: MaintenancePatch,
  sources: Readonly<Record<string, string>>,
  snapshot: string,
): MaintenanceStaleResult {
  const stale: MaintenanceStaleSource[] = [];
  if (patch.snapshot !== snapshot) {
    stale.push({ path: "", reason: "snapshot", before: patch.snapshot, current: snapshot });
  }
  for (const file of patch.files) {
    const source = sources[file.path];
    if (source === undefined) {
      stale.push({ path: file.path, reason: "missing", before: file.sha256, current: null });
    } else {
      const current = hashSource(source);
      if (current !== file.sha256) stale.push({ path: file.path, reason: "changed", before: file.sha256, current });
    }
  }
  if (stale.length === 0) return { ok: true, stale, action: "none", reason: "The patch still applies to the current sources." };
  const reason = stale
    .map((entry) => (entry.reason === "snapshot" ? "the snapshot changed" : entry.reason === "missing" ? `${entry.path} is missing` : `${entry.path} changed`))
    .join("; ");
  return { ok: false, stale, action: "rebase", reason: `Stop the stale patch and rebase: ${reason}.` };
}

/** Marks a task blocked when the state machine allows it; returns the task and the stale result. */
export function markStalePatch(
  task: TaskDocument,
  stale: MaintenanceStaleResult,
): MaintenanceStaleResult & { readonly task?: TaskDocument } {
  if (stale.ok) return stale;
  const transition = transitionTask(task, {
    to: "blocked",
    reason: `${stale.reason} Rebase the patch or review it.`,
  });
  if (transition.task !== undefined) {
    return { ...stale, action: "rebase", task: transition.task };
  }
  return { ...stale, action: "review" };
}

/**
 * Builds a patch from the mechanical repairs the drift checks already know (#1231). No model is
 * involved: each diagnostic fix becomes one span replacement, with the source text it currently
 * expects, and each acceptance criterion claims the patched files.
 */
export function deterministicMaintenancePatch(
  task: TaskDocument,
  proposal: string,
  observations: MaintenanceObservations,
  sources: Readonly<Record<string, string>>,
): MaintenancePatchResult {
  const problems: MaintenanceProblem[] = [];
  const byFile = new Map<string, { path: string; sha256: string; edits: MaintenancePatchEdit[] }>();
  for (const finding of observations.findings) {
    const fix = finding.fix;
    if (fix === undefined) continue;
    const source = sources[fix.file];
    if (source === undefined) {
      problems.push(problem(`/fixes/${finding.id}`, "maintenance.fix-missing", `\`${fix.file}\` is not in the supplied sources.`));
      continue;
    }
    let expected: string;
    try {
      expected = sliceBySpan(source, { file: fix.file, line: fix.line, column: fix.column, endLine: fix.endLine, endColumn: fix.endColumn });
    } catch (err) {
      problems.push(problem(`/fixes/${finding.id}`, "maintenance.fix-span", err instanceof Error ? err.message : String(err)));
      continue;
    }
    const entry = byFile.get(fix.file) ?? { path: fix.file, sha256: hashSource(source), edits: [] };
    entry.edits.push({
      file: fix.file,
      line: fix.line,
      column: fix.column,
      endLine: fix.endLine,
      endColumn: fix.endColumn,
      expected,
      replacement: fix.text,
    });
    byFile.set(fix.file, entry);
  }
  if (problems.length > 0) return { problems };
  const files = [...byFile.values()].sort((a, b) => byCodePoint(a.path, b.path));
  const claims = task.acceptance.map((criterion) => ({
    criterion: criterion.id,
    statement: criterion.statement,
    files: files.map((file) => file.path),
    checks: criterion.check === undefined ? [] : [criterion.check],
  }));
  return {
    patch: {
      version: 1,
      task: task.id,
      snapshot: task.snapshot.id,
      proposal,
      files,
      claims,
    },
    problems,
  };
}

/** A stable sentence about the result, for a CLI or a report. */
export function patchMessage(result: AppliedMaintenancePatch): string {
  if (result.problems.length > 0) return result.problems.map((entry) => entry.message).join(" ");
  const changed = result.files.filter((file) => file.beforeHash !== file.afterHash).length;
  return `${changed} of ${result.files.length} file(s) change; nothing is written.`;
}

/** The hash a no-op close uses as its evidence reference. */
export function noopEvidenceId(noop: MaintenanceNoop): string {
  return sha256(`mizzen-maintenance-noop\0${canonicalJson({ reason: noop.reason, evidence: noop.evidence })}`);
}

/** The task after closing a no-op as done, with the evidence as the result reference. */
export function closeNoopTask(
  task: TaskDocument,
  noop: MaintenanceNoop,
): { readonly task?: TaskDocument; readonly problems: readonly TaskProblem[] } {
  if (!noop.noop) return { task, problems: [] };
  let current = task;
  const moves: { to: "ready" | "running" | "verify" | "done" }[] =
    task.state === "draft" || task.state === "waiting" || task.state === "blocked"
      ? [{ to: "ready" }, { to: "running" }, { to: "verify" }, { to: "done" }]
      : task.state === "ready"
        ? [{ to: "running" }, { to: "verify" }, { to: "done" }]
        : task.state === "running"
          ? [{ to: "verify" }, { to: "done" }]
          : task.state === "verify"
            ? [{ to: "done" }]
            : [];
  if (moves.length === 0) return { task, problems: [] };
  const result = `noop:${noopEvidenceId(noop)}`;
  for (const move of moves) {
    const transition = transitionTask(current, {
      to: move.to,
      reason: `No-op: ${noop.reason}. ${noop.evidence.join("; ")}`,
      ...(move.to === "verify" || move.to === "done" ? { result } : {}),
    });
    if (transition.task === undefined) return { problems: transition.problems };
    current = transition.task;
  }
  return { task: current, problems: [] };
}
