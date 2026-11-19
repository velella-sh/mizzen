/**
 * Verify a maintenance proposal independently (#1236).
 *
 * A preview is not proof. This module requires the schema, link, example, build, and task checks a
 * site runs, maps each acceptance criterion to a passed check or an approved human review, refuses
 * a claim that cites a file the patch did not change or a check that did not pass, proves the change
 * stayed in scope, builds the version 2 proof, and verifies that proof again from public inputs.
 * `ready` is true only when the independent verifier agrees with `proved`; an unsupported claim,
 * a skipped check, a stale file, or an out-of-scope change can never be overwritten.
 */
import type { TaskDocument } from "../contracts/task.ts";
import type {
  MaintenanceCheck,
  MaintenanceCheckKind,
  MaintenancePatch,
  MaintenancePreview,
  MaintenanceVerification,
  MaintenanceVerificationFailure,
} from "../contracts/index.ts";
import type {
  VerificationChange,
  VerificationCheck,
  VerificationClaim,
  VerificationHumanReview,
  VerificationOutputs,
  VerificationReferences,
} from "../contracts/verification.ts";
import { sha256 } from "../data/lock.ts";
import { createVerificationProof } from "../verification/proof.ts";
import { independentlyVerify } from "../verification/verify.ts";
import { bindClaims } from "../verification/evidence.ts";
import { planVerification } from "../verification/plan.ts";
import { inputHashOf } from "../verification/reproduce.ts";
import { scopeProof } from "../verification/scope.ts";

/** The checks a maintenance proposal must pass before it is ready for merge. */
export const DEFAULT_MAINTENANCE_CHECKS: readonly MaintenanceCheckKind[] = [
  "schema",
  "links",
  "examples",
  "build",
  "task",
];

/** What verification needs. */
export interface VerifyOptions {
  readonly task: TaskDocument;
  readonly patch: MaintenancePatch;
  readonly preview: MaintenancePreview;
  /** Check results, by id or by criterion. A missing required kind is a failure, never a pass. */
  readonly checks: readonly MaintenanceCheck[];
  /** The build hashes the reproducer measured; defaults to the passed build check's output hash. */
  readonly outputs?: { readonly expectedHash: string; readonly actualHash: string; readonly tool?: { readonly expected: string; readonly actual: string } };
  /** The published-reference check; defaults to no issues. */
  readonly references?: VerificationReferences;
  /** The human decision for review criteria. */
  readonly humanReview?: VerificationHumanReview;
  readonly commit?: string;
  readonly base?: string;
  /** The required kinds. Defaults to {@link DEFAULT_MAINTENANCE_CHECKS}. */
  readonly requiredKinds?: readonly MaintenanceCheckKind[];
  /** Runs a required check that has no result; may return `undefined` when it cannot run. */
  readonly run?: (kind: MaintenanceCheckKind) => Promise<MaintenanceCheck | undefined> | MaintenanceCheck | undefined;
}

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The check that proves a criterion, by criterion id or by the declared check id. */
function checkFor(criterion: string, declared: string | undefined, checks: readonly MaintenanceCheck[]): MaintenanceCheck | undefined {
  return checks.find((check) => check.criterion === criterion) ?? (declared === undefined ? undefined : checks.find((check) => check.id === declared));
}

/** A verification check for the proof, with a deterministic command and fixed limits. */
function verificationCheck(
  task: TaskDocument,
  criterion: string,
  check: MaintenanceCheck | undefined,
  fallbackId: string,
  commit: string,
  preview: MaintenancePreview,
): VerificationCheck {
  const result = check;
  const id = result?.id ?? fallbackId;
  const spanFile = preview.files.find((file) => file.changed)?.path;
  return {
    id,
    criterion,
    task: task.id,
    snapshot: task.snapshot.id,
    commit,
    status: result === undefined || result.status === "skipped" ? "unrun" : result.status,
    command: [id],
    outputHash: result?.outputHash ?? sha256(`mizzen-maintenance-unrun\0${id}`),
    limits: { timeoutMs: 0, memoryMb: 0, network: "deny", paths: "sandbox" },
    ...(spanFile === undefined ? {} : { span: { file: spanFile, line: 1, column: 1, endLine: 1, endColumn: 1 } }),
    ...(result?.detail === undefined ? {} : { detail: result.detail }),
  };
}

/** The public result a verifier reruns with. */
function publicCheck(check: VerificationCheck): { status: VerificationCheck["status"]; outputHash: string } {
  return { status: check.status, outputHash: check.outputHash };
}

/** The output evidence, matching only when a build check passed and both hashes agree. */
function outputsOf(
  task: TaskDocument,
  checks: readonly MaintenanceCheck[],
  options: VerifyOptions,
): VerificationOutputs {
  const build = checks.find((check) => check.kind === "build" && check.status === "passed");
  const expectedHash = options.outputs?.expectedHash ?? build?.outputHash ?? "";
  const actualHash = options.outputs?.actualHash ?? build?.outputHash ?? "";
  const tool = options.outputs?.tool ?? { expected: "mizzen", actual: "mizzen" };
  return {
    inputHash: inputHashOf(task.snapshot),
    tool,
    expectedHash,
    actualHash,
    match: expectedHash !== "" && expectedHash === actualHash && tool.expected === tool.actual,
    explained: [],
    unexplained: [],
  };
}

/**
 * Checks claims against the preview and the check results. A claim that cites an unchanged file,
 * a failed check, or a check nobody ran is rejected with the exact citation.
 */
function claimFailures(
  task: TaskDocument,
  preview: MaintenancePreview,
  checks: readonly MaintenanceCheck[],
  claims: readonly { criterion: string; files: readonly string[]; checks: readonly string[] }[],
): MaintenanceVerificationFailure[] {
  const failures: MaintenanceVerificationFailure[] = [];
  const criteria = new Set(task.acceptance.map((criterion) => criterion.id));
  const changed = new Set(preview.files.filter((file) => file.changed).map((file) => file.path));
  const passed = new Set(checks.filter((check) => check.status === "passed").map((check) => check.id));
  const byCriterion = new Map(claims.map((claim) => [claim.criterion, claim]));

  for (const claim of claims) {
    if (!criteria.has(claim.criterion)) {
      failures.push({ code: "maintenance.claim-unknown", message: `Claim \`${claim.criterion}\` is not an acceptance criterion of task \`${task.id}\`.`, path: `/claims/${claim.criterion}` });
    }
    for (const file of claim.files) {
      if (!changed.has(file)) {
        failures.push({ code: "maintenance.claim-file", message: `Claim \`${claim.criterion}\` cites \`${file}\`, which the patch does not change.`, path: `/claims/${claim.criterion}/files` });
      }
    }
    for (const check of claim.checks) {
      if (!passed.has(check)) {
        failures.push({ code: "maintenance.claim-check", message: `Claim \`${claim.criterion}\` cites check \`${check}\`, which has no passed result.`, path: `/claims/${claim.criterion}/checks` });
      }
    }
  }

  for (const criterion of task.acceptance) {
    if (!byCriterion.has(criterion.id)) {
      failures.push({ code: "maintenance.claim-missing", message: `Acceptance criterion \`${criterion.id}\` has no claim.`, path: `/claims/${criterion.id}` });
    }
  }
  return failures;
}

/**
 * Verifies a proposal. `ready` requires a complete plan, a passed check for every criterion, a
 * passing result for every required kind, claims that cite only changed files and passed checks,
 * a scope proof with no out-of-scope change, and an independent verifier that agrees with `proved`.
 */
export async function verifyMaintenance(options: VerifyOptions): Promise<MaintenanceVerification> {
  const { task, patch, preview } = options;
  const failures: MaintenanceVerificationFailure[] = [];
  const checks = [...options.checks];

  for (const kind of options.requiredKinds ?? DEFAULT_MAINTENANCE_CHECKS) {
    if (checks.some((check) => check.kind === kind && check.status === "passed")) continue;
    const ran = options.run === undefined ? undefined : await options.run(kind);
    if (ran !== undefined) checks.push(ran);
    if (!checks.some((check) => check.kind === kind && check.status === "passed")) {
      failures.push({ code: "maintenance.check-missing", message: `The required \`${kind}\` check has no passed result.` });
    }
  }

  if (patch.task !== task.id) failures.push({ code: "maintenance.patch-task", message: `The patch names task \`${patch.task}\`, not \`${task.id}\`.`, path: "/patch/task" });
  if (patch.snapshot !== task.snapshot.id) failures.push({ code: "maintenance.patch-snapshot", message: "The patch was written against another snapshot.", path: "/patch/snapshot" });
  if (!preview.changed) failures.push({ code: "maintenance.preview-empty", message: "The preview changes no bytes; there is nothing to verify.", path: "/preview" });

  failures.push(...claimFailures(task, preview, checks, patch.claims));

  const commit = options.commit ?? "working-tree";
  const base = options.base ?? "base";
  const changes: VerificationChange[] = [...preview.files]
    .sort((a, b) => byCodePoint(a.path, b.path))
    .map((file) => ({ path: file.path, before: file.before, after: file.after }));
  const allowed = [...new Set([...task.scope.files, ...task.scope.pages])].sort(byCodePoint);
  const expected = preview.files.filter((file) => file.changed).map((file) => file.path).sort(byCodePoint);
  const scope = scopeProof({ allowed, expected, changes });

  const proofChecks: VerificationCheck[] = [];
  const specs = task.acceptance.map((criterion) => {
    const claim = patch.claims.find((entry) => entry.criterion === criterion.id);
    const fixture = claim?.files[0] ?? preview.files.find((file) => file.changed)?.path ?? "";
    const result = checkFor(criterion.id, criterion.check, checks);
    if (criterion.check !== undefined) {
      proofChecks.push(verificationCheck(task, criterion.id, result, criterion.check, commit, preview));
    }
    return {
      criterion: criterion.id,
      check: criterion.check ?? result?.id ?? criterion.id,
      fixture,
      expected: claim?.statement ?? criterion.statement,
    };
  });

  const plan = planVerification(task, specs);
  for (const problem of plan.problems) {
    failures.push({ code: problem.code, message: problem.message, path: `/plan/${problem.criterion}` });
  }

  const humanReview: VerificationHumanReview = options.humanReview ?? { status: "not-required", criteria: [] };
  const files: Record<string, string | null> = {};
  for (const file of preview.files) files[file.path] = file.after;
  const claims: readonly VerificationClaim[] = plan.problems.length === 0 ? bindClaims(plan, { checks: proofChecks, humanReview, files }) : [];
  const outputs = outputsOf(task, checks, options);
  const references = options.references ?? { ok: true, removed: [], changed: [], invalid: [], issues: [] };

  let proof;
  let independent;
  if (plan.problems.length === 0) {
    try {
      proof = createVerificationProof({
        task,
        plan,
        commit,
        base,
        files: changes,
        allowed,
        expected,
        checks: proofChecks,
        outputs,
        references,
        humanReview,
      });
      const before: Record<string, string | null> = {};
      for (const file of preview.files) before[file.path] = file.before;
      const publicChecks: Record<string, { status: VerificationCheck["status"]; outputHash: string }> = {};
      for (const check of proofChecks) publicChecks[check.id] = publicCheck(check);
      independent = await independentlyVerify(proof, {
        input: {
          files,
          before,
          checks: publicChecks,
          outputHash: outputs.actualHash,
          ...(task.acceptance.some((criterion) => criterion.check === undefined || criterion.review === true)
            ? { humanReview }
            : {}),
        },
      });
      for (const failure of independent.failures) failures.push({ code: failure.code, message: failure.message, ...(failure.path === undefined ? {} : { path: failure.path }) });
    } catch (err) {
      failures.push({ code: "maintenance.proof", message: err instanceof Error ? err.message : String(err) });
    }
  }

  const verdict = independent?.verdict ?? "incomplete";
  return {
    version: 1,
    proposal: patch.proposal,
    snapshot: patch.snapshot,
    plan,
    claims,
    scope,
    checks: proofChecks,
    ...(proof === undefined ? {} : { proof }),
    ...(independent === undefined ? {} : { independent }),
    verdict,
    ready: failures.length === 0 && independent?.ok === true && verdict === "proved",
    failures,
  };
}
