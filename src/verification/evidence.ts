/**
 * Tie result claims to evidence (#1180) and detect unproved completion (#1187).
 *
 * A claim never says `proved` by itself. A check criterion is proved only when the named check
 * ran and passed *and* the fixture it names has the recorded hash in the transaction; a human
 * criterion is proved only when a recorded review approved that exact criterion. Everything
 * else is `unproven` or `needs-review`, and `missing` names what the claim still needs in
 * plain words. A rejected review or a failed check is `failed`, never a missing pass.
 *
 * Completion is a separate question: a task may enter `done` only when every criterion is
 * `proved`. A claim of completion without criteria or without evidence is `unproven`.
 */
import type { TaskDocument, TaskProblem } from "../contracts/task.ts";
import type {
  VerificationCheck,
  VerificationClaim,
  VerificationClaimStatus,
  VerificationEvidence,
  VerificationHumanReview,
  VerificationPlan,
  VerificationPlanEntry,
  VerificationProof,
  VerificationVerdict,
} from "../contracts/verification.ts";

/** The evidence available when claims are bound. */
export interface ClaimEvidenceInput {
  readonly checks: readonly VerificationCheck[];
  readonly humanReview: VerificationHumanReview;
  /** Site-relative path to the SHA-256 after the task, or `null` when absent. */
  readonly files: Readonly<Record<string, string | null>>;
}

/** Every claim for a plan, in criterion order. */
export function bindClaims(
  plan: VerificationPlan,
  evidence: ClaimEvidenceInput,
): readonly VerificationClaim[] {
  const checks = new Map(evidence.checks.map((check) => [check.id, check]));
  return plan.entries.map((entry) => {
    if (entry.mode === "human") return humanClaim(entry, evidence, checks);
    return checkClaim(entry, evidence, checks);
  });
}

/** The evidence entry for a fixture, or `undefined` when the transaction did not record it. */
function fixtureEvidence(
  entry: VerificationPlanEntry,
  evidence: ClaimEvidenceInput,
  check: VerificationCheck | undefined,
): VerificationEvidence | undefined {
  const hash = evidence.files[entry.fixture];
  if (hash === undefined || hash === null) return undefined;
  const span = check?.span;
  if (span !== undefined && span.file === entry.fixture) {
    return { kind: "span", path: entry.fixture, hash, span: { line: span.line, column: span.column, endLine: span.endLine, endColumn: span.endColumn } };
  }
  return { kind: "file", path: entry.fixture, hash };
}

/** The missing-evidence sentence for a fixture. */
function fixtureMissing(entry: VerificationPlanEntry): string {
  return `the fixture "${entry.fixture}" has no recorded result in the transaction`;
}

/** A claim for a check criterion. */
function checkClaim(
  entry: VerificationPlanEntry,
  evidence: ClaimEvidenceInput,
  checks: ReadonlyMap<string, VerificationCheck>,
): VerificationClaim {
  const base = {
    id: entry.criterion,
    criterion: entry.criterion,
    statement: entry.statement,
  } as const;
  const checkId = entry.check;
  if (checkId === undefined) {
    return {
      ...base,
      status: "unproven",
      evidence: [],
      missing: [`criterion "${entry.criterion}" names no check`],
    };
  }

  const check = checks.get(checkId);
  if (check === undefined) {
    return { ...base, status: "unproven", evidence: [], missing: [`check "${checkId}" did not run`] };
  }

  const evidenceItems: VerificationEvidence[] = [
    { kind: "check", id: check.id, status: check.status, outputHash: check.outputHash },
  ];
  const fixture = fixtureEvidence(entry, evidence, check);
  if (fixture !== undefined) evidenceItems.push(fixture);

  if (check.status === "failed" || check.status === "timed-out" || check.status === "rejected") {
    return { ...base, status: "failed", evidence: evidenceItems, missing: [] };
  }
  if (check.status !== "passed") {
    return {
      ...base,
      status: "unproven",
      evidence: evidenceItems,
      missing: [`check "${checkId}" did not run`],
    };
  }
  if (fixture === undefined) {
    return { ...base, status: "unproven", evidence: evidenceItems, missing: [fixtureMissing(entry)] };
  }
  return { ...base, status: "proved", evidence: evidenceItems, missing: [] };
}

/** A claim for a human criterion; approval is the only path to `proved`. */
function humanClaim(
  entry: VerificationPlanEntry,
  evidence: ClaimEvidenceInput,
  checks: ReadonlyMap<string, VerificationCheck>,
): VerificationClaim {
  const base = {
    id: entry.criterion,
    criterion: entry.criterion,
    statement: entry.statement,
  } as const;
  const fixture = fixtureEvidence(entry, evidence, checks.get(entry.criterion));
  const evidenceItems: VerificationEvidence[] = [];
  if (fixture !== undefined) evidenceItems.push(fixture);

  const approved = evidence.humanReview.status === "approved" && evidence.humanReview.criteria.includes(entry.criterion);
  const rejected = evidence.humanReview.status === "rejected" && evidence.humanReview.criteria.includes(entry.criterion);
  if (approved || rejected) {
    evidenceItems.push({
      kind: "human",
      criterion: entry.criterion,
      status: approved ? "approved" : "rejected",
      ...(evidence.humanReview.reviewer === undefined ? {} : { reviewer: evidence.humanReview.reviewer }),
    });
  }

  const missing: string[] = [];
  if (!approved && !rejected) missing.push(`a human review decision for criterion "${entry.criterion}"`);
  if (fixture === undefined) missing.push(fixtureMissing(entry));

  const status: VerificationClaimStatus = rejected ? "failed" : approved && fixture !== undefined ? "proved" : "needs-review";
  return { ...base, status, evidence: evidenceItems, missing };
}

/** The completion result: whether every criterion is proved, and what stops it. */
export interface CompletionResult {
  readonly status: "proved" | "unproven" | "failed";
  readonly problems: readonly TaskProblem[];
}

/**
 * Checks whether a proof supports moving its task to `done`. A proof with no criteria, no
 * claims, or a claim that is not `proved` cannot complete the task, and a failed criterion is
 * `failed` rather than `unproven`.
 */
export function completionOf(task: TaskDocument, proof: VerificationProof): CompletionResult {
  const problems: TaskProblem[] = [];
  if (proof.task.id !== task.id) {
    problems.push({
      path: "/task/id",
      code: "verification.completion-task",
      message: `The proof is for task "${proof.task.id}", not "${task.id}".`,
    });
  }
  if (proof.snapshot.id !== task.snapshot.id) {
    problems.push({
      path: "/snapshot/id",
      code: "verification.completion-snapshot",
      message: "The proof was produced against a different input snapshot.",
    });
  }
  if (task.acceptance.length === 0) {
    problems.push({
      path: "/acceptance",
      code: "verification.completion-no-criteria",
      message: "A task with no acceptance criteria cannot be marked done.",
    });
  }
  if (proof.claims.length === 0) {
    problems.push({
      path: "/claims",
      code: "verification.completion-unproven",
      message: "A completion claim with no evidence is unproven.",
    });
  }

  for (const claim of proof.claims) {
    if (claim.status === "proved") continue;
    problems.push({
      path: `/claims/${claim.criterion}`,
      code: claim.status === "failed" ? "verification.completion-failed" : "verification.completion-unproven",
      message: `Criterion "${claim.criterion}" is ${claim.status}${claim.missing.length === 0 ? "" : `: ${claim.missing.join("; ")}`}.`,
    });
  }

  const status: CompletionResult["status"] =
    problems.some((problem) => problem.code === "verification.completion-failed")
      ? "failed"
      : problems.length === 0
        ? "proved"
        : "unproven";
  return { status, problems };
}

/** True only when the proof supports `done`. */
export function canComplete(task: TaskDocument, proof: VerificationProof): boolean {
  return completionOf(task, proof).status === "proved";
}

/** The verdict a set of claims and evidence supports (#1188). */
export interface VerdictInput {
  readonly criteriaCount: number;
  readonly checks: readonly VerificationCheck[];
  readonly claims: readonly VerificationClaim[];
  readonly outputs: VerificationProof["outputs"];
  readonly scope: VerificationProof["scope"];
  readonly references: VerificationProof["references"];
  readonly humanReview: VerificationHumanReview;
  readonly package?: VerificationProof["package"];
}

/**
 * Withhold a successful verdict when anything failed, timed out, did not run, or is missing.
 * Failed evidence is `failed`; missing or unrun evidence is `incomplete`; only a complete set
 * of proved claims is `proved`.
 */
export function verificationVerdict(input: VerdictInput): VerificationVerdict {
  const checksFailed = input.checks.some(
    (check) => check.status === "failed" || check.status === "timed-out" || check.status === "rejected",
  );
  const claimsFailed = input.claims.some((claim) => claim.status === "failed");
  const reviewRejected = input.humanReview.status === "rejected";
  if (
    checksFailed ||
    claimsFailed ||
    reviewRejected ||
    input.outputs.unexplained.length > 0 ||
    !input.scope.ok ||
    !input.references.ok ||
    input.package?.ci === "failed"
  ) {
    return "failed";
  }

  const checksUnrun = input.checks.some((check) => check.status === "unrun");
  const claimsIncomplete = input.claims.some((claim) => claim.status !== "proved");
  if (
    input.criteriaCount === 0 ||
    input.claims.length !== input.criteriaCount ||
    claimsIncomplete ||
    checksUnrun ||
    !input.outputs.match ||
    input.package?.ci === "unknown" ||
    (input.humanReview.status !== "not-required" && input.humanReview.status !== "approved")
  ) {
    return "incomplete";
  }
  return "proved";
}
