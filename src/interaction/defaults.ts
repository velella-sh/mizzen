/**
 * Safe defaults for nonessential ambiguity.
 *
 * A default is recorded as one decision with the reason it applies, so a reviewer can see what was
 * chosen and why. A risky default is not adopted by this module: it needs an approved request for
 * action `default` in the current stage first, and the suggestion is returned even when that
 * approval is missing.
 */
import type {
  InteractionDecision,
  InteractionSession,
} from "../contracts/interaction.ts";
import { approvalProblem } from "./approvals.ts";
import { failed, textOf, type InteractionResult } from "./result.ts";

/** How risky adopting a default is. A `high` default needs approval. */
export type DefaultRisk = "low" | "high";

/** A suggested default. */
export interface DefaultInput {
  /** The field or question the default decides. */
  readonly field: string;
  /** The value the default uses. */
  readonly value: string;
  /** Why the default applies. */
  readonly reason: string;
  /** `low` is adopted; `high` needs an approval. */
  readonly risk: DefaultRisk;
  /** The approved request that allows a `high` default. */
  readonly approvalId?: string;
}

/** A recorded or suggested default, with the session when it was adopted. */
export interface RecordDefaultResult extends InteractionResult {
  /** The suggested decision; present on every request, adopted or not. */
  readonly suggested?: InteractionDecision;
}

/** Records a low-risk default, or a high-risk one covered by an approval. */
export function recordDefault(
  session: InteractionSession,
  input: DefaultInput,
): RecordDefaultResult {
  if (session.status !== "active") {
    return failed(
      "/status",
      "interaction.status",
      `A default can be recorded only while the session is \`active\`; it is \`${session.status}\`.`,
    );
  }

  const field = textOf(input.field);
  const value = textOf(input.value);
  const reason = textOf(input.reason);
  if (field === "") return failed("/field", "interaction.empty", "A default needs a `field`.");
  if (value === "") return failed("/value", "interaction.empty", "A default needs a `value`.");
  if (reason === "") {
    return failed("/reason", "interaction.empty", "A default needs the `reason` it applies.");
  }
  if (input.risk !== "low" && input.risk !== "high") {
    return failed("/risk", "interaction.risk", "A default risk must be `low` or `high`.");
  }

  const suggested: InteractionDecision = { subject: field, choice: value, reason };

  if (input.risk === "high") {
    const approval = approvalProblem(session, input.approvalId ?? "", {
      stage: session.stage,
      action: "default",
    });
    if (approval !== undefined) {
      return {
        problems: [
          {
            ...approval,
            message: `Default \`${value}\` for \`${field}\` is risky (${reason}); ${approval.message}`,
          },
        ],
        suggested,
      };
    }
  }

  return {
    session: { ...session, decisions: [...session.decisions, suggested] },
    problems: [],
    suggested,
  };
}
