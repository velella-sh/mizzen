/**
 * Which fields of a collection the history follows, and how an event reads.
 *
 * Nothing is tracked by default: a collection records the fields `collections.<name>.changelog.track` names, minus
 * those in `ignore`. A summary template per event type writes the text from the record's fields.
 */
import type { CollectionChangelogConfig, ChangelogEventType } from "../../contracts/index.ts";

/** The templates used when a collection names none. */
export const DEFAULT_LABELS: Readonly<Record<ChangelogEventType, string>> = {
  added: "Added {id}",
  removed: "Removed {id}",
  changed: "Changed {field} of {id}",
  renamed: "Renamed {from} to {id}",
  imported: "Imported {count} records",
};

/** A predicate for the fields the collection follows; every field answers false when none is tracked. */
export function tracked(config: CollectionChangelogConfig | undefined): (field: string) => boolean {
  const track = new Set(config?.track ?? []);
  const ignore = new Set(config?.ignore ?? []);
  return (field) => track.has(field) && !ignore.has(field);
}

/** The tracked fields that no record of the collection has; each is a mistake in the config. */
export function unknownTracked(config: CollectionChangelogConfig | undefined, records: readonly { readonly fields: Readonly<Record<string, unknown>> }[]): readonly string[] {
  const known = new Set<string>();
  for (const record of records) for (const key of Object.keys(record.fields)) known.add(key);
  return (config?.track ?? []).filter((field) => !known.has(field)).sort();
}

/** The values a template may name. */
export interface SummaryValues {
  readonly id?: string;
  readonly field?: string;
  readonly old?: unknown;
  readonly new?: unknown;
  readonly from?: string;
  readonly count?: number;
  /** The record's own fields, so `{title}` reads the record's title. */
  readonly record?: Readonly<Record<string, unknown>>;
}

function text(value: unknown): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value) ?? "";
}

/**
 * The summary of an event: the collection's template for its type (or the default), with `{name}` replaced by the
 * event's values first and the record's field of that name second. A name with no value stays empty.
 */
export function summaryOf(config: CollectionChangelogConfig | undefined, type: ChangelogEventType, values: SummaryValues): string {
  const template = config?.labels?.[type] ?? DEFAULT_LABELS[type];
  return template.replace(/\{([A-Za-z0-9_.-]+)\}/g, (_, name: string) => {
    const own = (values as Record<string, unknown>)[name];
    if (name !== "record" && own !== undefined) return text(own);
    return text(values.record?.[name]);
  });
}
