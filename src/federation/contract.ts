/**
 * The small pure primitives every federation module shares: the canonical JSON that makes equal content hash alike, the
 * fully qualified identity that keeps two projects' same-named nodes apart, and the version comparison an inclusive
 * range needs. Nothing here reads a clock, a network, or the environment.
 */
import type { KnowledgeBundle } from "../contracts/federation.ts";
import { canonicalJson, sha256 } from "../data/lock.ts";

/** Compares strings by code point, never by locale. */
export function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The digest of a bundle: SHA-256 over its canonical body, without the `digest` field itself. */
export function bundleDigest(bundle: Omit<KnowledgeBundle, "digest"> | KnowledgeBundle): string {
  const body = bundle as unknown as Record<string, unknown>;
  const { digest: _digest, ...rest } = body;
  return sha256(canonicalJson(rest));
}

/** The composed graph's identity: `fed:` and the first 32 hex characters of its own contents. */
export function compositionDigest(part: unknown): string {
  return `fed:${sha256(canonicalJson(part)).slice(0, 32)}`;
}

/** The digest an evidence link names: SHA-256 over the target node's identity, so a chain can prove it unchanged. */
export function evidenceDigest(project: string, snapshot: string, local: string): string {
  return sha256(canonicalJson({ project, snapshot, local }));
}

/** The fully qualified identity: `<project>/<snapshot>/<local id>`. */
export function federatedId(project: string, snapshot: string, local: string): string {
  return `${project}/${snapshot}/${local}`;
}

/** One parsed fully qualified identity, or `undefined` when the text is not one. */
export interface QualifiedId {
  readonly project: string;
  readonly snapshot: string;
  readonly local: string;
}

/**
 * Reads a fully qualified identity. A project id and a snapshot id never contain `/`, so exactly two separators are
 * required and a local id may contain any character after them, including none.
 */
export function parseFederatedId(value: string): QualifiedId | undefined {
  const first = value.indexOf("/");
  if (first <= 0) return undefined;
  const second = value.indexOf("/", first + 1);
  if (second <= first + 1) return undefined;
  const project = value.slice(0, first);
  const snapshot = value.slice(first + 1, second);
  const local = value.slice(second + 1);
  return local === "" ? undefined : { project, snapshot, local };
}

/** The numeric and non-numeric parts of a version, such as `1.2.0-rc.1`. */
function versionParts(version: string): readonly (number | string)[] {
  return version
    .split(/[.+-]/)
    .filter((part) => part !== "")
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part));
}

/**
 * Compares two version names deterministically: numeric segments numerically, missing segments as zero, and a
 * non-numeric segment by code point. Publishing time is never a tie-break.
 */
export function compareVersions(a: string, b: string): number {
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

/** One bound of an inclusive range. */
interface Bound {
  readonly version: string;
  readonly inclusive: boolean;
}

/** A parsed range: lower and upper bounds, or `undefined` for an unbounded side. */
interface Range {
  readonly lower?: Bound;
  readonly upper?: Bound;
}

/** One match of `>=1.2.0` and the like; a bound must carry a digit, so a bare word is not a version. */
const RANGE_TOKEN = /^(>=|<=|>|<|=)?\s*v?([^\s]+)$/;

/** True when a range term names a version: it holds a digit and is not just punctuation. */
function isVersionTerm(text: string): boolean {
  return /\d/.test(text) && /^[0-9A-Za-z.+_-]+$/.test(text);
}

/**
 * Parses an inclusive or exclusive range such as `>=1.2.0 <2.0.0`, `1.2.0`, or `>=1.2`. Whitespace joins terms.
 * An unparseable term is `undefined`, so the caller can report it instead of silently accepting everything.
 */
export function parseVersionRange(text: string): Range | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  let lower: Bound | undefined;
  let upper: Bound | undefined;
  for (const token of trimmed.split(/\s+/)) {
    const match = RANGE_TOKEN.exec(token);
    if (match === null) return undefined;
    const operator = match[1] ?? "=";
    const version = match[2]!;
    if (!isVersionTerm(version)) return undefined;
    if (operator === "=") {
      // An exact version is both bounds, inclusive.
      lower = { version, inclusive: true };
      upper = { version, inclusive: true };
      continue;
    }
    if (operator === ">=" || operator === ">") {
      lower = { version, inclusive: operator === ">=" };
    } else {
      upper = { version, inclusive: operator === "<=" };
    }
  }
  return lower === undefined && upper === undefined
    ? undefined
    : {
        ...(lower === undefined ? {} : { lower }),
        ...(upper === undefined ? {} : { upper }),
      };
}

/** True when `version` satisfies `range`. */
export function versionInRange(version: string, range: string): boolean {
  const parsed = parseVersionRange(range);
  if (parsed === undefined) return false;
  if (parsed.lower !== undefined) {
    const order = compareVersions(version, parsed.lower.version);
    if (order < 0 || (order === 0 && !parsed.lower.inclusive)) return false;
  }
  if (parsed.upper !== undefined) {
    const order = compareVersions(version, parsed.upper.version);
    if (order > 0 || (order === 0 && !parsed.upper.inclusive)) return false;
  }
  return true;
}

/** True when the version text is a non-empty name, so a malformed range is refused rather than matched. */
export function isVersionRange(text: string): boolean {
  return parseVersionRange(text) !== undefined;
}
