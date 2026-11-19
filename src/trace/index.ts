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
