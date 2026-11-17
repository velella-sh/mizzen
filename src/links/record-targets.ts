/**
 * The public records a cross-site link may name: one target for each record of a public project, read from the
 * `urls.json` map the project publishes. A target is keyed by project, collection, and the record's stable id.
 *
 * Pure: it reads the maps it is given and nothing else, so a build stays offline. A map of a project that is not
 * public is not a source of targets, and a key declared twice is not a target at all: the reader cannot tell which
 * URL is meant, so it reports both cases and leaves them out instead of choosing one silently.
 */
import type { Diagnostic } from "../contracts/index.ts";

/** One project's `urls.json`, parsed: the URL of each record, by collection and id. */
export interface RecordUrlMap {
  readonly collections: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/** One project's URL map, with what decides whether its records may be linked to. */
export interface RecordTargetSource {
  /** The project's id, as the network names it. */
  readonly project: string;
  /** Only a public project's records are targets of a cross-site link. */
  readonly public: boolean;
  readonly urls: RecordUrlMap;
}

/** One record page a cross-site link may name. */
export interface RecordTarget {
  readonly project: string;
  readonly collection: string;
  /** The record's stable id; it does not change when the page's URL does. */
  readonly id: string;
  /** The record page's address, as the project's URL map gives it. */
  readonly url: string;
}

/** What {@link recordTargets} found: the targets that are sound, and the findings either way. */
export interface RecordTargetsRead {
  /** The targets, sorted by project, collection, and id. */
  readonly targets: readonly RecordTarget[];
  readonly diagnostics: readonly Diagnostic[];
}

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A target's identity: the key a duplicate is found by. */
function keyOf(target: RecordTarget): string {
  return `${target.project}\u0000${target.collection}\u0000${target.id}`;
}

/** Orders targets by project, collection, and id. */
function byTarget(a: RecordTarget, b: RecordTarget): number {
  return byCodePoint(a.project, b.project) || byCodePoint(a.collection, b.collection) || byCodePoint(a.id, b.id);
}

/**
 * Reads the URL maps of the given projects.
 *
 * - `network.record-private`: the project is not public. An error, and none of its records is a target.
 * - `network.record-duplicate`: two maps declare the same project, collection, and id. An error, and neither entry
 *   is a target, because the reader cannot know which page the reference meant.
 */
export function recordTargets(sources: readonly RecordTargetSource[]): RecordTargetsRead {
  const diagnostics: Diagnostic[] = [];
  const byKey = new Map<string, RecordTarget>();
  const duplicates = new Map<string, RecordTarget>();

  for (const source of sources) {
    if (!source.public) {
      diagnostics.push({
        id: "network.record-private",
        severity: "error",
        message: `The URL map of "${source.project}" was read, but the project is not public.`,
        help: "A public project cannot link to a hidden one. Make the project public in the network file, or remove it from the record targets.",
      });
      continue;
    }
    for (const collection of Object.keys(source.urls.collections).sort(byCodePoint)) {
      const records = source.urls.collections[collection];
      if (records === undefined) continue;
      for (const id of Object.keys(records).sort(byCodePoint)) {
        const url = records[id];
        if (url === undefined) continue;
        const target: RecordTarget = { project: source.project, collection, id, url };
        const key = keyOf(target);
        if (byKey.has(key)) duplicates.set(key, target);
        else byKey.set(key, target);
      }
    }
  }

  for (const target of [...duplicates.values()].sort(byTarget)) {
    diagnostics.push({
      id: "network.record-duplicate",
      severity: "error",
      message: `The record target "${target.project}/${target.collection}/${target.id}" is declared more than once, so none of them is used.`,
      help: "Keep one URL map for each project, with one URL for each record id.",
    });
  }

  const targets = [...byKey]
    .filter(([key]) => !duplicates.has(key))
    .map(([, target]) => target)
    .sort(byTarget);
  // Sorted, so the same sources report the same order wherever they came from.
  diagnostics.sort((a, b) => byCodePoint(a.id, b.id) || byCodePoint(a.message, b.message));
  return { targets, diagnostics };
}
