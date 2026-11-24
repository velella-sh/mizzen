/**
 * Stable ordering helpers shared by the decision modules. Every order is by code point, never by locale, so a report
 * and a query answer alike on every machine.
 */
import type { DecisionPublicEntry } from "../contracts/decisions.ts";

/** Compares two strings by code point. */
export function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sorts public entries by id. */
export function sortPublicEntries(entries: readonly DecisionPublicEntry[]): DecisionPublicEntry[] {
  return [...entries].sort((a, b) => byCodePoint(a.id, b.id));
}
