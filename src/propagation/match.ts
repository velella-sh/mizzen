/**
 * Match a change set against one consumer's declared dependencies. Only an external event matches, and only a
 * dependency the consumer actually declared: a surface event matches a surface or symbol declaration by its stable id,
 * a behavior event matches a behavior declaration, and a page declaration matches a change whose page it names.
 * Nothing is inferred from a similar label, so a change no consumer declared leaves every consumer unaffected.
 */
import type {
  AffectedDependency,
  ChangeSubject,
  ConsumerDeclaration,
  ConsumedDependency,
  SemanticChange,
} from "../contracts/propagation.ts";
import { byCodePoint } from "./contract.ts";
import { severityFor } from "./severity.ts";

/** The subject a dependency kind observes, or `undefined` for a page/file-only dependency. */
function subjectOf(kind: ConsumedDependency["kind"]): ChangeSubject | undefined {
  if (kind === "behavior") return "behavior";
  if (kind === "decision") return "decision";
  if (kind === "evidence") return "evidence";
  if (kind === "page") return undefined;
  return "surface";
}

/** True when the dependency's own pages or files name the changed record's. */
function overlaps(dependency: ConsumedDependency, event: SemanticChange): boolean {
  const pages = new Set([...(event.pages ?? []), ...(event.files ?? [])]);
  if (dependency.kind === "page" && pages.has(dependency.id)) return true;
  for (const page of dependency.pages ?? []) if (pages.has(page)) return true;
  for (const file of dependency.files ?? []) if (pages.has(file)) return true;
  return false;
}

/** True when one dependency observes one event. */
function matches(dependency: ConsumedDependency, event: SemanticChange): boolean {
  if (event.external !== true) return false;
  if (overlaps(dependency, event)) return true;
  const subject = subjectOf(dependency.kind);
  if (subject === undefined || event.subject !== subject) return false;
  return (
    event.ref === dependency.id ||
    event.ref === `${dependency.kind}:${dependency.id}` ||
    event.record === dependency.id
  );
}

/**
 * Every dependency of `consumer` that `events` affects, with the severity the consumer's policy gives it. A change the
 * consumer did not declare produces no entry.
 */
export function matchChanges(
  consumer: ConsumerDeclaration,
  events: readonly SemanticChange[],
  snapshotVersion: string,
): AffectedDependency[] {
  const affected: AffectedDependency[] = [];
  for (const dependency of consumer.consumes) {
    for (const change of events) {
      if (!matches(dependency, change)) continue;
      affected.push({
        consumer: consumer.id,
        project: consumer.project,
        dependency,
        change,
        severity: severityFor(change, consumer.policy, snapshotVersion),
      });
    }
  }
  return affected.sort(
    (a, b) =>
      byCodePoint(a.consumer, b.consumer) ||
      byCodePoint(a.dependency.kind, b.dependency.kind) ||
      byCodePoint(a.dependency.id, b.dependency.id) ||
      byCodePoint(a.change.ref, b.change.ref) ||
      byCodePoint(a.change.kind, b.change.kind) ||
      byCodePoint(a.change.hash, b.change.hash),
  );
}

/** The distinct changes in an affected list, in their existing order. */
export function distinctChanges(affected: readonly AffectedDependency[]): SemanticChange[] {
  const seen = new Set<string>();
  const changes: SemanticChange[] = [];
  for (const entry of affected) {
    const key = `${entry.change.subject}\u0000${entry.change.ref}\u0000${entry.change.kind}\u0000${entry.change.hash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    changes.push(entry.change);
  }
  return changes;
}
