/**
 * A reference to a record of another project, resolved from the locked targets only, so the build stays offline. The
 * record is named by its project, collection, and stable id: the id does not change when the record's page does, so a
 * reference keeps working after a rename once the lock is updated.
 *
 * A reference to an id neither lock holds is unknown. A reference an earlier lock held, but the current one does not,
 * names a record that was removed, and says so instead of looking like a typo.
 */
import type { Diagnostic, SourcePos } from "../contracts/index.ts";
import type { RecordTarget } from "./record-targets.ts";

/** A record reference, as written at one position in a source file. */
export interface RecordReference {
  readonly project: string;
  readonly collection: string;
  /** The record's stable id. */
  readonly id: string;
  /** Where the reference is written, for diagnostics. */
  readonly pos: SourcePos;
}

/** The locked inputs a reference is resolved from. */
export interface RecordReferenceLock {
  /** The targets of the current lock. */
  readonly targets: readonly RecordTarget[];
  /** Targets an earlier lock held; one missing from {@link targets} was removed, not mistyped. */
  readonly previous?: readonly RecordTarget[];
}

/** The outcome of resolving one reference: its target when sound, and the findings either way. */
export interface RecordReferenceResolution {
  readonly resolved?: RecordTarget;
  readonly diagnostics: readonly Diagnostic[];
}

/** The key a target is looked up by. */
function keyOf(project: string, collection: string, id: string): string {
  return `${project}\u0000${collection}\u0000${id}`;
}

/** The targets by their project, collection, and id. */
function targetsByKey(targets: readonly RecordTarget[]): ReadonlyMap<string, RecordTarget> {
  return new Map(targets.map((target) => [keyOf(target.project, target.collection, target.id), target]));
}

/**
 * Resolves `reference` in the locked targets.
 *
 * - `network.record-missing`: no lock holds the id. An error.
 * - `network.record-removed`: an earlier lock held it and the current one does not. An error.
 */
export function resolveRecordReference(
  reference: RecordReference,
  lock: RecordReferenceLock,
): RecordReferenceResolution {
  const { project, collection, id, pos } = reference;
  const address = `${project}/${collection}/${id}`;
  const target = targetsByKey(lock.targets).get(keyOf(project, collection, id));
  if (target !== undefined) return { resolved: target, diagnostics: [] };

  const before = lock.previous === undefined
    ? undefined
    : targetsByKey(lock.previous).get(keyOf(project, collection, id));
  if (before !== undefined) {
    return {
      diagnostics: [{
        id: "network.record-removed",
        severity: "error",
        message: `The record "${address}" is no longer published; it was last at ${before.url}.`,
        help: `Remove the reference, or point it at the record that replaced it in "${project}".`,
        pos,
      }],
    };
  }
  return {
    diagnostics: [{
      id: "network.record-missing",
      severity: "error",
      message: `The locked inputs list no record "${address}".`,
      help: `Check the project, collection, and id; run \`mizzen network update\` if the record is new.`,
      pos,
    }],
  };
}
