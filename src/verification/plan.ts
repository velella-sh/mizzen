/**
 * Build a verification plan from a task (#1179).
 *
 * A plan has one entry per acceptance criterion, in the order the contract lists them. A
 * criterion that names a check gets that check, the fixture the check reads, and the expected
 * evidence in one sentence. A criterion that requires review gets no automatic pass: its entry
 * is `human`, and only a recorded approval can prove it. A criterion with no matching spec, a
 * spec that names a different check, or an empty fixture is a problem, and a plan with a problem
 * cannot prove anything.
 *
 * This module reads no file and runs no check: the caller supplies the specs, so a plan can be
 * reviewed before anything executes.
 */
import type { TaskAcceptanceCriterion, TaskDocument } from "../contracts/task.ts";
import type {
  VerificationPlan,
  VerificationPlanEntry,
  VerificationPlanProblem,
} from "../contracts/verification.ts";

/** What a caller knows about the check behind one criterion. */
export interface VerificationCheckSpec {
  /** The criterion id from the task contract. */
  readonly criterion: string;
  /** The check id that proves the criterion. */
  readonly check: string;
  /** The site-relative fixture the check reads or changes. */
  readonly fixture: string;
  /** The evidence a passing result must contain, in one sentence. */
  readonly expected: string;
}

/** Why one criterion could not be planned, or the plan built from the task. */
export function planVerification(
  task: TaskDocument,
  specs: readonly VerificationCheckSpec[],
): VerificationPlan {
  const byCriterion = new Map<string, VerificationCheckSpec>();
  const problems: VerificationPlanProblem[] = [];

  for (const spec of specs) {
    if (byCriterion.has(spec.criterion)) {
      problems.push({
        criterion: spec.criterion,
        code: "verification.plan-duplicate-spec",
        message: `More than one check spec names criterion "${spec.criterion}"; give each criterion exactly one.`,
      });
      continue;
    }
    byCriterion.set(spec.criterion, spec);
  }

  const entries = task.acceptance.map((criterion) => entryOf(task, criterion, byCriterion, problems));
  const criteriaIds = new Set(task.acceptance.map((criterion) => criterion.id));
  for (const spec of specs) {
    if (!criteriaIds.has(spec.criterion)) {
      problems.push({
        criterion: spec.criterion,
        code: "verification.plan-unknown-criterion",
        message: `Check spec names criterion "${spec.criterion}", which the task does not declare.`,
      });
    }
  }

  return {
    version: 1,
    task: task.id,
    snapshot: task.snapshot.id,
    entries,
    problems,
  };
}

/** One entry, adding a problem when the spec is missing or disagrees with the contract. */
function entryOf(
  task: TaskDocument,
  criterion: TaskAcceptanceCriterion,
  specs: ReadonlyMap<string, VerificationCheckSpec>,
  problems: VerificationPlanProblem[],
): VerificationPlanEntry {
  const spec = specs.get(criterion.id);
  const human = criterion.review === true;
  const fixture = spec?.fixture.trim() ?? "";

  if (fixture === "") {
    problems.push({
      criterion: criterion.id,
      code: "verification.plan-missing-fixture",
      message: `Criterion "${criterion.id}" names no fixture; a plan needs the file the evidence comes from.`,
    });
  }

  const knowledge = criterion.knowledge;
  const needs = criterion.needs;
  const knowledgeProps = {
    ...(knowledge === undefined ? {} : { knowledge }),
    ...(needs === undefined ? {} : { needs }),
  } as const;

  if (human) {
    return {
      criterion: criterion.id,
      statement: criterion.statement,
      mode: "human",
      fixture,
      expected: spec?.expected.trim() || "an approved human review recorded for this criterion",
      ...knowledgeProps,
    };
  }

  const check = criterion.check;
  if (check === undefined) {
    problems.push({
      criterion: criterion.id,
      code: "verification.plan-no-check",
      message: `Criterion "${criterion.id}" names neither a check nor human review; the task contract should have refused it.`,
    });
    return {
      criterion: criterion.id,
      statement: criterion.statement,
      mode: "check",
      ...(spec === undefined ? {} : { check: spec.check }),
      fixture,
      expected: spec?.expected.trim() ?? "",
      ...knowledgeProps,
    };
  }

  if (spec === undefined) {
    problems.push({
      criterion: criterion.id,
      code: "verification.plan-missing-spec",
      message: `Criterion "${criterion.id}" names check "${check}", but the plan has no fixture or expected evidence for it.`,
    });
  } else if (spec.check !== check) {
    problems.push({
      criterion: criterion.id,
      code: "verification.plan-check-mismatch",
      message: `Criterion "${criterion.id}" names check "${check}", but its spec names "${spec.check}".`,
    });
  }

  return {
    criterion: criterion.id,
    statement: criterion.statement,
    mode: "check",
    check,
    fixture,
    expected: spec?.expected.trim() ?? "",
    ...knowledgeProps,
  };
}

/** True when the plan has no problem and every criterion has one entry. */
export function planIsComplete(plan: VerificationPlan): boolean {
  return plan.problems.length === 0 && plan.entries.length > 0;
}
