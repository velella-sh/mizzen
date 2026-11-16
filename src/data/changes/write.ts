/**
 * `mizzen data changes`: finds what changed in a collection since its recorded state and, with `write`, appends the
 * events to `data-changes/<collection>.jsonl`.
 *
 * Every event is dated by the collection's snapshot (`capturedAt` in `mizzen.lock.json`). A collection with no snapshot
 * date is refused: the system date is never used. A run that finds every event already in the file writes nothing.
 */
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { loadConfig } from "../../config/load.ts";
import type { ChangelogEventType, CollectionConfig } from "../../contracts/index.ts";
import { loadCollections } from "../collections.ts";
import { type ComparedRecord, compareStates } from "./compare.ts";
import { type ChangeEvent, eventId, eventLine, eventsText, historyPath, parseHistory } from "./format.ts";
import { replayHistory, stateAtRef, stateInFolder } from "./states.ts";
import { summaryOf, tracked, unknownTracked } from "./track.ts";

/** Options of {@link dataChanges}. */
export interface DataChangesOptions {
  /** The site root: the folder that holds `mizzen.yml`. */
  readonly root: string;
  /** One collection; every collection that has a `changelog` key when absent. */
  readonly name?: string;
  /** Append the pending events to the history file. */
  readonly write?: boolean;
  /** Compare with an earlier state: a folder, or a git ref. Default: the last state the history records. */
  readonly from?: string;
}

/** One pending event with the text that describes it. */
export interface PendingEvent {
  readonly collection: string;
  readonly event: ChangeEvent;
  readonly summary: string;
}

/** What {@link dataChanges} found. */
export interface DataChangesResult {
  /** 0 normally, 1 for a problem or a pending change under `check`, 2 for a usage problem. */
  readonly code: number;
  /** The pending events, per collection in name order. */
  readonly pending: readonly PendingEvent[];
  /** Lines to print. */
  readonly messages: readonly string[];
  /** Problems, printed to stderr. */
  readonly errors: readonly string[];
}

function byCode(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The tracked values of a record, in field order. */
function trackedFields(fields: Readonly<Record<string, unknown>>, follows: (field: string) => boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(fields).sort(byCode)) if (follows(key)) out[key] = fields[key];
  return out;
}

/** The state to compare with: `from`, or what the history records. */
async function baselineOf(
  root: string,
  name: string,
  entry: CollectionConfig,
  history: readonly ChangeEvent[],
  from: string | undefined,
  follows: (field: string) => boolean,
): Promise<{ readonly records: readonly ComparedRecord[] } | { readonly error: string }> {
  const target = { name, source: entry.source, ...(entry.id === undefined ? {} : { id: entry.id }) };
  if (from !== undefined) {
    const result = existsSync(resolve(root, from)) ? await stateInFolder(root, target, from) : stateAtRef(root, target, from);
    if (!result.ok) return { error: `${name}: ${result.message}` };
    return { records: result.records.map((record) => ({ id: record.id, fields: trackedFields(record.fields, follows) })) };
  }
  let start = -1;
  history.forEach((event, index) => {
    if (event.type === "imported") start = index;
  });
  let base: readonly ComparedRecord[] = [];
  if (start >= 0) {
    const imported = history[start]!;
    if (imported.ref === undefined) {
      return { error: `${name}: the history starts with an import that names no git ref, so the earlier state cannot be rebuilt; pass --from <git-ref|folder>.` };
    }
    const result = stateAtRef(root, target, imported.ref);
    if (!result.ok) return { error: `${name}: ${result.message}` };
    base = result.records.map((record) => ({ id: record.id, fields: trackedFields(record.fields, follows) }));
  }
  return { records: replayHistory(base, history.slice(start + 1)) };
}

/** Finds, and with `write` records, what changed in the collections that have a changelog. */
export async function dataChanges(options: DataChangesOptions): Promise<DataChangesResult> {
  const { root } = options;
  const messages: string[] = [];
  const errors: string[] = [];
  const pending: PendingEvent[] = [];
  const loaded = loadConfig(root);
  for (const diagnostic of loaded.diagnostics) if (diagnostic.severity === "error") errors.push(diagnostic.message);
  if (errors.length > 0) return { code: 1, pending, messages, errors };

  const config = loaded.config;
  let names: string[];
  if (options.name !== undefined) {
    if (config.collections[options.name] === undefined) {
      return { code: 2, pending, messages, errors: [`No collection named "${options.name}" in mizzen.yml.`] };
    }
    names = [options.name];
  } else {
    names = Object.keys(config.collections).filter((name) => config.collections[name]!.changelog !== undefined).sort(byCode);
    if (names.length === 0) messages.push("no collection has a `changelog` key");
  }

  const data = await loadCollections({ root, config });
  for (const diagnostic of data.diagnostics) if (diagnostic.severity === "error") errors.push(diagnostic.message);
  if (errors.length > 0) return { code: 1, pending, messages, errors };

  const writes: { readonly name: string; readonly text: string }[] = [];
  for (const name of names) {
    const entry = config.collections[name]!;
    const changelog = entry.changelog;
    const collection = data.collections[name];
    if (collection === undefined) {
      errors.push(`${name}: the collection could not be read.`);
      continue;
    }
    const date = collection.snapshot?.capturedAt;
    if (date === undefined) {
      errors.push(`${name}: has no snapshot date in mizzen.lock.json, so there is no date to record. Run \`mizzen data snapshot ${name}\` (or \`mizzen data fetch\`); the system date is never used.`);
      continue;
    }
    const unknown = unknownTracked(changelog, collection.records);
    if (unknown.length > 0) {
      errors.push(`${name}: changelog.track names ${unknown.map((field) => `"${field}"`).join(", ")}, which no record has.`);
      continue;
    }

    let existing = "";
    try {
      existing = await readFile(join(root, historyPath(name)), "utf8");
    } catch {
      // No history yet.
    }
    const history = parseHistory(existing);
    if (history.problems.length > 0) {
      for (const problem of history.problems) errors.push(`${historyPath(name)} ${problem}`);
      continue;
    }

    const follows = tracked(changelog);
    const baseline = await baselineOf(root, name, entry, history.events, options.from, follows);
    if ("error" in baseline) {
      errors.push(baseline.error);
      continue;
    }

    const current = collection.records.map((record) => ({ id: record.id, fields: trackedFields(record.fields, follows) }));
    const byId = new Map(collection.records.map((record) => [record.id, record.fields]));
    const known = new Map(history.events.map((event) => [event.id, event]));
    const fresh: ChangeEvent[] = [];
    for (const change of compareStates(baseline.records, current, { ...(entry.aliases === undefined ? {} : { aliases: entry.aliases }), include: follows })) {
      const base = {
        id: eventId(name, change.record, change.type, change.field, date),
        type: change.type,
        record: change.record,
        ...(change.field === undefined ? {} : { field: change.field }),
        ...("old" in change ? { old: change.old } : {}),
        ...("new" in change ? { new: change.new } : {}),
        ...(change.from === undefined ? {} : { from: change.from }),
      };
      const fields = change.type === "added" ? trackedFields(byId.get(change.record) ?? {}, follows) : undefined;
      const event: ChangeEvent = { ...base, ...(fields === undefined || Object.keys(fields).length === 0 ? {} : { fields }), date } as ChangeEvent;
      const earlier = known.get(event.id);
      if (earlier !== undefined) {
        if (eventLine(earlier) !== eventLine(event)) {
          errors.push(`${name}: ${change.record} already has a "${change.type}" event dated ${date} with other values; the snapshot date has not moved since it was recorded.`);
        }
        continue;
      }
      fresh.push(event);
    }

    // A first load, or a run past `importThreshold`, is one `imported` event and not one event per record.
    const threshold = changelog?.importThreshold;
    const importing =
      options.from === undefined && fresh.length > 0 && (history.events.length === 0 || (threshold !== undefined && fresh.length > threshold));
    if (importing) {
      const count = history.events.length === 0 ? collection.records.length : fresh.length;
      const ref = collection.snapshot?.tool === "git" ? collection.snapshot.ref : undefined;
      const id = eventId(name, name, "imported", undefined, date);
      if (known.has(id)) {
        errors.push(`${name}: an import dated ${date} is already recorded; the snapshot date has not moved since.`);
        continue;
      }
      fresh.splice(0, fresh.length, { id, type: "imported", record: name, count, ...(ref === undefined ? {} : { ref }), date });
    }

    for (const event of fresh) {
      pending.push({
        collection: name,
        event,
        summary: summaryOf(changelog, event.type as ChangelogEventType, {
          id: event.record,
          ...(event.field === undefined ? {} : { field: event.field }),
          ...("old" in event ? { old: event.old } : {}),
          ...("new" in event ? { new: event.new } : {}),
          ...(event.from === undefined ? {} : { from: event.from }),
          ...(event.count === undefined ? {} : { count: event.count }),
          record: byId.get(event.record) ?? {},
        }),
      });
    }
    messages.push(fresh.length === 0 ? `${name}: no pending changes` : `${name}: ${fresh.length} pending ${fresh.length === 1 ? "event" : "events"} dated ${date}`);
    if (fresh.length > 0) writes.push({ name, text: eventsText(fresh) });
  }

  if (errors.length > 0) return { code: 1, pending: [], messages, errors };
  for (const item of pending) messages.push(`  ${item.event.type} ${item.summary}`);
  if (options.write === true) {
    for (const item of writes) {
      const path = join(root, historyPath(item.name));
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, item.text);
      messages.push(`wrote ${historyPath(item.name)}`);
    }
  }
  return { code: 0, pending, messages, errors };
}
