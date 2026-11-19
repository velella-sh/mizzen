/**
 * Prove that a change stayed in scope (#1183).
 *
 * The caller supplies the files before and after, the paths the task was allowed to touch, and
 * the paths it said it would touch. The result always carries the complete change list, sorted
 * by path; `outOfScope` names a changed file the task did not allow, and `unexpected` names a
 * changed file it did not claim. Both are failures, so a change cannot hide by being omitted
 * from the list: the list is derived from the before-and-after hashes, not from the claim.
 *
 * An allowed entry that ends with `/` allows the folder, which is how a task names a folder it
 * owns without listing every file in it.
 */
import type { VerificationChange, VerificationScope } from "../contracts/verification.ts";
import { canonicalJson } from "../data/lock.ts";
import { sha256 } from "../data/lock.ts";

/** One changed file from the comparison. */
export interface ScopeInput {
  /** The paths the task allowed, exact or folder prefixes ending in `/`. */
  readonly allowed: readonly string[];
  /** The paths the task said it would change. An empty list claims no specific file. */
  readonly expected: readonly string[];
  readonly changes: readonly VerificationChange[];
}

/** True when `path` is allowed by an exact entry or a folder entry. */
export function scopeAllows(allowed: readonly string[], path: string): boolean {
  return allowed.some((entry) => entry === path || (entry.endsWith("/") && path.startsWith(entry)));
}

/** The scope proof, with every change and every path outside the claim. */
export function scopeProof(input: ScopeInput): VerificationScope {
  const changes = [...input.changes].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const allowed = [...new Set(input.allowed)].sort();
  const expected = [...new Set(input.expected)].sort();
  const outOfScope = changes.filter((change) => !scopeAllows(allowed, change.path)).map((change) => change.path);
  const unexpected = expected.length === 0
    ? []
    : changes
        .filter((change) => scopeAllows(allowed, change.path) && !scopeAllows(expected, change.path))
        .map((change) => change.path);
  return {
    allowed,
    expected,
    changes,
    outOfScope,
    unexpected,
    ok: outOfScope.length === 0 && unexpected.length === 0,
  };
}

/** A file's before-and-after hashes from its contents; `null` means absent. */
export function changeOf(
  path: string,
  before: string | Uint8Array | null,
  after: string | Uint8Array | null,
): VerificationChange {
  return {
    path,
    before: before === null ? null : sha256(before),
    after: after === null ? null : sha256(after),
  };
}

/** One stable sentence listing every path, for a caller that reports a failed scope. */
export function scopeMessage(scope: VerificationScope): string {
  if (scope.ok) {
    return `every changed file is in scope: ${scope.changes.length} change${scope.changes.length === 1 ? "" : "s"}.`;
  }
  const parts: string[] = [];
  if (scope.outOfScope.length > 0) parts.push(`out of scope: ${scope.outOfScope.join(", ")}`);
  if (scope.unexpected.length > 0) parts.push(`unexpected: ${scope.unexpected.join(", ")}`);
  return `${parts.join("; ")}.`;
}

/**
 * The change list as comparable text: canonical JSON of the sorted paths and hashes. Two runs
 * over the same files give the same text, and the text carries no local path.
 */
export function scopeHash(scope: VerificationScope): string {
  return sha256(canonicalJson(scope.changes));
}
