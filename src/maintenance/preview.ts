/**
 * Preview a maintenance proposal without changing source (#1235).
 *
 * The preview validates the patch against the task and the site policy, applies it to the supplied
 * text in memory, and returns the unified diff, the checks the acceptance criteria require, and the
 * affected outputs. `write` says whether writing a proposal branch is a dry run, needs approval,
 * is allowed by the policy, or is denied; this module never writes, so a reviewer always sees the
 * result first.
 */
import type { AccessGrant, AccessPolicy } from "../contracts/permissions.ts";
import type { TaskDocument } from "../contracts/task.ts";
import type {
  MaintenancePlannedCheck,
  MaintenancePreview,
  MaintenancePreviewFile,
  MaintenanceProblem,
  MaintenanceWriteGate,
} from "../contracts/index.ts";
import { approvalValid, writeRule } from "../permissions/evaluate.ts";
import { applyMaintenancePatch, parseMaintenancePatch } from "./patch.ts";

/** What a preview needs. */
export interface PreviewOptions {
  readonly task: TaskDocument;
  readonly sources: Readonly<Record<string, string>>;
  /** Published outputs the proposal affects, such as `/api/catalog/`. */
  readonly outputs?: readonly string[];
  /** Files the site allows; absent means the task scope alone decides. */
  readonly allowedFiles?: readonly string[];
  /** A site policy: writing is allowed only when it permits every file and its approval is met. */
  readonly policy?: AccessPolicy;
  /** An approval for `write` on this snapshot, when the policy asks for one. */
  readonly approval?: AccessGrant;
}

/** The check kind an acceptance check id names, so a preview groups checks the same way every run. */
export function checkKindOf(check: string): string {
  const id = check.toLowerCase();
  if (id.includes("schema")) return "schema";
  if (id.includes("link")) return "links";
  if (id.includes("example")) return "examples";
  if (id.includes("build")) return "build";
  return "task";
}

/** Every check the task's acceptance criteria require, in contract order. */
function checksOf(task: TaskDocument): MaintenancePlannedCheck[] {
  const checks: MaintenancePlannedCheck[] = [];
  const seen = new Set<string>();
  for (const criterion of task.acceptance) {
    if (criterion.check === undefined || seen.has(criterion.check)) continue;
    seen.add(criterion.check);
    checks.push({
      id: criterion.check,
      criterion: criterion.id,
      kind: checkKindOf(criterion.check),
      status: "planned",
    });
  }
  return checks;
}

/** The write gate, with one sentence that names the rule. */
function writeGate(
  files: readonly MaintenancePreviewFile[],
  options: PreviewOptions,
  problems: readonly MaintenanceProblem[],
): { readonly write: MaintenanceWriteGate; readonly reason: string } {
  if (problems.length > 0) return { write: "denied", reason: "The patch is invalid; nothing can be written." };
  if (!files.some((file) => file.changed)) return { write: "dry-run", reason: "The patch changes no bytes; no branch is proposed." };
  const policy = options.policy;
  if (policy === undefined) {
    return { write: "requires-approval", reason: "No site policy allows the write, so a person must approve the proposal branch." };
  }
  if (!policy.capabilities.write) return { write: "denied", reason: "The access policy denies write." };
  for (const file of files) {
    const decision = writeRule(policy, {
      capability: "write",
      task: options.task.id,
      snapshot: options.task.snapshot.id,
      path: file.path,
      scope: options.task.scope,
    });
    if (!decision.allowed) return { write: "denied", reason: `${file.path}: ${decision.reason}` };
  }
  if (options.allowedFiles !== undefined) {
    const allowed = new Set(options.allowedFiles);
    const outside = files.find((file) => !allowed.has(file.path));
    if (outside !== undefined) return { write: "denied", reason: `${outside.path} is outside the site permission list.` };
  }
  if (policy.approvals.write) {
    if (options.approval === undefined || !approvalValid(options.approval, policy, options.task.snapshot.id)) {
      return { write: "requires-approval", reason: "The policy requires an approval for write on this snapshot." };
    }
  }
  return { write: "allowed", reason: "The policy allows every file and the approval, when required, is valid." };
}

/**
 * Previews a patch. Any validation, hash, span, or expected-text problem produces a preview with
 * `problems`, no changed file, and a denied write gate; no problem is silently dropped.
 */
export function previewMaintenance(
  patch: unknown,
  options: PreviewOptions,
): MaintenancePreview {
  const parsed = parseMaintenancePatch(patch, { task: options.task });
  if (parsed.patch === undefined) {
    return {
      version: 1,
      proposal: "",
      snapshot: options.task.snapshot.id,
      files: [],
      changed: false,
      checks: checksOf(options.task),
      outputs: [...(options.outputs ?? [])],
      write: "denied",
      writeReason: "The patch is invalid; nothing can be written.",
      problems: parsed.problems,
    };
  }

  const applied = applyMaintenancePatch(parsed.patch, options.sources);
  const files: MaintenancePreviewFile[] = applied.files.map((file) => ({
    path: file.path,
    before: file.beforeHash,
    after: file.afterHash,
    diff: file.diff,
    changed: file.beforeHash !== file.afterHash,
  }));
  const gate = writeGate(files, options, applied.problems);
  return {
    version: 1,
    proposal: parsed.patch.proposal,
    snapshot: parsed.patch.snapshot,
    files,
    changed: files.some((file) => file.changed),
    checks: checksOf(options.task),
    outputs: [...(options.outputs ?? [])],
    write: gate.write,
    writeReason: gate.reason,
    problems: applied.problems,
  };
}
