/**
 * Executable acceptance criteria: how one criterion stands against the evidence supplied for it.
 *
 * A criterion names exactly one of an existing check or `review: true`; the parser refuses anything
 * else. This module never guesses: a check proves the criterion only when the evidence names the
 * same check and passed, and a review proves it only when a person approved it. A missing, skipped,
 * or mismatched check stays `pending`, and a missing review stays `needs-review`, so an ambiguous
 * criterion is never recorded as proved.
 */
import type {
  TaskAcceptanceCriterion,
  TaskCriterionEvidence,
  TaskCriterionOutcome,
} from "../contracts/task.ts";

/** One criterion's outcome, with the criterion id it belongs to. */
export interface TaskCriterionResult {
  readonly id: string;
  readonly outcome: TaskCriterionOutcome;
}

/** How one criterion stands against the evidence supplied for it. */
export function criterionOutcome(
  criterion: TaskAcceptanceCriterion,
  evidence: TaskCriterionEvidence = {},
): TaskCriterionOutcome {
  if (criterion.review === true) {
    switch (evidence.review?.status) {
      case "approved":
        return "proved";
      case "rejected":
        return "failed";
      default:
        return "needs-review";
    }
  }

  if (criterion.check === undefined) return "needs-review";
  if (evidence.check?.id !== criterion.check) return "pending";
  switch (evidence.check.status) {
    case "passed":
      return "proved";
    case "failed":
      return "failed";
    default:
      return "pending";
  }
}

/** Every criterion's outcome, in contract order. */
export function acceptanceOutcomes(
  criteria: readonly TaskAcceptanceCriterion[],
  evidence: ReadonlyMap<string, TaskCriterionEvidence>,
): readonly TaskCriterionResult[] {
  return criteria.map((criterion) => ({
    id: criterion.id,
    outcome: criterionOutcome(criterion, evidence.get(criterion.id)),
  }));
}
