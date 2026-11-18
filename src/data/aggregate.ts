/**
 * Aggregate collections: one summary record per distinct combination of a source collection's field values.
 *
 * A group key is typed and canonical, so `1` and `"1"` are different groups; groups are ordered by their key values,
 * never by the order the source rows arrived in. A record without one of the key values follows `missing`: it is
 * skipped (the default), or joins a group whose missing key is `null`. Null metric values are skipped, so an average
 * divides by the number of values it actually read, and a group whose metrics are all null follows `empty`.
 *
 * A time bucket reads a date or an instant. A date has no zone; an instant is placed in the configured IANA zone before
 * its month or year is read, so a monthly report is the same on every machine. Nothing here reads the clock.
 */
import { createHash } from "node:crypto";
import { unsafeIdReason } from "../api/ids.ts";
import type {
  AggregateConfig,
  AggregateGroupConfig,
  AggregateMetricConfig,
  Collection,
  CollectionConfig,
  DataRecord,
  Diagnostic,
  SourcePos,
} from "../contracts/index.ts";
import { normalizeDate, parseDate } from "../dates/parse.ts";
import { compareCodePoint, filterRows, parseQuery } from "./query.ts";
import { resolveIn } from "./record-context.ts";
import { referenceDateOf } from "./reference-date.ts";
import { slugOf } from "./slug.ts";

/** What {@link buildAggregate} needs. */
export interface AggregateInput {
  /** The aggregate collection's name. */
  readonly name: string;
  /** The source collection's name, as the config writes `source`. */
  readonly source: string;
  readonly aggregate: AggregateConfig;
  /** The loaded source collection, or `undefined` when it did not load. */
  readonly sourceCollection: Collection | undefined;
  /** The aggregate collection's own config entry, for its id field and reference date. */
  readonly entry: CollectionConfig;
  /** The source collection's config entry, for its reference date. */
  readonly sourceEntry: CollectionConfig | undefined;
  /** The site's as-of date, for a filter that compares before or after. */
  readonly asOf?: string;
  /** Where the collection is declared, so every finding points at the config. */
  readonly pos: SourcePos;
}

/** The summary collection, or every finding that kept it from being built. */
export interface AggregateResult {
  readonly collection?: Collection;
  readonly diagnostics: readonly Diagnostic[];
}

/** A typed key part; `missing` is a record without a value for that grouping field. */
type KeyPart = { readonly kind: "value"; readonly value: string | number | boolean } | { readonly kind: "missing" };

/** One group while it is built. */
interface Group {
  readonly parts: readonly KeyPart[];
  readonly records: DataRecord[];
}

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

/** True when the runtime knows the zone. */
function knownZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The year and month of an instant in a zone, without reading the host zone. */
function zoneMonth(instant: string, zone: string): { readonly year: string; readonly month: string } | undefined {
  let formatter = zoneFormatters.get(zone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit" });
    zoneFormatters.set(zone, formatter);
  }
  const parts = formatter.formatToParts(new Date(instant));
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  return year === undefined || month === undefined ? undefined : { year: year.padStart(4, "0"), month };
}

/** The text of a scalar value; `undefined` for a value that cannot be a group key. */
function scalarKey(value: unknown): string | number | boolean | undefined {
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value === 0 ? 0 : value;
  return undefined;
}

/** The month or year a value belongs to, in the group's zone; `undefined` when the value is not a date. */
function periodOf(value: string, group: AggregateGroupConfig): string | undefined {
  const date = parseDate(value);
  if (date.ok) {
    const year = String(date.date.year).padStart(4, "0");
    return group.period === "year" ? year : `${year}-${String(date.date.month).padStart(2, "0")}`;
  }
  const normalized = normalizeDate(value);
  if (normalized === undefined) return undefined;
  const zoned = zoneMonth(normalized, group.timezone!);
  if (zoned === undefined) return undefined;
  return group.period === "year" ? zoned.year : `${zoned.year}-${zoned.month}`;
}

/** The group key parts a record has, or the reason it has none. */
function keyOf(
  record: DataRecord,
  name: string,
  group: AggregateGroupConfig,
  pos: SourcePos,
  diagnostics: Diagnostic[],
): KeyPart | undefined {
  const found = resolveIn(record.fields, group.field);
  if (!found.found || found.value === undefined || found.value === null || found.value === "") return { kind: "missing" };
  if (group.period !== undefined) {
    if (typeof found.value !== "string") {
      diagnostics.push({
        id: "data.aggregate-period",
        severity: "error",
        message: `Record "${record.id}" of "${name}" has a non-text "${group.field}" value, so it cannot be grouped by ${group.period}.`,
        pos: record.fieldPositions[group.field] ?? pos,
        help: `Write "${group.field}" as a date or an ISO 8601 instant.`,
      });
      return undefined;
    }
    const period = periodOf(found.value, group);
    if (period === undefined) {
      diagnostics.push({
        id: "data.aggregate-period",
        severity: "error",
        message: `Record "${record.id}" of "${name}" has "${group.field}" = ${JSON.stringify(found.value)}, which is not a date, so it cannot be grouped by ${group.period}.`,
        pos: record.fieldPositions[group.field] ?? pos,
        help: `Write "${group.field}" as YYYY-MM-DD, YYYY-MM, YYYY, or an ISO 8601 instant.`,
      });
      return undefined;
    }
    return { kind: "value", value: period };
  }
  const value = scalarKey(found.value);
  if (value === undefined) {
    diagnostics.push({
      id: "data.aggregate-key",
      severity: "error",
      message: `Record "${record.id}" of "${name}" has a "${group.field}" value that is not text, a finite number, or a boolean, so it cannot be a group key.`,
      pos: record.fieldPositions[group.field] ?? pos,
      help: `Group by a scalar field, or remove "${group.field}" from \`aggregate.by\`.`,
    });
    return undefined;
  }
  return { kind: "value", value };
}

/** A canonical, typed text for one key part, so values of different types never share a group. */
function keyText(part: KeyPart): string {
  if (part.kind === "missing") return "null";
  if (typeof part.value === "number") return `n:${String(part.value)}`;
  if (typeof part.value === "boolean") return `b:${String(part.value)}`;
  return `s:${part.value}`;
}

/** The readable part of an aggregate id. */
function idPart(part: KeyPart): string {
  if (part.kind === "missing") return "missing";
  if (typeof part.value === "number") return slugOf(String(part.value)) || "zero";
  if (typeof part.value === "boolean") return String(part.value);
  return slugOf(part.value) || "empty";
}

/** Orders key parts: numbers, text, booleans, then missing, each by value or code point. */
function compareParts(a: readonly KeyPart[], b: readonly KeyPart[]): number {
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const left = a[index]!;
    const right = b[index]!;
    const rank = (part: KeyPart): number => (part.kind === "missing" ? 3 : typeof part.value === "number" ? 0 : typeof part.value === "string" ? 1 : 2);
    const order = rank(left) - rank(right);
    if (order !== 0) return order;
    if (left.kind === "missing" || right.kind === "missing") continue;
    if (typeof left.value === "number" && typeof right.value === "number") {
      if (left.value !== right.value) return left.value - right.value;
    } else if (typeof left.value === "string" && typeof right.value === "string") {
      const order = compareCodePoint(left.value, right.value);
      if (order !== 0) return order;
    } else if (typeof left.value === "boolean" && typeof right.value === "boolean") {
      if (left.value !== right.value) return left.value ? 1 : -1;
    }
  }
  return a.length - b.length;
}

/** Rounds to a number of decimal places, and never writes `-0`. */
function round(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return value;
  const rounded = Number(value.toFixed(decimals));
  return rounded === 0 ? 0 : rounded;
}

/** The canonical form of a distinct value, or `undefined` when it is not scalar. */
function distinctKey(value: unknown): string | undefined {
  if (typeof value === "string") return `s:${value}`;
  if (typeof value === "number" && Number.isFinite(value)) return `n:${String(value === 0 ? 0 : value)}`;
  if (typeof value === "boolean") return `b:${String(value)}`;
  return undefined;
}

/** One numeric reading, or a finding naming the record and value that is not a finite number. */
function numberAt(
  record: DataRecord,
  name: string,
  metric: string,
  field: string,
  pos: SourcePos,
  diagnostics: Diagnostic[],
): number | undefined {
  const found = resolveIn(record.fields, field);
  if (!found.found || found.value === undefined || found.value === null) return undefined;
  if (typeof found.value === "number" && Number.isFinite(found.value)) return found.value;
  diagnostics.push({
    id: "data.aggregate-number",
    severity: "error",
    message: `Metric "${metric}" of "${name}" reads "${field}" = ${JSON.stringify(found.value)} from record "${record.id}", which is not a finite number.`,
    pos: record.fieldPositions[field] ?? pos,
    help: `Write "${field}" as a number, or cast it in the source collection's \`transform\` rules.`,
  });
  return undefined;
}

/** Computes one metric for a group; null means the group held no value the metric could read. */
function metricOf(
  metric: AggregateMetricConfig,
  metricName: string,
  name: string,
  group: Group,
  pos: SourcePos,
  diagnostics: Diagnostic[],
): string | number | boolean | null {
  if (metric.op === "count") return group.records.length;
  const field = metric.field!;
  if (metric.op === "count-distinct") {
    const seen = new Set<string>();
    for (const record of group.records) {
      const found = resolveIn(record.fields, field);
      if (!found.found || found.value === undefined || found.value === null) continue;
      const key = distinctKey(found.value);
      if (key === undefined) {
        diagnostics.push({
          id: "data.aggregate-distinct",
          severity: "error",
          message: `Metric "${metricName}" of "${name}" reads "${field}" = ${JSON.stringify(found.value)} from record "${record.id}", which is not text, a finite number, or a boolean.`,
          pos: record.fieldPositions[field] ?? pos,
          help: `Count distinct values of a scalar field.`,
        });
        continue;
      }
      seen.add(key);
    }
    return seen.size;
  }

  if (metric.op === "sum" || metric.op === "average") {
    let total = 0;
    let count = 0;
    for (const record of group.records) {
      const value = numberAt(record, name, metricName, field, pos, diagnostics);
      if (value === undefined) continue;
      total += value;
      count += 1;
    }
    if (count === 0) return null;
    return round(metric.op === "sum" ? total : total / count, metric.decimals ?? 2);
  }

  // min and max compare one type family: all numbers or all text. A mixed or unusable group is reported, not guessed.
  let bound: string | number | undefined;
  let family: "number" | "string" | undefined;
  for (const record of group.records) {
    const found = resolveIn(record.fields, field);
    if (!found.found || found.value === undefined || found.value === null) continue;
    const value = found.value;
    const kind = typeof value === "number" && Number.isFinite(value) ? "number" : typeof value === "string" ? "string" : undefined;
    if (kind === undefined) {
      diagnostics.push({
        id: "data.aggregate-bound",
        severity: "error",
        message: `Metric "${metricName}" of "${name}" reads "${field}" = ${JSON.stringify(value)} from record "${record.id}", which is not text or a finite number.`,
        pos: record.fieldPositions[field] ?? pos,
        help: `Compute ${metric.op} over text or numbers, all of one kind.`,
      });
      continue;
    }
    if (family !== undefined && family !== kind) {
      diagnostics.push({
        id: "data.aggregate-bound",
        severity: "error",
        message: `Metric "${metricName}" of "${name}" compares a ${kind} with a ${family}; values in one group must be all text or all numbers.`,
        pos: record.fieldPositions[field] ?? pos,
        help: `Cast "${field}" in the source collection's \`transform\` rules so the group holds one kind.`,
      });
      continue;
    }
    family = kind;
    if (bound === undefined) {
      bound = value as string | number;
      continue;
    }
    const order = kind === "number" ? (value as number) - (bound as number) : compareCodePoint(value as string, bound as string);
    if ((metric.op === "min" && order < 0) || (metric.op === "max" && order > 0)) bound = value as string | number;
  }
  return bound ?? null;
}

/** Validates the parts of an aggregate the JSON Schema cannot know: the source, the zones, and the metric fields. */
function validate(input: AggregateInput): Diagnostic[] {
  const { name, source, aggregate, entry, pos } = input;
  const diagnostics: Diagnostic[] = [];
  const idField = entry.id ?? "id";
  const fail = (id: string, message: string, help: string): void => {
    diagnostics.push({ id, severity: "error", message, pos, help });
  };

  if (aggregate.by.some((group) => group.field === idField)) {
    fail("data.aggregate-id-field", `Collection "${name}" groups by "${idField}", which is also the field its summary id is written under.`, `Set \`collections.${name}.id\` to another field, or group by another field.`);
  }
  const seen = new Set<string>();
  for (const group of aggregate.by) {
    if (seen.has(group.field)) {
      fail("data.aggregate-by", `Collection "${name}" groups by "${group.field}" more than once.`, "Name each grouping field once.");
    }
    seen.add(group.field);
    if (group.period === undefined) continue;
    if (group.timezone === undefined || group.timezone === "") {
      fail("data.aggregate-timezone", `Collection "${name}" groups "${group.field}" by ${group.period} without a time zone.`, `Add \`timezone: UTC\` (or another IANA zone) to that \`by\` entry.`);
    } else if (!knownZone(group.timezone)) {
      fail("data.aggregate-timezone", `Collection "${name}" names an unknown time zone "${group.timezone}" for "${group.field}".`, "Use an IANA zone such as UTC or Europe/Berlin.");
    }
  }
  for (const [metricName, metric] of Object.entries(aggregate.metrics)) {
    if (metricName === idField || seen.has(metricName)) {
      fail("data.aggregate-metric-name", `The metric "${metricName}" of "${name}" has the same name as a grouping field or its id.`, "Rename the metric.");
    }
    if (metric.op !== "count" && (metric.field === undefined || metric.field === "")) {
      fail("data.aggregate-metric-field", `Metric "${metricName}" of "${name}" uses "${metric.op}" without a field.`, `Add \`field: <name>\` to the metric.`);
    }
  }
  if (input.sourceCollection === undefined) {
    const sourceEntry = input.sourceEntry;
    fail(
      "data.aggregate-source",
      sourceEntry?.aggregate === undefined
        ? `Collection "${name}" aggregates "${source}", which did not load.`
        : `Collection "${name}" aggregates "${source}", which is itself an aggregate; summarize a source collection.`,
      `Point \`collections.${name}.source\` at a collection read from a file.`,
    );
  }
  return diagnostics;
}

/** Builds one aggregate collection from its source; a config problem yields findings and no collection. */
export function buildAggregate(input: AggregateInput): AggregateResult {
  const diagnostics = validate(input);
  const source = input.sourceCollection;
  const { name, aggregate, entry, pos } = input;
  if (source === undefined) return { diagnostics };

  const reference = referenceDateOf(input.source, input.sourceEntry, {}, input.asOf);
  const query = parseQuery(aggregate.where, undefined, {
    file: pos.file,
    pos,
    collection: input.source,
    ...(reference.date === undefined ? {} : { reference: reference.date }),
  });
  diagnostics.push(...query.diagnostics);
  if (query.needsReference && reference.date === undefined) {
    diagnostics.push({
      id: "data.aggregate-reference",
      severity: "error",
      message: `A filter of "${name}" compares before or after a reference date, but "${input.source}" has none.`,
      pos,
      help: `Set \`collections.${input.source}.referenceDate\` to a date, or set the site's \`asOf\` date.`,
    });
  }
  if (diagnostics.some((finding) => finding.severity === "error")) return { diagnostics };

  const groups = new Map<string, Group>();
  for (const record of filterRows(source.records, query.where)) {
    const parts: KeyPart[] = [];
    let usable = true;
    for (const group of aggregate.by) {
      const part = keyOf(record, input.source, group, pos, diagnostics);
      if (part === undefined) {
        usable = false;
        break;
      }
      parts.push(part);
    }
    if (!usable) continue;
    if (parts.some((part) => part.kind === "missing") && aggregate.missing !== "group") continue;
    const key = parts.map(keyText).join("\u0000");
    const known = groups.get(key);
    if (known === undefined) groups.set(key, { parts, records: [record] });
    else known.records.push(record);
  }

  const ordered = [...groups.values()].sort((a, b) => compareParts(a.parts, b.parts));
  const bases = ordered.map((group) => group.parts.map(idPart).join("-") || "group");
  const baseCounts = new Map<string, number>();
  for (const base of bases) baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1);

  const records: DataRecord[] = [];
  for (let index = 0; index < ordered.length; index++) {
    const group = ordered[index]!;
    const base = bases[index]!;
    const canonical = group.parts.map(keyText).join("\u0000");
    const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 8);
    const readable = [...base].slice(0, 120).join("");
    const id = baseCounts.get(base)! > 1 || unsafeIdReason(readable) !== undefined ? `${readable}-${hash}` : readable;

    const fields: Record<string, unknown> = { [entry.id ?? "id"]: id };
    for (let part = 0; part < group.parts.length; part++) {
      const key = group.parts[part]!;
      fields[aggregate.by[part]!.field] = key.kind === "missing" ? null : key.value;
    }
    const values: Record<string, string | number | boolean | null> = {};
    for (const [metricName, metric] of Object.entries(aggregate.metrics)) {
      values[metricName] = metricOf(metric, metricName, name, group, pos, diagnostics);
    }
    if (aggregate.empty !== "omit" || Object.values(values).some((value) => value !== null)) {
      Object.assign(fields, values);
      const record: DataRecord = {
        id,
        fields,
        position: pos,
        fieldPositions: { ...Object.fromEntries(Object.keys(fields).map((field) => [field, pos])) },
        keyPositions: { ...Object.fromEntries(Object.keys(fields).map((field) => [field, pos])) },
        inputs: group.records.map((member) => member.id),
      };
      records.push(record);
    }
  }

  if (diagnostics.some((finding) => finding.severity === "error")) return { diagnostics };
  return {
    collection: { name, source: input.source, records },
    diagnostics,
  };
}
