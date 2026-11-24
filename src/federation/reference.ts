/**
 * Snapshot version compatibility and stable references.
 *
 * A consumer declares the version or range of another project's snapshot it accepts. Selection is a pure function of
 * the lock and those rules: a `pinned` channel accepts exactly the locked snapshot, and a `compatible` channel accepts
 * it only when its version satisfies the range, so an unrelated later snapshot is never chosen in place of the pinned
 * one. Publishing time is never read.
 *
 * A reference names a project, a local node, and optionally the version it was resolved at. When the target was
 * removed, the answer says `removed` with the version it was recorded at; when only another version exists, it says
 * `incompatible`; and a project the caller may not read is `withheld`. It never resolves to an unrelated node.
 */
import type {
  FederatedCitation,
  FederatedGraph,
  FederatedReference,
  FederatedReferenceResolution,
  FederatedReferenceStatus,
  KnowledgeBundle,
  LoadedFederation,
} from "../contracts/federation.ts";
import { byCodePoint, compareVersions, federatedId, parseFederatedId, versionInRange } from "./contract.ts";
import { readable } from "./compose.ts";
import { resolveCitation } from "./query.ts";

/** The snapshot the lock pins for one project, or `undefined` when none is pinned. */
export function pinnedSnapshot(loaded: LoadedFederation, project: string): KnowledgeBundle["snapshot"] | undefined {
  return loaded.bundles.get(project)?.snapshot;
}

/** Why one project's snapshot is accepted, or the reason it is not. */
export interface VersionDecision {
  readonly accepted: boolean;
  readonly snapshot?: KnowledgeBundle["snapshot"];
  /** A stable reason, such as `pinned`, `compatible`, `incompatible`, or `missing`. */
  readonly reason: "pinned" | "compatible" | "incompatible" | "missing" | "unreadable";
  /** Every snapshot version the lock holds for the project, sorted, when the selection failed. */
  readonly available?: readonly string[];
}

/**
 * Selects the snapshot of `project` this consumer accepts. `requirement` is the manifest's declaration for that
 * project; without one, a `pinned` channel is used, because accepting an unstated version is the same as pinning it.
 * The choice reads only the lock and the declaration, never the publishing time.
 */
export function selectSnapshot(
  loaded: LoadedFederation,
  project: string,
  requirement: { readonly range?: string; readonly channel?: "pinned" | "compatible" } | undefined,
  allow?: readonly string[],
): VersionDecision {
  const bundle = loaded.bundles.get(project);
  if (bundle === undefined) return { accepted: false, reason: "missing" };
  if (!readable(bundle, allow)) return { accepted: false, reason: "unreadable" };
  const channel = requirement?.channel ?? "pinned";
  if (channel === "pinned" || requirement?.range === undefined) {
    return { accepted: true, snapshot: bundle.snapshot, reason: "pinned" };
  }
  if (versionInRange(bundle.snapshot.version, requirement.range)) {
    return { accepted: true, snapshot: bundle.snapshot, reason: "compatible" };
  }
  return { accepted: false, reason: "incompatible", available: [bundle.snapshot.version] };
}

/** Every snapshot version the lock records for a project, including a removal, sorted newest first. */
function versionsOf(loaded: LoadedFederation, project: string): string[] {
  const versions = new Set<string>();
  const bundle = loaded.bundles.get(project);
  if (bundle !== undefined) versions.add(bundle.snapshot.version);
  return [...versions].sort((a, b) => compareVersions(b, a) || byCodePoint(a, b));
}

/** The numeric major and minor a version starts with, such as `1.2` from `1.2.3-rc.1`. */
function majorMinor(version: string): readonly [number, number] {
  const match = /^v?(\d+)(?:\.(\d+))?/.exec(version.trim());
  return [Number(match?.[1] ?? 0), Number(match?.[2] ?? 0)];
}

/** True when `pinned` is the same major and at least the `referenced` version, so a compatible channel accepts it. */
function compatibleVersion(referenced: string, pinned: string): boolean {
  const [major, minor] = majorMinor(referenced);
  const [pinnedMajor, pinnedMinor] = majorMinor(pinned);
  if (pinnedMajor !== major) return false;
  return pinnedMinor > minor || (pinnedMinor === minor && compareVersions(pinned, referenced) >= 0);
}

/** The citation a resolved reference names, looked up in a composed graph. */
function citationIn(graph: FederatedGraph, project: string, id: string, version: string): FederatedCitation | undefined {
  return resolveCitation(graph, federatedId(project, version, id));
}

/**
 * Resolves a stable reference against the composed graph. The channel decides whether only the pinned version is
 * accepted or any compatible one; a version the reference names must match, so a reference written against one
 * snapshot never silently lands on another.
 */
export function resolveReference(
  graph: FederatedGraph,
  loaded: LoadedFederation,
  reference: FederatedReference,
): FederatedReferenceResolution {
  const bundle = loaded.bundles.get(reference.project);
  if (bundle === undefined) {
    const missing = loaded.missing.find((entry) => entry.project === reference.project);
    return {
      reference,
      status: "unknown",
      detail: missing === undefined
        ? `the federation holds no snapshot of "${reference.project}".`
        : `the snapshot of "${reference.project}" is missing: ${missing.reason}`,
    };
  }
  if (!graph.projects.some((project) => project.id === reference.project)) {
    return { reference, status: "withheld", detail: `the project "${reference.project}" is not readable.` };
  }

  const removed = bundle.removed.find((entry) => entry.id === reference.id);
  if (removed !== undefined && (reference.version === undefined || reference.version === removed.version)) {
    return { reference, status: "removed", at: removed.version, detail: `"${reference.id}" was removed in ${removed.version}.` };
  }

  const snapshot = bundle.snapshot;
  const at = snapshot.version;
  if (reference.version !== undefined) {
    const compatible = reference.channel === "compatible";
    if (reference.version !== at && !(compatible && compatibleVersion(reference.version, at))) {
      const available = versionsOf(loaded, reference.project);
      return {
        reference,
        status: "incompatible",
        at,
        detail: `the pinned snapshot of "${reference.project}" is ${at}, not ${reference.version}${available.length === 0 ? "" : `; available: ${available.join(", ")}`}.`,
      };
    }
  }

  const citation = citationIn(graph, reference.project, reference.id, snapshot.id);
  if (citation === undefined) {
    return {
      reference,
      status: "unknown",
      at,
      detail: `the snapshot of "${reference.project}" holds no node "${reference.id}".`,
    };
  }
  return { reference, status: "resolved", citation, at, detail: `resolved at ${at}.` };
}

/** Reads a reference from text, or `undefined` when it is not one this engine wrote. */
export function readReference(value: string): FederatedReference | undefined {
  const parsed = (() => {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  })();
  if (parsed === undefined || typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.kind !== "federation" || typeof record.project !== "string" || typeof record.id !== "string") return undefined;
  if (record.version !== undefined && typeof record.version !== "string") return undefined;
  if (record.channel !== undefined && record.channel !== "pinned" && record.channel !== "compatible") return undefined;
  return {
    kind: "federation",
    project: record.project,
    id: record.id,
    ...(record.version === undefined ? {} : { version: record.version as string }),
    ...(record.channel === undefined ? {} : { channel: record.channel as "pinned" | "compatible" }),
  };
}

/** A stable reference for a citation, for another feature such as Decision Memory to store. */
export function federatedReferenceOf(citation: FederatedCitation, version?: string): FederatedReference {
  return {
    kind: "federation",
    project: citation.project,
    id: citation.local,
    ...(version === undefined ? {} : { version }),
    channel: "pinned",
  };
}

/** The status order a resolution reports, for a deterministic list. */
export const REFERENCE_STATUSES: readonly FederatedReferenceStatus[] = [
  "resolved",
  "removed",
  "incompatible",
  "unknown",
  "withheld",
];

/** True when `value` is a fully qualified identity. */
export function isFederatedId(value: string): boolean {
  return parseFederatedId(value) !== undefined;
}
