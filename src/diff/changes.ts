/**
 * The history entries a pull request would add: what `mizzen data changes` finds pending in the site as it is checked
 * out. Nothing is written; a site with no `changelog`, or whose changes cannot be read, reports none, and the diff
 * says nothing about history rather than failing.
 */
import { dataChanges } from "../data/changes/write.ts";
import type { PendingChanges } from "./types.ts";

/** The pending events of every collection that has a changelog, by collection name. */
export async function pendingChanges(root: string): Promise<readonly PendingChanges[]> {
  const result = await dataChanges({ root });
  if (result.code !== 0) return [];
  const byCollection = new Map<string, PendingChanges["events"][number][]>();
  for (const { collection, event, summary } of result.pending) {
    const events = byCollection.get(collection) ?? [];
    events.push({ type: event.type, record: event.record, ...(event.field === undefined ? {} : { field: event.field }), summary, date: event.date });
    byCollection.set(collection, events);
  }
  return [...byCollection].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([collection, events]) => ({ collection, events }));
}
