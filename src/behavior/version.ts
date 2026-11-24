/**
 * Behavior versioning: a deterministic comparison of product version names and the status a behavior had at one
 * version. Nothing reads the clock or the package; the caller passes the version explicitly, so two runs agree.
 */
import type {
  BehaviorEnvironment,
  BehaviorSupportStatus,
  BehaviorVersionHistory,
} from "../contracts/behavior.ts";

/** What versioning needs from a behavior: its current status, its history, and its environment scope. */
export interface VersionedBehavior {
  readonly status: BehaviorSupportStatus;
  readonly versions: BehaviorVersionHistory;
  readonly environments: readonly BehaviorEnvironment[];
}

/** The numeric parts of a version name, such as `0.2.7` to `[0, 2, 7]`, or `undefined` when it has none. */
function versionParts(version: string): readonly (number | string)[] {
  return version
    .split(/[.+-]/)
    .filter((part) => part !== "")
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part));
}

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Compares two product version names: numeric segments numerically, missing segments as zero, and a non-numeric
 * segment by code point. A plain name such as `v2` still has a stable order. The comparison is total and deterministic.
 */
export function compareBehaviorVersions(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const one = left[index] ?? 0;
    const two = right[index] ?? 0;
    if (typeof one === "number" && typeof two === "number") {
      if (one !== two) return one < two ? -1 : 1;
      continue;
    }
    const difference = byCodePoint(String(one), String(two));
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * The status a behavior had at `version`, or `undefined` when the version is before its introduction. A version at or
 * after `removed` is `removed`; at or after `deprecated` is `deprecated`; after introduction is the current status, or
 * `supported` when the current status is a later milestone. That way a removed behavior is not reported as removed
 * before its removal version.
 */
export function statusAtVersion(
  behavior: VersionedBehavior,
  version: string,
): BehaviorSupportStatus | undefined {
  const { versions } = behavior;
  if (compareBehaviorVersions(version, versions.introduced) < 0) return undefined;
  if (versions.removed !== undefined && compareBehaviorVersions(version, versions.removed) >= 0) return "removed";
  if (versions.deprecated !== undefined && compareBehaviorVersions(version, versions.deprecated) >= 0) return "deprecated";
  if (behavior.status === "removed" || behavior.status === "deprecated") return "supported";
  return behavior.status;
}

/** True when the environment query names no dimension at all. */
function emptyEnvironment(environment: BehaviorEnvironment | undefined): boolean {
  return (
    environment === undefined ||
    (environment.os === undefined && environment.language === undefined && environment.runtime === undefined)
  );
}

/**
 * Whether a behavior's environments cover a query. A behavior with no environments applies everywhere; a query with
 * no dimensions matches every behavior. Otherwise one declared environment must agree on every dimension the query
 * names; a dimension the declaration leaves out covers every value on that dimension.
 */
export function environmentCovers(
  environments: readonly BehaviorEnvironment[],
  query: BehaviorEnvironment | undefined,
): boolean {
  if (emptyEnvironment(query)) return true;
  if (environments.length === 0) return true;
  return environments.some((environment) => {
    if (query?.os !== undefined && environment.os !== undefined && environment.os !== query.os) return false;
    if (query?.language !== undefined && environment.language !== undefined && environment.language !== query.language) return false;
    if (query?.runtime !== undefined && environment.runtime !== undefined && environment.runtime !== query.runtime) return false;
    return true;
  });
}

