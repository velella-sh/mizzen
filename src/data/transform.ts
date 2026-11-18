/**
 * Applies a collection's configured transformation steps, in order, with each step reading the record the previous
 * step wrote. Field paths are dot paths into nested mappings; a path that is absent is not a finding, so a rule that
 * only touches some records can be written once.
 *
 * A value a rule cannot use is a diagnostic at the field's source span, never a throw: the record keeps the value it
 * had and the other records still transform. Rule-level problems (an unsupported date format, an unknown time zone)
 * are one diagnostic at the collection's config line, and that step is skipped.
 *
 * Every field a rule changed is reported as an event with the rule id, the input path, and both values, so an
 * internal consumer such as the preview can explain the output without reading the data file again. Date conversion
 * never reads the clock or the host time zone: the configured zone and format decide the instant.
 */
import type {
  DataRecord,
  Diagnostic,
  RecordPos,
  SourcePos,
} from "../contracts/index.ts";
import type { CollectionTransformConfig, TransformStepConfig } from "../contracts/config.ts";
import { sourcePosOf } from "./positions.ts";

/** A record's fields, read-only. */
type Fields = Readonly<Record<string, unknown>>;

/** The target types a `cast` step understands. */
const CAST_TARGETS = new Set(["string", "number", "integer", "boolean"]);

/** The tokens a date format understands, longest first where two share a prefix. */
const DATE_TOKENS = ["YYYY", "MM", "DD", "HH", "mm", "ss"] as const;

/** One date format compiled once per step. */
interface DateFormat {
  readonly pattern: RegExp;
  readonly tokens: readonly (typeof DATE_TOKENS)[number][];
}

/** A problem a rule found, before the record is named. */
type ValueFinding = (path: string, message: string, help?: string) => void;

/** One field change a transformation step made, for an internal consumer such as the preview. */
export interface TransformEvent {
  /** The id of the rule that made the change. */
  readonly rule: string;
  /** The id of the record the change touched. */
  readonly record: string;
  /** The operator that made the change. */
  readonly op: TransformStepConfig["op"];
  /** The input path the rule read. */
  readonly path: string;
  /** The output path the value now sits at; the same as `path` except for a rename. */
  readonly target: string;
  /** The value before the change. */
  readonly from: unknown;
  /** The value after the change. */
  readonly to: unknown;
}

/** What {@link transformRecords} wrote. */
export interface TransformResult {
  /** The records after every step, in source order unless a step removed rows. */
  readonly records: readonly DataRecord[];
  /** Every finding the rules made, in the order they were made. */
  readonly diagnostics: readonly Diagnostic[];
  /** Every field change, in the order it was made. */
  readonly events: readonly TransformEvent[];
  /** The last rule that touched each top-level field, for naming an output schema finding. */
  readonly lastRuleByField: Readonly<Record<string, string>>;
}

/** Options of {@link transformRecords}. */
export interface TransformOptions {
  /** The collection's name, for diagnostics. */
  readonly collection: string;
  /** Where a rule-level problem points: the collection's `source` in `mizzen.yml`. */
  readonly pos?: SourcePos;
  /** Called once per field change, so a consumer can follow the work without holding every event. */
  readonly onEvent?: (event: TransformEvent) => void;
}

/** The values a rule may write. */
type TransformStep = TransformStepConfig;

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A plain own-key copy, so a key such as `__proto__` stays a field and not the prototype. */
function copyOf(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    Object.defineProperty(copy, key, { value: value[key], writable: true, enumerable: true, configurable: true });
  }
  return copy;
}

/** True for a mapping, not a list or a scalar. */
function isMapping(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The first segment of a dot path. */
function topOf(path: string): string {
  const dot = path.indexOf(".");
  return dot < 0 ? path : path.slice(0, dot);
}

/** A value at a dot path, and whether the whole path exists. */
function readPath(fields: Fields, path: string): { readonly found: boolean; readonly value: unknown } {
  let current: unknown = fields;
  for (const part of path.split(".")) {
    if (!isMapping(current) || !Object.hasOwn(current, part)) return { found: false, value: undefined };
    current = current[part];
  }
  return { found: true, value: current };
}

/** `fields` with the value at a dot path replaced, building a new mapping at every level it touches. */
function writePath(fields: Fields, path: string, value: unknown): Fields {
  const parts = path.split(".");
  const build = (source: Fields, index: number): Fields => {
    const copy = copyOf(source);
    const key = parts[index]!;
    const next = index === parts.length - 1 ? value : build(isMapping(source[key]) ? source[key] : {}, index + 1);
    Object.defineProperty(copy, key, { value: next, writable: true, enumerable: true, configurable: true });
    return copy;
  };
  return build(fields, 0);
}

/** `fields` without the value at a dot path, and whether anything was there. */
function removePath(fields: Fields, path: string): { readonly fields: Fields; readonly removed: boolean } {
  const parts = path.split(".");
  const walk = (source: Fields, index: number): { readonly fields: Fields; readonly removed: boolean } => {
    const key = parts[index]!;
    if (!Object.hasOwn(source, key)) return { fields: source, removed: false };
    if (index === parts.length - 1) {
      const copy = copyOf(source);
      delete copy[key];
      return { fields: copy, removed: true };
    }
    const child = source[key];
    if (!isMapping(child)) return { fields: source, removed: false };
    const nested = walk(child, index + 1);
    if (!nested.removed) return { fields: source, removed: false };
    return { fields: writePath(source, key, nested.fields), removed: true };
  };
  return walk(fields, 0);
}

/** A record with new fields; position maps for fields that are gone are dropped, and new top fields point at the record. */
function withFields(record: DataRecord, fields: Fields, added?: Readonly<Record<string, RecordPos>>): DataRecord {
  const fieldPositions = copyOf(record.fieldPositions as Readonly<Record<string, unknown>>) as Record<string, RecordPos>;
  for (const key of Object.keys(fieldPositions)) if (!Object.hasOwn(fields, key)) delete fieldPositions[key];
  for (const [key, pos] of Object.entries(added ?? {})) {
    if (Object.hasOwn(fields, key) && !Object.hasOwn(fieldPositions, key)) fieldPositions[key] = pos;
  }
  const result: DataRecord = { ...record, fields, fieldPositions };
  if (record.keyPositions === undefined) return result;
  const keyPositions = copyOf(record.keyPositions as Readonly<Record<string, unknown>>) as Record<string, RecordPos>;
  for (const key of Object.keys(keyPositions)) if (!Object.hasOwn(fields, key)) delete keyPositions[key];
  for (const [key, pos] of Object.entries(added ?? {})) {
    if (Object.hasOwn(fields, key) && !Object.hasOwn(keyPositions, key) && Object.hasOwn(record.fieldPositions, key)) {
      keyPositions[key] = pos;
    }
  }
  return { ...result, keyPositions };
}

/** Where a finding about a path points: its top-level field's span, or the record. */
function positionOf(record: DataRecord, path: string): SourcePos {
  return sourcePosOf(record.fieldPositions[topOf(path)] ?? record.position);
}

/** The one diagnostic a broken rule writes, at the collection's config line. */
function ruleFinding(options: TransformOptions, collection: string, rule: string, message: string): Diagnostic {
  return {
    id: "data.transform-step",
    severity: "error",
    message: `Step "${rule}" of "${collection}" ${message}`,
    ...(options.pos === undefined ? {} : { pos: options.pos }),
    help: "Fix the step in `collections.<name>.transform.steps` in mizzen.yml.",
  };
}

/** A value as a short quoted string for a diagnostic. */
function shown(value: unknown): string {
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text;
}

/** The number a value names, or `undefined` when it is not a finite number written as a number or numeric text. */
function numberOf(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** The cast of one value to a primitive type, or `undefined` when the value cannot reach it. */
function castOf(value: unknown, target: string): unknown {
  if (target === "string") {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return undefined;
  }
  if (target === "number" || target === "integer") {
    const parsed = numberOf(value);
    if (parsed === undefined) return undefined;
    return target === "integer" && !Number.isInteger(parsed) ? undefined : parsed;
  }
  if (target === "boolean") {
    if (typeof value === "boolean") return value;
    if (typeof value === "string" && (value.trim().toLowerCase() === "true" || value.trim().toLowerCase() === "false")) {
      return value.trim().toLowerCase() === "true";
    }
    if (value === 0 || value === 1) return value === 1;
  }
  return undefined;
}

/** Compiles a date format, or `undefined` when a required token is missing or repeated. */
function compileDateFormat(format: string): DateFormat | undefined {
  const tokens: (typeof DATE_TOKENS)[number][] = [];
  let source = "^";
  let index = 0;
  while (index < format.length) {
    const token = DATE_TOKENS.find((candidate) => format.startsWith(candidate, index));
    if (token !== undefined) {
      tokens.push(token);
      source += token === "YYYY" ? "(\\d{4})" : "(\\d{1,2})";
      index += token.length;
      continue;
    }
    const char = format[index]!;
    // A letter outside a token is a typo, not a separator; `T` is the ISO 8601 separator.
    if (/[A-Za-z]/.test(char) && char !== "T") return undefined;
    source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    index += 1;
  }
  for (const required of ["YYYY", "MM", "DD"] as const) if (!tokens.includes(required)) return undefined;
  if (new Set(tokens).size !== tokens.length) return undefined;
  return { pattern: new RegExp(`${source}$`), tokens };
}

/** True when the runtime knows the zone. */
function knownZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

/** The UTC milliseconds of a wall clock, with years 0–99 kept as written rather than mapped to 1900–1999. */
function utcMillis(year: number, month: number, day: number, hour: number, minute: number, second: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.getTime();
}

/** The offset of a zone at an instant, in milliseconds east of UTC. */
function zoneOffset(ms: number, zone: string): number {
  let formatter = zoneFormatters.get(zone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    zoneFormatters.set(zone, formatter);
  }
  const parts = formatter.formatToParts(new Date(ms));
  const part = (type: string): number => Number(parts.find((entry) => entry.type === type)?.value ?? "0");
  const hour = part("hour") === 24 ? 0 : part("hour");
  const asUtc = utcMillis(part("year"), part("month"), part("day"), hour, part("minute"), part("second"));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The UTC instant of a wall clock in a zone, without reading the host zone or the clock. */
function utcOfWall(year: number, month: number, day: number, hour: number, minute: number, second: number, zone: string): number {
  const wall = utcMillis(year, month, day, hour, minute, second);
  const first = zoneOffset(wall, zone);
  const candidate = wall - first;
  const second_ = zoneOffset(candidate, zone);
  return second_ === first ? candidate : wall - second_;
}

/** A `YYYY-MM-DD` day. */
function dayText(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Whether the parsed components name a real day and time. */
function realDate(year: number, month: number, day: number, hour: number, minute: number, second: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  const probe = new Date(0);
  probe.setUTCFullYear(year, month - 1, day);
  probe.setUTCHours(hour, minute, second, 0);
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day &&
    probe.getUTCHours() === hour &&
    probe.getUTCMinutes() === minute &&
    probe.getUTCSeconds() === second
  );
}

/** A record after one step, or `undefined` when the step returned it unchanged. */
type RecordStep = (
  record: DataRecord,
  step: TransformStep,
  rule: string,
  finding: ValueFinding,
  event: (path: string, target: string, from: unknown, to: unknown) => void,
) => DataRecord | undefined;

/** `default`: fill a field that is absent, null, or both, as configured. */
const applyDefault: RecordStep = (record, step, _rule, _finding, event) => {
  if (step.op !== "default") return undefined;
  const read = readPath(record.fields, step.field);
  const missing = !read.found || read.value === undefined;
  const isNull = read.found && read.value === null;
  const when = step.when ?? "missing";
  const matches = when === "missing" ? missing : when === "null" ? isNull : missing || isNull;
  if (!matches) return undefined;
  const fields = writePath(record.fields, step.field, step.value);
  const fieldsWithPosition = withFields(record, fields, { [topOf(step.field)]: record.position });
  event(step.field, step.field, read.found ? read.value : undefined, step.value);
  return fieldsWithPosition;
};

/** `cast`: convert a primitive value, reporting the record when it cannot reach the target type. */
const applyCast: RecordStep = (record, step, rule, finding, event) => {
  if (step.op !== "cast") return undefined;
  const read = readPath(record.fields, step.field);
  if (!read.found || read.value === undefined || read.value === null) return undefined;
  const target = CAST_TARGETS.has(step.to) ? step.to : undefined;
  const converted = target === undefined ? undefined : castOf(read.value, target);
  if (converted === undefined || (typeof converted === "number" && Number.isNaN(converted))) {
    finding(
      step.field,
      `cannot convert field "${step.field}" of record "${record.id}" to ${step.to}: ${shown(read.value)}.`,
      "Write a value of the target type, or change the rule's `to`.",
    );
    return undefined;
  }
  if (Object.is(converted, read.value)) return undefined;
  event(step.field, step.field, read.value, converted);
  return withFields(record, writePath(record.fields, step.field, converted));
};

/** `normalize`: trim and change the case of a string with the runtime's locale-independent Unicode rules. */
const applyNormalize: RecordStep = (record, step, _rule, finding, event) => {
  if (step.op !== "normalize") return undefined;
  const read = readPath(record.fields, step.field);
  if (!read.found || read.value === undefined || read.value === null) return undefined;
  if (typeof read.value !== "string") {
    finding(
      step.field,
      `cannot normalize field "${step.field}" of record "${record.id}", which is not text: ${shown(read.value)}.`,
      "Point the rule at a text field, or convert it first with a `cast` step.",
    );
    return undefined;
  }
  let value = step.trim === false ? read.value : read.value.trim();
  if (step.case === "lower") value = value.toLowerCase();
  else if (step.case === "upper") value = value.toUpperCase();
  if (value === read.value) return undefined;
  event(step.field, step.field, read.value, value);
  return withFields(record, writePath(record.fields, step.field, value));
};

/** `map`: replace a recognized categorical value and follow the configured unknown-value policy. */
const applyMap: RecordStep = (record, step, _rule, finding, event) => {
  if (step.op !== "map") return undefined;
  const read = readPath(record.fields, step.field);
  if (!read.found || read.value === undefined || read.value === null) return undefined;
  const scalar = typeof read.value === "string" || typeof read.value === "number" || typeof read.value === "boolean";
  const key = scalar ? String(read.value) : undefined;
  if (key !== undefined && Object.hasOwn(step.values, key)) {
    const value = step.values[key];
    if (Object.is(value, read.value)) return undefined;
    event(step.field, step.field, read.value, value);
    return withFields(record, writePath(record.fields, step.field, value));
  }
  const policy = step.unknown ?? "keep";
  if (policy === "keep") return undefined;
  if (policy === "default" && Object.hasOwn(step, "default")) {
    event(step.field, step.field, read.value, step.default);
    return withFields(record, writePath(record.fields, step.field, step.default));
  }
  finding(
    step.field,
    `meets an unknown value for field "${step.field}" of record "${record.id}": ${shown(read.value)}; expected one of ${Object.keys(step.values).sort(byCodePoint).map((name) => shown(name)).join(", ")}.`,
    "Add the value to the rule's `values`, or set `unknown` to `keep` or `default`.",
  );
  return undefined;
};

/** `date`: read the configured format in the configured zone and write an instant or a day. */
function applyDatesToRecord(
  record: DataRecord,
  step: Extract<TransformStep, { readonly op: "date" }>,
  format: DateFormat,
  finding: ValueFinding,
  event: (path: string, target: string, from: unknown, to: unknown) => void,
): DataRecord | undefined {
  const read = readPath(record.fields, step.field);
  if (!read.found || read.value === undefined || read.value === null) return undefined;
  if (typeof read.value !== "string") {
    finding(step.field, `cannot read field "${step.field}" of record "${record.id}" as a date: ${shown(read.value)}.`, "Write the date as text in the rule's format.");
    return undefined;
  }
  const match = format.pattern.exec(read.value);
  if (match === null) {
    finding(
      step.field,
      `cannot read field "${step.field}" of record "${record.id}" as a date with format "${step.format}": ${shown(read.value)}.`,
      "Write the date in the rule's format, or change the format.",
    );
    return undefined;
  }
  const values: Record<string, number> = {};
  format.tokens.forEach((token, index) => (values[token] = Number(match[index + 1])));
  const year = values["YYYY"]!;
  const month = values["MM"]!;
  const day = values["DD"]!;
  const hour = values["HH"] ?? 0;
  const minute = values["mm"] ?? 0;
  const second = values["ss"] ?? 0;
  if (!realDate(year, month, day, hour, minute, second)) {
    finding(step.field, `cannot read field "${step.field}" of record "${record.id}" as a date: ${shown(read.value)} names no real day.`, "Write a real calendar day.");
    return undefined;
  }
  let value: string;
  if (step.output === "date") {
    value = dayText(year, month, day);
  } else {
    const instant = utcOfWall(year, month, day, hour, minute, second, step.timezone);
    value = new Date(instant).toISOString();
  }
  if (value === read.value) return undefined;
  event(step.field, step.field, read.value, value);
  return withFields(record, writePath(record.fields, step.field, value));
}

/** `unit`: multiply a finite number by a factor and round it. */
const applyUnit: RecordStep = (record, step, _rule, finding, event) => {
  if (step.op !== "unit") return undefined;
  const read = readPath(record.fields, step.field);
  if (!read.found || read.value === undefined || read.value === null) return undefined;
  const parsed = numberOf(read.value);
  if (parsed === undefined) {
    finding(
      step.field,
      `cannot convert field "${step.field}" of record "${record.id}", which is not numeric: ${shown(read.value)}.`,
      "Write a number, or convert the field first with a `cast` step.",
    );
    return undefined;
  }
  const scaled = parsed * step.factor;
  const value = step.round === undefined ? scaled : Math.round(scaled * 10 ** step.round) / 10 ** step.round;
  if (!Number.isFinite(value)) {
    finding(step.field, `converting field "${step.field}" of record "${record.id}" produced a value that is not finite.`, "Use a smaller factor or a smaller value.");
    return undefined;
  }
  if (Object.is(value, read.value)) return undefined;
  event(step.field, step.field, read.value, value);
  return withFields(record, writePath(record.fields, step.field, value));
};

/** `rename`: move a value, rejecting or overwriting a destination that already holds one. */
const applyRename: RecordStep = (record, step, _rule, finding, event) => {
  if (step.op !== "rename") return undefined;
  if (step.from === step.to) return undefined;
  if (step.from.startsWith(`${step.to}.`) || step.to.startsWith(`${step.from}.`)) {
    finding(
      step.from,
      `cannot rename "${step.from}" to "${step.to}" in record "${record.id}", because one path contains the other.`,
      "Rename to a path that is not inside the field being moved.",
    );
    return undefined;
  }
  const source = readPath(record.fields, step.from);
  if (!source.found) return undefined;
  const destination = readPath(record.fields, step.to);
  if (destination.found && (step.onConflict ?? "error") === "error") {
    finding(
      step.from,
      `cannot rename "${step.from}" to "${step.to}" in record "${record.id}", where a value already sits.`,
      "Remove the destination first, or set the rule's `onConflict` to `overwrite`.",
    );
    return undefined;
  }
  const fromTop = topOf(step.from);
  const toTop = topOf(step.to);
  const sourcePos = record.fieldPositions[fromTop];
  let fields = destination.found ? removePath(record.fields, step.to).fields : record.fields;
  fields = writePath(fields, step.to, source.value);
  fields = removePath(fields, step.from).fields;
  event(step.from, step.to, source.value, source.value);
  return withFields(record, fields, sourcePos === undefined ? { [toTop]: record.position } : { [toTop]: sourcePos });
};

/** The record-level operators, by name. */
const RECORD_STEPS: Readonly<Record<string, RecordStep>> = {
  default: applyDefault,
  cast: applyCast,
  normalize: applyNormalize,
  map: applyMap,
  unit: applyUnit,
  rename: applyRename,
};

/** `select`: keep only the listed paths, reporting each top-level field that was left out. */
function selectRecords(
  records: readonly DataRecord[],
  step: Extract<TransformStep, { readonly op: "select" }>,
  event: (record: DataRecord, path: string, target: string, from: unknown, to: unknown) => void,
): readonly DataRecord[] {
  return records.map((record) => {
    let fields: Fields = {};
    for (const path of step.fields) {
      const read = readPath(record.fields, path);
      if (read.found) fields = writePath(fields, path, read.value);
    }
    for (const key of Object.keys(record.fields)) {
      if (!Object.hasOwn(fields, key)) event(record, key, key, record.fields[key], undefined);
    }
    return withFields(record, fields);
  });
}

/** `remove`: drop the listed paths, reporting each value that was there. */
function removeRecords(
  records: readonly DataRecord[],
  step: Extract<TransformStep, { readonly op: "remove" }>,
  event: (record: DataRecord, path: string, target: string, from: unknown, to: unknown) => void,
): readonly DataRecord[] {
  return records.map((record) => {
    let fields = record.fields;
    for (const path of step.fields) {
      const read = readPath(fields, path);
      if (!read.found) continue;
      fields = removePath(fields, path).fields;
      event(record, path, path, read.value, undefined);
    }
    return withFields(record, fields);
  });
}

/** True when a record value matches a configured condition; a list means any of its items. */
function matches(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return expected.some((candidate) => matches(actual, candidate));
  return actual === expected;
}

/** `filter`: keep records that match every condition. */
function filterRecords(
  records: readonly DataRecord[],
  step: Extract<TransformStep, { readonly op: "filter" }>,
): readonly DataRecord[] {
  const conditions = Object.entries(step.where);
  return records.filter((record) =>
    conditions.every(([path, expected]) => {
      const read = readPath(record.fields, path);
      return read.found && matches(read.value, expected);
    }),
  );
}

/** The composite key of one record, with an absent path kept distinct from null. */
function keyOf(record: DataRecord, paths: readonly string[]): string {
  return JSON.stringify(
    paths.map((path) => {
      const read = readPath(record.fields, path);
      return read.found ? read.value : { absent: true };
    }),
  );
}

/** `dedupe`: keep the first or the last record of each composite key, in source order. */
function dedupeRecords(
  records: readonly DataRecord[],
  step: Extract<TransformStep, { readonly op: "dedupe" }>,
): readonly DataRecord[] {
  const chosen = new Map<string, number>();
  records.forEach((record, index) => {
    const key = keyOf(record, step.by);
    const held = chosen.get(key);
    if (held === undefined || step.keep === "last") chosen.set(key, index);
  });
  const kept = new Set(chosen.values());
  return records.filter((_record, index) => kept.has(index));
}

/** Applies every step in order, each to the output of the one before. */
export function transformRecords(
  records: readonly DataRecord[],
  config: CollectionTransformConfig | undefined,
  options: TransformOptions,
): TransformResult {
  const steps = config?.steps ?? [];
  if (steps.length === 0) return { records, diagnostics: [], events: [], lastRuleByField: {} };
  const diagnostics: Diagnostic[] = [];
  const events: TransformEvent[] = [];
  const lastRuleByField: Record<string, string> = {};
  let current = records;

  const emit = (record: DataRecord, rule: string, op: TransformStep["op"], path: string, target: string, from: unknown, to: unknown): void => {
    const event: TransformEvent = { rule, record: record.id, op, path, target, from, to };
    events.push(event);
    lastRuleByField[topOf(path)] = rule;
    lastRuleByField[topOf(target)] = rule;
    options.onEvent?.(event);
  };

  for (let index = 0; index < steps.length; index++) {
    const step = steps[index]!;
    const rule = step.id === undefined || step.id === "" ? `step-${index + 1}` : step.id;
    if (step.op === "select" || step.op === "remove" || step.op === "filter" || step.op === "dedupe") {
      if (step.op === "select") current = selectRecords(current, step, (record, path, target, from, to) => emit(record, rule, step.op, path, target, from, to));
      else if (step.op === "remove") current = removeRecords(current, step, (record, path, target, from, to) => emit(record, rule, step.op, path, target, from, to));
      else if (step.op === "filter") current = filterRecords(current, step);
      else current = dedupeRecords(current, step);
      continue;
    }

    if (step.op === "date") {
      const format = compileDateFormat(step.format);
      if (format === undefined) {
        diagnostics.push(
          ruleFinding(options, options.collection, rule, `has no usable date format "${step.format}"; use YYYY, MM, DD, HH, mm, and ss with literal separators.`),
        );
        continue;
      }
      if (!knownZone(step.timezone)) {
        diagnostics.push(ruleFinding(options, options.collection, rule, `names an unknown time zone "${step.timezone}".`));
        continue;
      }
      current = current.map((record) => {
        const finding: ValueFinding = (path, message, help) =>
          diagnostics.push({
            id: "data.transform-date",
            severity: "error",
            message: `Step "${rule}" of "${options.collection}" ${message}`,
            pos: positionOf(record, path),
            ...(help === undefined ? {} : { help }),
          });
        return applyDatesToRecord(record, step, format, finding, (path, target, from, to) => emit(record, rule, step.op, path, target, from, to)) ?? record;
      });
      continue;
    }

    const apply = RECORD_STEPS[step.op];
    if (apply === undefined) {
      diagnostics.push(ruleFinding(options, options.collection, rule, `names an unknown operator "${step.op}".`));
      continue;
    }
    current = current.map((record) => {
      const finding: ValueFinding = (path, message, help) =>
        diagnostics.push({
          id: step.op === "cast" ? "data.transform-cast" : step.op === "normalize" ? "data.transform-normalize" : step.op === "unit" ? "data.transform-unit" : step.op === "map" ? "data.transform-map" : "data.transform-rename-conflict",
          severity: "error",
          message: `Step "${rule}" of "${options.collection}" ${message}`,
          pos: positionOf(record, path),
          ...(help === undefined ? {} : { help }),
        });
      return apply(record, step, rule, finding, (path, target, from, to) => emit(record, rule, step.op, path, target, from, to)) ?? record;
    });
  }

  return { records: current, diagnostics, events, lastRuleByField };
}
