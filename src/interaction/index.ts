/** The interaction surface: clarification, safe defaults, approvals, refusals, pauses, handoffs, and feedback. */
export type {
  InteractionApproval,
  InteractionApprovalDecision,
  InteractionApprovalRequest,
  InteractionCheck,
  InteractionCheckpoint,
  InteractionCorrection,
  InteractionDecision,
  InteractionFeedback,
  InteractionFeedbackOutcome,
  InteractionHandoff,
  InteractionHandoffTarget,
  InteractionProblem,
  InteractionQuestion,
  InteractionRefusal,
  InteractionRefusalSource,
  InteractionSession,
  InteractionStage,
  InteractionStatus,
} from "../contracts/interaction.ts";
export { answerClarification, clarifyInteraction, type ClarifyInteractionOptions } from "./clarify.ts";
export {
  approvalProblem,
  approvalValidity,
  decideApproval,
  isApproved,
  requestApproval,
  type ApprovalDecisionInput,
  type ApprovalRequestInput,
  type ApprovalScope,
  type ApprovalValidity,
} from "./approvals.ts";
export {
  pauseInteraction,
  resumeInteraction,
  type PauseInteractionInput,
  type ResumeInteractionInput,
} from "./checkpoint.ts";
export {
  recordDefault,
  type DefaultInput,
  type DefaultRisk,
  type RecordDefaultResult,
} from "./defaults.ts";
export { recordFeedback, type FeedbackInput } from "./feedback.ts";
export {
  handOffInteraction,
  handoffValidity,
  resumeHandoff,
  type HandoffInteractionInput,
  type HandoffValidity,
  type ResumeHandoffInput,
  type ResumeHandoffResult,
} from "./handoff.ts";
export { type InteractionResult } from "./result.ts";
export {
  advanceInteraction,
  applyInteractionEdit,
  finishInteraction,
  INTERACTION_DOCUMENT_VERSION,
  INTERACTION_STAGES,
  INTERACTION_STATUSES,
  PAUSE_STAGES,
  recoverInteraction,
  refuseInteraction,
  startInteraction,
  type AdvanceInteractionInput,
  type ApplyInteractionEditInput,
  type FinishInteractionInput,
  type RecoverInteractionInput,
  type RefuseInteractionInput,
  type StartInteractionInput,
} from "./session.ts";
