/**
 * Joins a collection's records with records of other collections on declared keys. The collection's own source is the
 * primary side: its records keep their id, position, and order. Each source is one further join step, applied in the
 * order written, so a source that is itself joined is resolved first and a cycle is reported instead of looped.
 *
 * Keys compare by value and by type: a number never matches a string, and a composite key is one encoded tuple, so
 * `["a", "bc"]` never matches `["ab", "c"]`. A destination that more than one side supplies is chosen by source
 * precedence, or reported when `onConflict` is `error`; a null is a value unless `onNull` is `fallthrough`.
 */
import type {
  Collection,
  DataRecord,
  Diagnostic,
  JoinedField,
  RecordPos,
  SiteConfig,
  SourcePos,
} from "../contracts/index.ts";
import type { JoinConfig, JoinSourceConfig } from "../contracts/config.ts";
import { sourcePosOf } from "./positions.ts";

/** Adds deferred checks (schema, uniqueness, dates, derived values) to one collection's final records. */
export type JoinFinish = (name: string, records: readonly DataRecord[]) => readonly DataRecord[];

/** What {@link applyJoins} needs. */
export interface ApplyJoinsOptions {
  /** Collections by name. A joined collection is replaced in place; secondaries are read from here. */
  readonly collections: Record<string, Collection>;
  /** The loaded config, which names each join and its sources. */
  readonly config: SiteConfig;
  /** Where each collection's config entry sits, for a finding about a cycle. */
  readonly positions: Readonly<Record<string, SourcePos>>;
  /** Runs after a collection's join resolved, before a dependent join reads it. */
  readonly finish: JoinFinish;
}

/** One value a destination could hold, and the record it came from. */
interface Candidate {
  /** Collection name, or the primary collection's own name. */
  readonly collection: string;
  /** Field in that collection. */
  readonly field: string;
  readonly value: unknown;
  readonly valuePos: RecordPos;
  readonly keyPos?: RecordPos;
}

/** A secondary source, its records indexed by key. */
interface IndexedSource {
  readonly config: JoinSourceConfig;
  readonly collection: Collection;
  readonly keys: readonly string[];
  readonly many: "error" | "first" | "last" | "list";
  readonly byKey: ReadonlyMap<string, readonly DataRecord[]>;
}

/** The fields of a key, always as a list. */
function keyFields(key: string | readonly string[]): readonly string[] {
  return typeof key === "string" ? [key] : key;
}

/** A typed, collision-free encoding of one record's key; `undefined` when any field is absent or not a scalar. */
export function joinKeyOf(fields: Readonly<Record<string, unknown>>, keys: readonly string[]): string | undefined {
  const parts: (string | number | boolean)[] = [];
  for (const field of keys) {
    if (!Object.hasOwn(fields, field)) return undefined;
    const value = fields[field];
    if (value === null || value === undefined) return undefined;
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return undefined;
    if (typeof value === "number" && !Number.isFinite(value)) return undefined;
    parts.push(value);
  }
  return JSON.stringify(parts.map((part) => [typeof part, part]));
}

/** A key as a person reads it, for a diagnostic. */
function keyText(fields: Readonly<Record<string, unknown>>, keys: readonly string[]): string {
  return keys
    .map((field) => `${field}=${fields[field] === null ? "null" : JSON.stringify(fields[field])}`)
    .join(", ");
}

/** By code point, so the order never depends on the secondary source's row order. */
function byId(a: DataRecord, b: DataRecord): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Key-sorted JSON, so two equal objects compare alike whatever order their keys were built in. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The pairs of an output map, or every top-level field under its own name when the map is absent. */
function fieldPairs(
  mapped: Readonly<Record<string, string>> | undefined,
  fields: Readonly<Record<string, unknown>>,
): readonly (readonly [string, string])[] {
  if (mapped !== undefined) return Object.entries(mapped);
  return Object.keys(fields).map((field) => [field, field] as const);
}

/** One source's key index, with a finding for every record the missing-key policy left out. */
function indexSource(
  name: string,
  source: JoinSourceConfig,
  collection: Collection,
  keys: readonly string[],
  many: "error" | "first" | "last" | "list",
  policy: "error" | "skip",
  diagnostics: Diagnostic[],
): IndexedSource {
  const byKey = new Map<string, DataRecord[]>();
  for (const record of collection.records) {
    const key = joinKeyOf(record.fields, keys);
    if (key === undefined) {
      missingKey(name, source.collection, record, keys, policy, diagnostics);
      continue;
    }
    const list = byKey.get(key);
    if (list === undefined) byKey.set(key, [record]);
    else list.push(record);
  }
  for (const list of byKey.values()) list.sort(byId);
  return { config: source, collection, keys, many, byKey };
}

/** One finding for a record the join cannot key. */
function missingKey(
  join: string,
  collection: string,
  record: DataRecord,
  keys: readonly string[],
  policy: "error" | "skip",
  diagnostics: Diagnostic[],
): void {
  diagnostics.push({
    id: "data.join-missing-key",
    severity: policy === "skip" ? "warning" : "error",
    message: `Record "${record.id}" of "${collection}" has no value for the join key ${keys.join(", ")} of "${join}"; it is left out.`,
    pos: sourcePosOf(record.position),
    help:
      policy === "skip"
        ? "Add the key field, or keep the record out with the warning."
        : "Add the key field, or set `onMissingKey: skip` to leave the record out with a warning.",
  });
}

/** Adds one present field of one record as a candidate for `destination`, unless it is already recorded. */
function addCandidate(
  order: Map<string, Candidate[]>,
  destination: string,
  candidate: Candidate,
): void {
  const list = order.get(destination);
  if (list === undefined) order.set(destination, [candidate]);
  else list.push(candidate);
}

/** The nested value `many: list` writes: the record's id and its mapped fields, in map order. */
function nestedFields(record: DataRecord, mapped: Readonly<Record<string, string>> | undefined): Readonly<Record<string, unknown>> {
  const fields: Record<string, unknown> = { id: record.id };
  for (const [destination, field] of fieldPairs(mapped, record.fields)) {
    if (destination === "id" || !Object.hasOwn(record.fields, field)) continue;
    fields[destination] = record.fields[field];
  }
  return fields;
}

/** Adds the chosen record's mapped fields to the destination order. */
function addRecordFields(
  order: Map<string, Candidate[]>,
  collection: string,
  record: DataRecord,
  mapped: Readonly<Record<string, string>> | undefined,
): void {
  for (const [destination, field] of fieldPairs(mapped, record.fields)) {
    if (!Object.hasOwn(record.fields, field)) continue;
    addCandidate(order, destination, {
      collection,
      field,
      value: record.fields[field],
      valuePos: record.fieldPositions[field] ?? record.position,
      ...(record.keyPositions?.[field] === undefined ? {} : { keyPos: record.keyPositions[field] }),
    });
  }
}

/** A field's value as provenance, for a diagnostic. */
function describe(candidate: Candidate): string {
  return `${candidate.collection}.${candidate.field}`;
}

/** A record the join cannot write: a missing value or an unresolved conflict. */
function conflict(
  join: string,
  record: DataRecord,
  destination: string,
  keys: readonly string[],
  chosen: Candidate,
  other: Candidate,
  diagnostics: Diagnostic[],
): void {
  diagnostics.push({
    id: "data.join-conflict",
    severity: "error",
    message: `Record "${record.id}" of "${join}" (${keyText(record.fields, keys)}) has conflicting values for "${destination}" from ${describe(chosen)} and ${describe(other)}.`,
    pos: sourcePosOf(chosen.valuePos),
    help: "Set `onConflict: precedence` to keep the first source, or map the two fields to different destinations.",
  });
}

/** Chooses the value of one destination, or reports that precedence could not decide it. */
function choose(
  join: string,
  record: DataRecord,
  destination: string,
  keys: readonly string[],
  candidates: readonly Candidate[],
  onConflict: "precedence" | "error",
  onNull: "keep" | "fallthrough",
  diagnostics: Diagnostic[],
): { readonly candidate: Candidate; readonly reason: JoinedField["reason"] } {
  const values =
    onNull === "fallthrough" && candidates.some((candidate) => candidate.value !== null)
      ? candidates.filter((candidate) => candidate.value !== null)
      : candidates;
  const chosen = values[0]!;
  const reason: JoinedField["reason"] =
    candidates.length === 1 ? "only" : chosen !== candidates[0] ? "null-fallthrough" : "precedence";
  if (onConflict === "error" && values.length > 1) {
    const other = values.find((candidate) => canonical(candidate.value) !== canonical(chosen.value));
    if (other !== undefined) conflict(join, record, destination, keys, chosen, other, diagnostics);
  }
  return { candidate: chosen, reason };
}

/** One joined record, or `undefined` when an inner join has no match in a source. */
function joinedRecord(
  name: string,
  record: DataRecord,
  join: JoinConfig,
  keys: readonly string[],
  sources: readonly IndexedSource[],
  onMissing: "error" | "skip",
  diagnostics: Diagnostic[],
): DataRecord | undefined {
  const key = joinKeyOf(record.fields, keys);
  if (key === undefined) {
    missingKey(name, name, record, keys, onMissing, diagnostics);
    return undefined;
  }

  const order = new Map<string, Candidate[]>();
  addRecordFields(order, name, record, join.fields);

  let matched = true;
  for (const source of sources) {
    const matches = source.byKey.get(key) ?? [];
    if (matches.length === 0) {
      matched = false;
      continue;
    }
    if (matches.length > 1 && source.many === "error") {
      diagnostics.push({
        id: "data.join-many",
        severity: "error",
        message: `Record "${record.id}" of "${name}" (${keyText(record.fields, keys)}) matches ${matches.length} records of "${source.collection.name}", and "${source.collection.name}" joins one.`,
        pos: sourcePosOf(record.position),
        help: "Set `many: first`, `last`, or `list` on the source, or make the source's key unique.",
      });
    }
    if (source.many === "list") {
      const destination = source.config.manyField ?? source.config.collection;
      const nested = matches.map((match) => nestedFields(match, source.config.fields));
      const first = matches[0]!;
      addCandidate(order, destination, {
        collection: source.collection.name,
        field: destination,
        value: nested,
        valuePos: first.position,
      });
      continue;
    }
    const chosen = source.many === "last" ? matches[matches.length - 1]! : matches[0]!;
    addRecordFields(order, source.collection.name, chosen, source.config.fields);
  }

  if (!matched && (join.type ?? "inner") === "inner") return undefined;

  const fields: Record<string, unknown> = {};
  const fieldPositions: Record<string, RecordPos> = {};
  const keyPositions: Record<string, RecordPos> = {};
  const lineage: Record<string, JoinedField> = {};
  for (const [destination, candidates] of order) {
    const { candidate, reason } = choose(
      name,
      record,
      destination,
      keys,
      candidates,
      join.onConflict ?? "precedence",
      join.onNull ?? "keep",
      diagnostics,
    );
    fields[destination] = candidate.value;
    fieldPositions[destination] = candidate.valuePos;
    if (candidate.keyPos !== undefined) keyPositions[destination] = candidate.keyPos;
    lineage[destination] = {
      field: destination,
      source: candidate.collection,
      input: candidate.field,
      inputs: candidates.map(describe),
      reason,
    };
  }

  const keyValues: Record<string, string> = {};
  for (const field of keys) {
    const value = record.fields[field];
    keyValues[field] = value === null || value === undefined ? "" : String(value);
  }

  return {
    ...record,
    fields,
    fieldPositions,
    ...(Object.keys(keyPositions).length === 0 ? {} : { keyPositions }),
    joined: { key: keyValues, fields: lineage },
  };
}

/** Joins one collection's primary records with every source, in declared order. */
function joinRecords(
  name: string,
  primary: Collection,
  join: JoinConfig,
  collections: Readonly<Record<string, Collection>>,
  diagnostics: Diagnostic[],
): readonly DataRecord[] {
  const keys = keyFields(join.key);
  const onMissing = join.onMissingKey ?? "error";
  const sources: IndexedSource[] = [];
  for (const source of join.sources) {
    const collection = collections[source.collection];
    if (collection === undefined) continue;
    sources.push(
      indexSource(
        name,
        source,
        collection,
        keyFields(source.key ?? join.key),
        source.many ?? join.many ?? "error",
        onMissing,
        diagnostics,
      ),
    );
  }
  const records: DataRecord[] = [];
  for (const record of primary.records) {
    const joined = joinedRecord(name, record, join, keys, sources, onMissing, diagnostics);
    if (joined !== undefined) records.push(joined);
  }
  return records;
}

/**
 * Applies every configured join, resolving sources that are themselves joined first. A cycle is one error naming the
 * chain and leaves the collections unjoined, so the rest of the build still reports its own findings. The working set
 * is replaced in place, and `finish` runs before a joined collection is read as a source of another.
 */
export function applyJoins(options: ApplyJoinsOptions): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  const resolve = (name: string): boolean => {
    const current = options.collections[name];
    const join = options.config.collections[name]?.join;
    if (current === undefined || join === undefined) return true;
    const seen = state.get(name);
    if (seen === "done") return true;
    if (seen === "visiting") {
      const cycle = [...stack.slice(stack.indexOf(name)), name];
      diagnostics.push({
        id: "data.join-cycle",
        severity: "error",
        message: `The joins form a cycle: ${cycle.join(" → ")}.`,
        pos: options.positions[name] ?? { file: "mizzen.yml", line: 1, column: 1, endLine: 1, endColumn: 1 },
        help: "Remove one of the joins so the chain of sources ends.",
      });
      return false;
    }
    state.set(name, "visiting");
    stack.push(name);
    let ready = true;
    for (const source of join.sources) {
      if (!resolve(source.collection)) ready = false;
    }
    stack.pop();
    if (ready) {
      const joined = joinRecords(name, current, join, options.collections, diagnostics);
      options.collections[name] = { ...current, records: options.finish(name, joined) };
    }
    state.set(name, "done");
    return ready;
  };

  for (const name of Object.keys(options.config.collections)) resolve(name);
  return diagnostics;
}
