/** The verification surface: plan, claims, evidence, bounded checks, proof, independent verification, and receipt. */
export { bindClaims, canComplete, completionOf, verificationVerdict, type ClaimEvidenceInput, type CompletionResult, type VerdictInput } from "./evidence.ts";
export { normalizeExampleOutput, verifyExample, type ExampleVerification, type VerificationExample } from "./examples.ts";
export { planIsComplete, planVerification, type VerificationCheckSpec } from "./plan.ts";
export {
  createVerificationProof,
  formatVerificationProof,
  MAX_PROOF_BYTES,
  parseVerificationProof,
  proofHashMatches,
  proofHashOf,
  proofVersionOf,
  transactionIdOf,
  VerificationError,
  type VerificationProofInput,
} from "./proof.ts";
export { verifyReceipt, type ReceiptInput } from "./receipt.ts";
export {
  compareReferences,
  referenceKey,
  referencesMessage,
  type ReferencePolicy,
  type ReferenceSnapshot,
} from "./references.ts";
export { inputHashOf, reproductionEvidence, type ReproductionInput } from "./reproduce.ts";
export { exampleChecks, type ExampleProofInput } from "../examples/proof.ts";
export { changeOf, scopeAllows, scopeHash, scopeMessage, scopeProof, type ScopeInput } from "./scope.ts";
export { independentlyVerify, type IndependentVerifyOptions } from "./verify.ts";
