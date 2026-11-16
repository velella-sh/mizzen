/**
 * Summarizes changes by record, from the page JSON files of the pages that changed.
 *
 * Only the JSON of added, removed, and changed pages is read. A record page's JSON carries its collection, id, and
 * fields; a list page's JSON carries the record ids it shows, so each record change names the list pages it touched.
 * A field value is printed only when both its old and new values are short; otherwise the report says the field
 * changed and nothing more.
 */
import type { Build, BuildPage } from "./builds.ts";
import { byCodePoint } from "./builds.ts";
import { jsonOf } from "./pages.ts";
import type { PageDelta } from "./pages.ts";
import type { Reader } from "./reader.ts";
import type { CollectionDiff, FieldChange, RecordRef } from "./types.ts";

/** The longest value, in characters of its JSON text, a report prints. */
export const SHORT_VALUE = 40;

interface Seen {
  readonly page: BuildPage;
  readonly side: "base" | "head";
  readonly json: Record<string, unknown>;
}

interface RecordJson {
  readonly collection: string;
  readonly id: string;
  readonly fields: Record<string, unknown>;
}

interface ListJson {
  readonly collection: string;
  readonly records: readonly string[];
}

/** JSON with object keys sorted, so equal values compare equal whatever their key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.keys(value).sort(byCodePoint).map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function recordOf(json: Record<string, unknown>): RecordJson | undefined {
  const record = json.record;
  if (typeof record !== "object" || record === null) return undefined;
  const { collection, id, fields } = record as { collection?: unknown; id?: unknown; fields?: unknown };
  if (typeof collection !== "string" || typeof id !== "string") return undefined;
  const object = typeof fields === "object" && fields !== null && !Array.isArray(fields) ? (fields as Record<string, unknown>) : {};
  return { collection, id, fields: object };
}

function listOf(json: Record<string, unknown>): ListJson | undefined {
  const list = json.list;
  if (typeof list !== "object" || list === null) return undefined;
  const { collection, records } = list as { collection?: unknown; records?: unknown };
  if (typeof collection !== "string" || !Array.isArray(records)) return undefined;
  return { collection, records: records.filter((id): id is string => typeof id === "string") };
}

/** The fields whose value differs, by name, with short values attached. */
function fieldChanges(before: Record<string, unknown>, after: Record<string, unknown>): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const name of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort(byCodePoint)) {
    if (canonical(before[name]) === canonical(after[name])) continue;
    const was = canonical(before[name]);
    const now = canonical(after[name]);
    const short = was.length <= SHORT_VALUE && now.length <= SHORT_VALUE;
    changes.push(short ? { name, before: before[name] ?? null, after: after[name] ?? null } : { name });
  }
  return changes;
}

/** One record's accumulating state: the same record can appear on its page and on its views. */
interface Entry {
  url: string;
  viewless: boolean;
  fields: Map<string, FieldChange>;
}

/** Groups the record changes of changed, added, and removed pages by collection. */
export async function compareRecords(
  base: Build,
  head: Build,
  changed: readonly PageDelta[],
  added: readonly BuildPage[],
  removed: readonly BuildPage[],
  reader: Reader,
): Promise<CollectionDiff[]> {
  const addedRecords = new Map<string, Map<string, Entry>>();
  const removedRecords = new Map<string, Map<string, Entry>>();
  const changedRecords = new Map<string, Map<string, Entry>>();

  const entry = (table: Map<string, Map<string, Entry>>, collection: string, id: string, page: BuildPage): Entry => {
    let byId = table.get(collection);
    if (byId === undefined) table.set(collection, (byId = new Map()));
    let found = byId.get(id);
    const viewless = page.view === undefined;
    if (found === undefined) byId.set(id, (found = { url: page.url, viewless, fields: new Map() }));
    else if (viewless && !found.viewless) {
      found.url = page.url;
      found.viewless = true;
    }
    return found;
  };

  const listIds = new Map<string, { collection: string; ids: Set<string> }>();
  const addList = (page: BuildPage, json: Record<string, unknown>): void => {
    const list = listOf(json);
    if (list === undefined) return;
    const found = listIds.get(page.url);
    if (found === undefined) listIds.set(page.url, { collection: list.collection, ids: new Set(list.records) });
    else for (const id of list.records) found.ids.add(id);
  };

  for (const delta of changed) {
    const [before, after] = await Promise.all([
      reader.json(base, jsonOf(delta.base, base)),
      reader.json(head, jsonOf(delta.head, head)),
    ]);
    if (before !== undefined) addList(delta.base, before);
    if (after !== undefined) addList(delta.head, after);
    const was = before === undefined ? undefined : recordOf(before);
    const now = after === undefined ? undefined : recordOf(after);
    if (now === undefined || was === undefined || was.collection !== now.collection || was.id !== now.id) continue;
    const fields = fieldChanges(was.fields, now.fields);
    if (fields.length === 0) continue;
    const target = entry(changedRecords, now.collection, now.id, delta.head);
    for (const field of fields) target.fields.set(field.name, field);
  }
  for (const page of added) {
    const json = await reader.json(head, jsonOf(page, head));
    if (json === undefined) continue;
    addList(page, json);
    const record = recordOf(json);
    if (record !== undefined) entry(addedRecords, record.collection, record.id, page);
  }
  for (const page of removed) {
    const json = await reader.json(base, jsonOf(page, base));
    if (json === undefined) continue;
    addList(page, json);
    const record = recordOf(json);
    if (record !== undefined) entry(removedRecords, record.collection, record.id, page);
  }

  const touching = (collection: string, id: string): string[] =>
    [...listIds].filter(([, list]) => list.collection === collection && list.ids.has(id)).map(([url]) => url).sort(byCodePoint);
  const refs = (table: Map<string, Map<string, Entry>>, collection: string): RecordRef[] =>
    [...(table.get(collection) ?? [])]
      .sort(([a], [b]) => byCodePoint(a, b))
      .map(([id, found]) => {
        const listsOf = touching(collection, id);
        return { id, url: found.url, ...(listsOf.length === 0 ? {} : { lists: listsOf }) };
      });

  const collections = [...new Set([...addedRecords.keys(), ...removedRecords.keys(), ...changedRecords.keys()])].sort(byCodePoint);
  return collections.map((collection) => ({
    collection,
    added: refs(addedRecords, collection),
    removed: refs(removedRecords, collection),
    changed: [...(changedRecords.get(collection) ?? [])]
      .sort(([a], [b]) => byCodePoint(a, b))
      .map(([id, found]) => ({
        id,
        url: found.url,
        fields: [...found.fields.values()].sort((a, b) => byCodePoint(a.name, b.name)),
        lists: touching(collection, id),
      })),
  }));
}
