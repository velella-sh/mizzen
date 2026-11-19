/**
 * Record maintenance failures and preserve the last good state (#1241).
 *
 * A failed run appends a policy-safe record — stage, stable code, one sentence — and keeps the
 * snapshot, source hashes, proposal, and pull-request reference from the last good run. Nothing is
 * cleared and nothing resumes by itself: `retryMaintenance` is an explicit call, and the failure
 * history stays for audit. The state file is canonical JSON with a trailing LF, so two equal states
 * write the same bytes.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { TaskDocument } from "../contracts/task.ts";
import type {
  MaintenanceFailure,
  MaintenanceState,
  MaintenanceStateResult,
  MaintenanceStage,
} from "../contracts/index.ts";
import { canonicalJson } from "../data/lock.ts";

/** Where the state lives under a site root. */
export const MAINTENANCE_STATE_FILE = ".mizzen/maintenance.json";

const STAGES: readonly MaintenanceStage[] = [
  "trigger",
  "task",
  "patch",
  "preview",
  "verification",
  "recipe",
  "state",
];

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The sources with sorted keys, so two equal maps serialize alike. */
function sortedSources(sources: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const path of Object.keys(sources).sort(byCodePoint)) out[path] = sources[path]!;
  return out;
}

/** The state at the moment a proposal is ready, before any failure. */
export function maintenanceStateAt(
  task: TaskDocument,
  proposal: string,
  sources: Readonly<Record<string, string>>,
): MaintenanceState {
  return {
    version: 1,
    task: task.id,
    snapshot: task.snapshot.id,
    phase: "proposed",
    sources: sortedSources(sources),
    proposal,
    failures: [],
    retry: "explicit",
  };
}

/**
 * Appends one failure and marks the state failed. The returned `preserved` state is the exact input:
 * its snapshot, sources, proposal, and pull request stay the last good ones.
 */
export function recordMaintenanceFailure(
  state: MaintenanceState,
  failure: MaintenanceFailure,
): MaintenanceStateResult {
  if (!STAGES.includes(failure.stage)) {
    return {
      state: {
        ...state,
        phase: "failed",
        failures: [
          ...state.failures,
          { stage: "state", code: "maintenance.failure-stage", message: `Unknown failure stage \`${String(failure.stage)}\`.` },
        ],
      },
      preserved: state,
    };
  }
  return {
    state: {
      ...state,
      phase: "failed",
      failures: [...state.failures, { stage: failure.stage, code: failure.code.trim(), message: failure.message.trim() }],
    },
    preserved: state,
  };
}

/** What an explicit retry did. */
export interface MaintenanceRetry {
  readonly state: MaintenanceState;
  readonly resumed: boolean;
  readonly reason: string;
}

/**
 * Resumes a failed state on the caller's explicit request. A state that did not fail is returned
 * unchanged; a resume can move to a newer snapshot but keeps the failure history and sources until
 * a new run replaces them.
 */
export function retryMaintenance(state: MaintenanceState, snapshot?: string): MaintenanceRetry {
  if (state.phase !== "failed") {
    return { state, resumed: false, reason: "Only a failed state can be retried." };
  }
  return {
    state: { ...state, phase: "proposed", ...(snapshot === undefined ? {} : { snapshot }) },
    resumed: true,
    reason: "Retry requested explicitly; the previous failures are kept for audit.",
  };
}

/** The failure report: stage, code, and sentence, never a source file's content. */
export function maintenanceFailureReport(state: MaintenanceState): string {
  if (state.failures.length === 0) return "No maintenance failure is recorded.";
  return state.failures.map((failure) => `${failure.stage} ${failure.code}: ${failure.message}`).join("\n");
}

/** The state as canonical JSON with one trailing line feed. */
export function maintenanceStateText(state: MaintenanceState): string {
  return `${canonicalJson(state)}\n`;
}

/** Reads the state at `root`; a missing file is no state, a malformed one is a problem. */
export async function readMaintenanceState(
  root: string,
): Promise<{ readonly state?: MaintenanceState; readonly problems: readonly string[] }> {
  let text: string;
  try {
    text = await readFile(join(root, MAINTENANCE_STATE_FILE), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { problems: [] };
    return { problems: [`Cannot read ${MAINTENANCE_STATE_FILE}: ${err instanceof Error ? err.message : String(err)}`] };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return { problems: [`${MAINTENANCE_STATE_FILE} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const problem = stateProblem(value);
  return problem === undefined ? { state: value as MaintenanceState, problems: [] } : { problems: [problem] };
}

/** Writes the state under `root`, creating the folder. */
export async function writeMaintenanceState(root: string, state: MaintenanceState): Promise<void> {
  await mkdir(join(root, ".mizzen"), { recursive: true });
  await writeFile(join(root, MAINTENANCE_STATE_FILE), maintenanceStateText(state));
}

/** Why a parsed value is not a maintenance state, or `undefined`. */
function stateProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "The maintenance state must be an object.";
  const state = value as Record<string, unknown>;
  if (state.version !== 1) return "Only maintenance state version 1 is supported.";
  if (typeof state.task !== "string" || typeof state.snapshot !== "string") return "The maintenance state needs `task` and `snapshot`.";
  if (!["idle", "proposed", "verified", "failed"].includes(String(state.phase))) return "The maintenance state has an unknown phase.";
  if (!["explicit"].includes(String(state.retry))) return "The maintenance state must keep `retry: \"explicit\"`.";
  if (typeof state.sources !== "object" || state.sources === null || Array.isArray(state.sources)) return "The maintenance state needs a `sources` object.";
  if (!Array.isArray(state.failures)) return "The maintenance state needs a `failures` list.";
  return undefined;
}
