/**
 * The history file, `data-changes/<collection>.jsonl`: one change event per line, validated by
 * `schema/data-changes.schema.json`, written in a fixed key order, and only ever appended to.
 *
 * An event id is built from the collection, the record, the type, the field, and the date, so a repeated run finds the
 * same id and writes nothing.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import type { ChangeEvent } from "../../contracts/index.ts";
import { canonicalJson, sha256 } from "../lock.ts";

export type { ChangeEvent };

const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;
const validateEvent = new Ajv2020({ strict: true, allErrors: true }).compile(
  JSON.parse(readFileSync(new URL("../../../schema/data-changes.schema.json", import.meta.url), "utf8")) as object,
);

/** Where a collection's history lives, relative to the site root. */
export function historyPath(collection: string): string {
  return `data-changes/${collection}.jsonl`;
}

/** The stable id of an event: 16 hex characters of the SHA-256 of what makes it the same event on a repeated run. */
export function eventId(collection: string, record: string, type: string, field: string | undefined, date: string): string {
  return sha256([collection, record, type, field ?? "", date].join("\n")).slice(0, 16);
}

const KEYS = ["id", "type", "record", "field", "old", "new", "from", "fields", "count", "ref", "date"] as const;

/** One event as a line: keys in the fixed order, values in canonical JSON, no line feed. */
export function eventLine(event: ChangeEvent): string {
  const parts: string[] = [];
  for (const key of KEYS) {
    const value = event[key];
    if (value !== undefined) parts.push(`${JSON.stringify(key)}:${canonicalJson(value)}`);
  }
  return `{${parts.join(",")}}`;
}

/** The text to append for `events`: one line each, every one ending in a line feed. */
export function eventsText(events: readonly ChangeEvent[]): string {
  return events.map((event) => `${eventLine(event)}\n`).join("");
}

/** What {@link parseHistory} read. */
export interface ParsedHistory {
  readonly events: readonly ChangeEvent[];
  /** The 1-based line number of each event, in the same order as {@link events}. */
  readonly lines: readonly number[];
  /** One message per bad line, with its 1-based line number. */
  readonly problems: readonly string[];
}

/** Reads a history file's text; a line that is not valid JSON, fails the schema, or repeats an id is a problem. */
export function parseHistory(text: string): ParsedHistory {
  const events: ChangeEvent[] = [];
  const lines: number[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  const rows = text.split("\n");
  rows.forEach((line, index) => {
    if (line === "") return;
    const at = index + 1;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (err) {
      problems.push(`line ${at}: not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (!validateEvent(value)) {
      const first = validateEvent.errors?.[0];
      problems.push(`line ${at}: ${first === undefined ? "not a change event" : `${first.instancePath === "" ? "event" : first.instancePath} ${first.message ?? "is invalid"}`}`);
      return;
    }
    const event = value as ChangeEvent;
    if (seen.has(event.id)) {
      problems.push(`line ${at}: the id ${event.id} is already used`);
      return;
    }
    seen.add(event.id);
    events.push(event);
    lines.push(at);
  });
  return { events, lines, problems };
}
