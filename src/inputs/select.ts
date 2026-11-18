/**
 * Which collections a package carries: the requested ones plus every collection their `references` fields point at,
 * followed to a fixed point so a record page can resolve every link it renders. The result is sorted by name, so the
 * same selection always writes the same manifest.
 */
import type { SiteConfig } from "../contracts/index.ts";

/** The collections a package carries, and the requested names the config does not declare. */
export interface InputSelection {
  /** The selected collections, sorted by name. */
  readonly ids: readonly string[];
  /** Requested names that are not collections in the config. */
  readonly unknown: readonly string[];
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Selects `requested` (all collections when absent) and closes over `references` targets. */
export function selectCollections(config: SiteConfig, requested?: readonly string[]): InputSelection {
  const declared = config.collections;
  const unknown = (requested ?? []).filter((name) => declared[name] === undefined);
  const start =
    requested === undefined || requested.length === 0
      ? Object.keys(declared)
      : requested.filter((name) => declared[name] !== undefined);

  const selected = new Set<string>();
  const queue = [...start];
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (selected.has(name)) continue;
    selected.add(name);
    for (const target of Object.values(declared[name]?.references ?? {})) {
      if (declared[target] !== undefined && !selected.has(target)) queue.push(target);
    }
  }
  return { ids: [...selected].sort(compare), unknown };
}
