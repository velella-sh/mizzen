/**
 * Downstream change propagation: diff two locked snapshots into semantic events, match them to the consumers that
 * declared them, preview the downstream snapshots, pages, and tasks, and apply the result under each consumer's
 * approval policy with a deterministic receipt. This index re-exports the engine so a caller imports one module.
 */
export {
  actionFor,
  byCodePoint,
  changeSetHash,
  compareChanges,
  propagationIdOf,
  proposalChangesOf,
  refOf,
  stableHash,
  strongerSeverity,
  taskProposalIdOf,
  uniqueSorted,
} from "./contract.ts";
export { diffSnapshots, changesOf, refsOf } from "./diff.ts";
export { createsTask, impactOf, receiptIdFor } from "./impact.ts";
export {
  DEPENDENCY_KINDS,
  PROPAGATION_ACTIONS,
  PROPAGATION_MANIFEST_FILE,
  consumerOf,
  parsePropagationManifest,
} from "./manifest.ts";
export { distinctChanges, matchChanges } from "./match.ts";
export { authorizedEvidence, evidenceAllowed, proposeTask } from "./propose.ts";
export {
  PROPAGATION_LEDGER_FILE,
  emptyLedger,
  findReceipt,
  isPropagationLedger,
  ledgerText,
  readPropagationLedger,
  recordReceipt,
  verifyReceipt,
  withVerifiedReceipt,
  writePropagationLedger,
} from "./receipt.ts";
export { applyPropagation, previewPropagation } from "./run.ts";
export type { PropagationApplyInput, PropagationPreviewInput } from "./run.ts";
export { acceptsVersion, overallSeverity, severityFor, severityOfChange } from "./severity.ts";
export { identityOfSnapshot, isReadable, snapshotOfBundle } from "./snapshot.ts";
