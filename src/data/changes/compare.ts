/**
 * Compares two states of one collection and lists what changed, in a fixed order.
 *
 * Records are matched by id, never by position, so a reordered file records nothing. A record whose id appears in
 * another record's earlier ids (`aliases`) and that is gone from the current state is a rename, not a removal and an
 * addition. The result depends only on the two states, so the same input always gives the same list.
 */
import { canonicalJson } from "../lock.ts";

/** The part of a record a comparison reads. */
export interface ComparedRecord {
  readonly id: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

/** One difference between two states. */
export interface RecordChange {
  readonly type: "added" | "removed" | "changed" | "renamed";
  /** The record's id in the current state; for `removed`, in the earlier state. */
  readonly record: string;
  /** The changed field, for `changed`. */
  readonly field?: string;
  /** The earlier value, for `changed`; absent when the field did not exist. */
  readonly old?: unknown;
  /** The current value, for `changed`; absent when the field was removed. */
  readonly new?: unknown;
  /** The earlier id, for `renamed`. */
  readonly from?: string;
}

/** Options of {@link compareStates}. */
export interface CompareOptions {
  /** The field that holds a record's earlier ids (`collections.<name>.aliases`). */
  readonly aliases?: string;
  /** Whether a field is compared; every field is when absent. */
  readonly include?: (field: string) => boolean;
}

const ORDER = { added: 0, removed: 1, renamed: 2, changed: 3 } as const;

function byCode(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The earlier ids a record names, from a string or a list of strings. */
function earlierIds(record: ComparedRecord, field: string | undefined): readonly string[] {
  if (field === undefined) return [];
  const value = record.fields[field];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [];
}

function fieldChanges(before: ComparedRecord, after: ComparedRecord, include: (field: string) => boolean): RecordChange[] {
  const changes: RecordChange[] = [];
  const names = [...new Set([...Object.keys(before.fields), ...Object.keys(after.fields)])].filter(include).sort(byCode);
  for (const field of names) {
    const was = before.fields[field];
    const now = after.fields[field];
    if (canonicalJson(was) === canonicalJson(now)) continue;
    changes.push({
      type: "changed",
      record: after.id,
      field,
      ...(was === undefined ? {} : { old: was }),
      ...(now === undefined ? {} : { new: now }),
    });
  }
  return changes;
}

/** What changed from `before` to `after`, ordered by record id, then by type, then by field. */
export function compareStates(before: readonly ComparedRecord[], after: readonly ComparedRecord[], options: CompareOptions = {}): readonly RecordChange[] {
  const include = options.include ?? (() => true);
  const old = new Map(before.map((record) => [record.id, record]));
  const now = new Map(after.map((record) => [record.id, record]));
  const changes: RecordChange[] = [];
  const renamedFrom = new Set<string>();

  for (const record of after) {
    const earlier = old.get(record.id);
    if (earlier !== undefined) {
      changes.push(...fieldChanges(earlier, record, include));
      continue;
    }
    const from = earlierIds(record, options.aliases)
      .filter((id) => old.has(id) && !now.has(id) && !renamedFrom.has(id))
      .sort(byCode)[0];
    if (from === undefined) {
      changes.push({ type: "added", record: record.id });
      continue;
    }
    renamedFrom.add(from);
    changes.push({ type: "renamed", record: record.id, from });
    changes.push(...fieldChanges(old.get(from)!, record, include));
  }
  for (const record of before) {
    if (!now.has(record.id) && !renamedFrom.has(record.id)) changes.push({ type: "removed", record: record.id });
  }

  return changes.sort(
    (a, b) => byCode(a.record, b.record) || ORDER[a.type] - ORDER[b.type] || byCode(a.field ?? "", b.field ?? ""),
  );
}
