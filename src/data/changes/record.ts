/**
 * One record's own history: the events of its collection's history file whose `record` is its id, newest first.
 *
 * A renamed record keeps its earlier events. The ids followed are the record's `aliases` field and the `from` of every
 * `renamed` event that leads to the current id, so a chain of renames still finds the first `added` event.
 */
import type { ChangeEvent, Collection, CollectionConfig } from "../../contracts/index.ts";

/** The events of one history collection. */
export function eventsOf(collection: Collection | undefined): readonly ChangeEvent[] {
  if (collection === undefined) return [];
  return collection.records.map((record) => record.fields as unknown as ChangeEvent);
}

/** The earlier ids a record names in its `aliases` field. */
function aliasesOf(fields: Readonly<Record<string, unknown>>, entry: CollectionConfig): readonly string[] {
  const field = entry.aliases;
  if (field === undefined) return [];
  const value = fields[field];
  const values = Array.isArray(value) ? value : [value];
  return values.filter((item): item is string => typeof item === "string" && item !== "");
}

/** The record's id and every earlier id its history and aliases name, in the order they were found. */
export function followedIds(id: string, fields: Readonly<Record<string, unknown>>, entry: CollectionConfig, events: readonly ChangeEvent[]): readonly string[] {
  const ids = new Set<string>([id, ...aliasesOf(fields, entry)]);
  let grown = true;
  while (grown) {
    grown = false;
    for (const event of events) {
      if (event.type !== "renamed" || event.from === undefined || !ids.has(event.record) || ids.has(event.from)) continue;
      ids.add(event.from);
      grown = true;
    }
  }
  return [...ids];
}

/** The record's events, newest first; equal dates are ordered by event id so two builds agree. */
export function recordChanges(events: readonly ChangeEvent[], id: string, fields: Readonly<Record<string, unknown>>, entry: CollectionConfig): readonly ChangeEvent[] {
  const ids = new Set(followedIds(id, fields, entry, events));
  return events
    .filter((event) => ids.has(event.record))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** True when a template asks for the record's history with a `:::changes` block. */
export function showsChanges(body: string): boolean {
  return body.includes(":::changes");
}
