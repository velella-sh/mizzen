/** The trace surface: parsing, recording, costs, search, export, retention, replay, and handoff. */
export { parseTrace, TRACE_VERSION, DECISION_KINDS, traceIdOf, nondeterministicOf } from "./parse.ts";
export { TraceRecorder, TraceRecordError, costProblems, type TraceAppendRequest, type TraceRecorderOptions } from "./record.ts";
export {
  PRIVATE_REASONING_KEYS,
  hasCredential,
  hasPrivateReasoning,
  inputHashOf,
  isLocalPath,
  receiptIdOf,
  redactText,
  referenceProblem,
} from "./safe.ts";
export { traceUsage, usageProblems, traceBudgetStops } from "./cost.ts";
export {
  TRACE_STAGES,
  TRACE_STATUSES,
  compactSummary,
  matchesEvent,
  matchesTask,
  searchTrace,
  summaryOf,
} from "./query.ts";
export { replayTrace, compareTraces, type TraceReplayOptions } from "./replay.ts";
export { TraceExportError, exportFilename, exportJson, exportTrace } from "./export.ts";
export { DEFAULT_TRACE_LIMITS, boundTrace, type TraceLimits } from "./retain.ts";
export { handoffOf } from "./handoff.ts";
export {
  recordEditApply,
  recordMcpEdit,
  recordPack,
  recordVerification,
  siteReference,
  standaloneTrace,
  traceEditApply,
  traceMcpEdit,
  tracePack,
  traceVerification,
  writeTraceFromEnv,
  type AppliedEdit,
  type CompiledContext,
  type McpEditResult,
  type RecordOptions,
  type StandaloneTrace,
  type VerifiedProof,
} from "./instrument.ts";
