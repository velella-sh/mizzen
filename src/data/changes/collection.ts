/**
 * The history a build can read: `<name>.changes` is a read-only collection whose records are the events of
 * `data-changes/<name>.jsonl`. It keeps the date field and the fixed schema of `schema/data-changes.schema.json`, so a
 * list, a feed, or a search reads it through the same collection as any source.
 *
 * A collection with no history file adds no collection at all: a site without a history keeps the same model and the
 * same build hash. The name contains a dot, which the config's collection names do not, so a site cannot declare or
 * point a template at it.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChangeEvent, Collection, DataRecord, Diagnostic, RecordPos, SiteConfig } from "../../contracts/index.ts";
import { historyPath, parseHistory } from "./format.ts";

/** What {@link loadChangeCollections} read. */
export interface ChangeCollectionsResult {
  /** The history collections, keyed `<name>.changes`, in config order; a collection without a file is absent. */
  readonly collections: Readonly<Record<string, Collection>>;
  /** Findings from history files that could not be read or whose lines are not events. */
  readonly diagnostics: readonly Diagnostic[];
}

/** Options of {@link loadChangeCollections}. */
export interface ChangeCollectionsOptions {
  /** Absolute site root, where `data-changes/` lives. */
  readonly root: string;
  readonly config: SiteConfig;
}

/** The name of a collection's history as a collection: `items` becomes `items.changes`. */
export function changesName(collection: string): string {
  return `${collection}.changes`;
}

/** The fields every event has, for a template or a list that reads the fixed schema. */
export const CHANGE_FIELDS: ReadonlySet<string> = new Set([
  "id",
  "type",
  "record",
  "field",
  "old",
  "new",
  "from",
  "fields",
  "count",
  "ref",
  "date",
]);

/** The record span of one line, counted in code points. */
function linePos(file: string, line: number, text: string): RecordPos {
  return { file, startLine: line, startColumn: 1, endLine: line, endColumn: Math.max(1, [...text].length) };
}

/** The events of one history file as records; a line's fields all sit on that line. */
function recordsOf(file: string, event: ChangeEvent, line: number, text: string): DataRecord {
  const position = linePos(file, line, text);
  const fields = { ...event } as Readonly<Record<string, unknown>>;
  const fieldPositions: Record<string, RecordPos> = {};
  for (const key of Object.keys(fields)) fieldPositions[key] = position;
  return {
    id: event.id,
    fields,
    position,
    fieldPositions,
    keyPositions: fieldPositions,
    normalizedDates: { date: event.date },
  };
}

/**
 * Reads every collection's history file, in config order. A missing file is no history, not a finding; a file that
 * cannot be read or has a line that is not an event is one error naming the file and the line.
 */
export async function loadChangeCollections(options: ChangeCollectionsOptions): Promise<ChangeCollectionsResult> {
  const { root, config } = options;
  const collections: Record<string, Collection> = {};
  const diagnostics: Diagnostic[] = [];

  for (const name of Object.keys(config.collections)) {
    const file = historyPath(name);
    let text: string;
    try {
      text = await readFile(join(root, file), "utf8");
    } catch {
      continue;
    }
    const parsed = parseHistory(text);
    const lines = text.split("\n");
    for (const problem of parsed.problems) {
      const line = Number(/^line (\d+):/.exec(problem)?.[1] ?? "1");
      diagnostics.push({
        id: "data.history-line",
        severity: "error",
        message: `The history ${file} ${problem}.`,
        pos: { file, line, column: 1, endLine: line, endColumn: Math.max(1, [...(lines[line - 1] ?? "")].length) },
        help: "Fix the line, or run `mizzen data changes` to append the events again.",
      });
    }
    if (parsed.events.length === 0) continue;
    collections[changesName(name)] = {
      name: changesName(name),
      source: file,
      records: parsed.events.map((event, index) => {
        const line = parsed.lines[index]!;
        return recordsOf(file, event, line, lines[line - 1] ?? "");
      }),
      readonly: true,
    };
  }

  return { collections, diagnostics };
}
