/** The access-policy surface: parse, decide, delegate, resolve writes, redact, and audit. */
export {
  ACCESS_POLICY_VERSION,
  ACCESS_STAGES,
  accessPolicyFingerprint,
  defaultAccessPolicy,
  parseAccessPolicy,
  parseAccessPolicyText,
  readPolicyWithin,
  scopeSize,
} from "./policy.ts";
export {
  anyReferenceMatches,
  byCodePoint,
  destinationMatches,
  destinationOf,
  hostOf,
  isGlob,
  normalizeReference,
  pathMatches,
  referenceMatches,
  referencesWithin,
  sitePathProblem,
} from "./match.ts";
export {
  approvalValid,
  auditOf,
  decideAccess,
  delegatePolicy,
  executeRule,
  namesWithin,
  networkRule,
  readRule,
  sortAudit,
  writeRule,
  writeScopeWithin,
} from "./evaluate.ts";
export {
  checkTransactionArtifacts,
  checkWriteTarget,
  resolveWriteTarget,
  scopeOfFile,
  type ResolvedWriteTarget,
  type WriteResolution,
  type WriteTargetDecision,
  type WriteTargetRequest,
} from "./write.ts";
export {
  ACCESS_REDACTED,
  fieldIsReadable,
  omissionPlaceholder,
  redactAccessText,
  redactFields,
} from "./redact.ts";
export { audiencesOf, pageResource, readablePage } from "./read.ts";
export { auditLedger, auditLine } from "./audit.ts";
export { readAccessPolicyFile, type AccessPolicyFileResult } from "./file.ts";
