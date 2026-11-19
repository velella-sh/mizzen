/**
 * Field lineage: why one published field holds the value it holds, from the bytes it was read from to the page or API
 * path that publishes it. A report is a versioned (`format: 1`) chain of events; each event names the stage, the input
 * reference, the record, and the field at that stage. Values are never part of an event, so a report can be shown
 * without copying the dataset.
 *
 * The chain follows the build order backwards: a joined destination is selected from its source, an aggregate value
 * from its input records, a transform result from the path its rule read, and a schema-renamed field from its earlier
 * name. The first event is the raw origin with the source SHA-256 and row, and the last events are the published page
 * and static API paths.
 *
 * A chain keeps at most {@link LINEAGE_EVENT_LIMIT} events. Beyond that the report keeps the source and the newest
 * stages and marks itself `summarized`, so one query never holds an unbounded history for a record.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Collection, CollectionConfig, CollectionSnapshot, DataRecord, SiteConfig } from "../contracts/index.ts";
import { fieldsWithDerived } from "./derived.ts";
import type { DataLock } from "./lock.ts";
import { sha256 } from "./lock.ts";
import { recordUrl } from "./permalink.ts";
import { isPublicReference } from "./public.ts";
import type { TransformEvent } from "./transform.ts";

/** The version of the event and report contract. */
export const LINEAGE_FORMAT = 1;

/** The most events one field chain keeps; beyond it the report is marked summarized. */
export const LINEAGE_EVENT_LIMIT = 32;

/** Where one event's value was read from. A public report leaves out `source`, the path inside the site. */
export interface LineageInput {
  /** The collection the value was read from. */
  readonly collection: string;
  /** The source path, URL, or package address; omitted from a public report. */
  readonly source?: string;
  /** SHA-256 of the source bytes, when the source can be read or the lock holds it. */
  readonly sha256?: string;
  /** 1-based row in the source, or line of the record. */
  readonly row?: number;
  /** 1-based page of a paginated API source, when it has exactly one page. */
  readonly page?: number;
}

/** A published path one of the record's fields ends up in. */
export interface LineageOutput {
  /** `page` for a record page, `api` for the static data API. */
  readonly kind: "page" | "api";
  /** The URL or API path, including the site base. */
  readonly path: string;
}

/** One stage of one field's history. */
export interface LineageEvent {
  /** The contract version, so a consumer can read a report without guessing. */
  readonly format: typeof LINEAGE_FORMAT;
  /** The stage id: `source`, `schema-rename`, `transform:<rule>`, `join:<collection>`, `aggregate:<collection>`, or `publish`. */
  readonly stage: string;
  /** What the stage did: `origin`, a transform operator, `select`, `aggregate`, or `publish`. */
  readonly op: string;
  /** The input reference the stage read. */
  readonly input: LineageInput;
  /** The record id. */
  readonly record: string;
  /** The field path at this stage. */
  readonly field: string;
  /** The transform or derived rule id, when a rule made the value. */
  readonly rule?: string;
  /** The collection a join or aggregate value was selected from. */
  readonly source?: string;
  /** The path the value was read from before this stage. */
  readonly from?: string;
  /** Why a join selected this input. */
  readonly reason?: "only" | "precedence" | "null-fallthrough";
  /** Every `<collection>.<field>` a join could have selected, in precedence order; absent from a public report. */
  readonly inputs?: readonly string[];
  /** How many records contributed to an aggregate or join value. */
  readonly contributors?: number;
  /** The published path this event connects the field to, on a `publish` event. */
  readonly output?: LineageOutput;
}

/** The snapshot an aggregate report references, with the internal source path left out. */
export interface LineageSnapshot {
  /** The commit, package version, or `sha256:` ref the data was recorded at. */
  readonly ref?: string;
  /** When the data was recorded, from the data and never the build clock. */
  readonly capturedAt?: string;
  /** The tool that recorded it. */
  readonly tool?: string;
  /** That tool's version. */
  readonly toolVersion?: string;
}

/** One field's lineage report. */
export interface LineageReport {
  /** The contract version. */
  readonly format: typeof LINEAGE_FORMAT;
  /** The collection name. */
  readonly collection: string;
  /** The record id. */
  readonly record: string;
  /** The final field path. */
  readonly field: string;
  /** The value, in a private report; a public report never carries it. */
  readonly value?: unknown;
  /** True when a rule or aggregate generated the value rather than reading it from the field's own raw value. */
  readonly generated: boolean;
  /** The stages, earliest first. */
  readonly chain: readonly LineageEvent[];
  /** The page and API paths that publish the field. */
  readonly outputs: readonly LineageOutput[];
  /** True when older stages were dropped to stay within {@link LINEAGE_EVENT_LIMIT}. */
  readonly summarized: boolean;
  /** How many stages were dropped. */
  readonly omitted: number;
  /** The source collection's snapshot, for an aggregate value. */
  readonly snapshot?: LineageSnapshot;
}

/** What {@link explain} may read beyond the collection itself. */
export interface LineageContext {
  /** The site root, so a file source's bytes can be hashed. */
  readonly root?: string;
  /** The loaded config, for rules, renames, joins, aggregates, permalinks, and the API. */
  readonly config?: SiteConfig;
  /** Every loaded collection, so a join or aggregate can trace into its source. */
  readonly collections?: Readonly<Record<string, Collection>>;
  /** Transform changes captured during the load; each names its collection and record. */
  readonly transformEvents?: readonly TransformEvent[];
  /** The lock, for a pinned source's hash and page count. */
  readonly lock?: DataLock;
  /** Print only permitted metadata, with no values, secrets, or internal paths. */
  readonly public?: boolean;
}

/** A found report, or a message naming the missing target. */
export type LineageResult =
  | { readonly ok: true; readonly report: LineageReport }
  | { readonly ok: false; readonly error: string };

/** `path` or a path under it. */
function covers(prefix: string, path: string): boolean {
  return prefix === path || path.startsWith(`${prefix}.`);
}

/** The segments of a dot path. */
function segmentsOf(path: string): string[] {
  return path
    .split(".")
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "");
}

/** The first segment of a dot path. */
function topOf(path: string): string {
  return segmentsOf(path)[0] ?? "";
}

/** True for a mapping, not a list or a scalar. */
function isMapping(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The value at a dot path, and whether every segment was present. */
function at(value: unknown, segments: readonly string[]): { readonly found: boolean; readonly value?: unknown } {
  let current = value;
  for (const segment of segments) {
    if (!isMapping(current) || !Object.hasOwn(current, segment)) return { found: false };
    current = current[segment];
  }
  return { found: true, value: current };
}

/** A record position's source line, when the record has one. */
function rowOf(record: DataRecord): number | undefined {
  return Number.isSafeInteger(record.position.startLine) && record.position.startLine > 0 ? record.position.startLine : undefined;
}

/** The SHA-256 a snapshot records, for a pinned URL or package source. */
function snapshotHash(snapshot: CollectionSnapshot | undefined): string | undefined {
  const ref = snapshot?.ref;
  return ref !== undefined && ref.startsWith("sha256:") ? ref.slice("sha256:".length) : undefined;
}

/** A snapshot as a report publishes it: no internal source path, no schema file. */
function reportSnapshot(snapshot: CollectionSnapshot | undefined): LineageSnapshot | undefined {
  if (snapshot === undefined) return undefined;
  return {
    ...(snapshot.ref === undefined ? {} : { ref: snapshot.ref }),
    ...(snapshot.capturedAt === undefined ? {} : { capturedAt: snapshot.capturedAt }),
    ...(snapshot.tool === undefined ? {} : { tool: snapshot.tool }),
    ...(snapshot.toolVersion === undefined ? {} : { toolVersion: snapshot.toolVersion }),
  };
}

/** The source reference of a collection, with its hash and page count when they are known. */
async function inputOf(collection: Collection, context: LineageContext): Promise<LineageInput> {
  let hash = snapshotHash(collection.snapshot);
  const locked = context.lock?.sources[collection.source];
  hash ??= locked?.sha256;
  if (hash === undefined && context.root !== undefined && !/^[a-z][a-z\d+.-]*:/i.test(collection.source)) {
    try {
      hash = sha256(await readFile(resolve(context.root, collection.source)));
    } catch {
      // A missing or unreadable file has no hash; the report still names the source and row.
    }
  }
  const pages = locked?.pages;
  return {
    collection: collection.name,
    source: collection.source,
    ...(hash === undefined ? {} : { sha256: hash }),
    ...(pages !== undefined && pages.length === 1 ? { page: 1 } : {}),
  };
}

/** A collection source reference plus the record's row. */
async function inputAt(collection: Collection, record: DataRecord, context: LineageContext): Promise<LineageInput> {
  const base = await inputOf(collection, context);
  const row = rowOf(record);
  return row === undefined ? base : { ...base, row };
}

/** The first segment of a key, always as a list. */
function keysOf(key: string | readonly string[]): readonly string[] {
  return typeof key === "string" ? [key] : key;
}

/** The source record a one-to-one join selected, by comparing the key values the join kept. */
function joinedRecordOf(
  record: DataRecord,
  entry: CollectionConfig | undefined,
  sourceName: string,
  source: Collection | undefined,
): DataRecord | undefined {
  const join = entry?.join;
  if (join === undefined || source === undefined) return undefined;
  const sourceConfig = join.sources.find((candidate) => candidate.collection === sourceName);
  if (sourceConfig === undefined) return undefined;
  if ((sourceConfig.many ?? join.many ?? "error") === "list") return undefined;
  const primaryKeys = keysOf(join.key);
  const sourceKeys = keysOf(sourceConfig.key ?? join.key);
  const key = record.joined?.key;
  const matches = source.records
    .filter((candidate) =>
      sourceKeys.every((field, index) => {
        const expected = key?.[primaryKeys[index] ?? ""] ?? String(record.fields[primaryKeys[index] ?? ""] ?? "");
        return String(candidate.fields[field] ?? "") === expected;
      }),
    )
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (matches.length === 0) return undefined;
  return (sourceConfig.many ?? join.many ?? "error") === "last" ? matches[matches.length - 1]! : matches[0]!;
}

/** The transform events for one record, in the order the rules made them. */
function eventsOf(
  collection: Collection,
  recordId: string,
  context: LineageContext,
): readonly TransformEvent[] {
  return (context.transformEvents ?? []).filter(
    (event) => event.collection === collection.name && event.record === recordId,
  );
}

/** One transform result and the path it was read from. */
interface TransformTrace {
  readonly events: readonly TransformEvent[];
  /** The path at the start of the transform stage. */
  readonly origin: string;
  /** True when the first event filled an absent value, so no raw value was read. */
  readonly generated: boolean;
}

/** Follows a final path backwards through the rules that touched it. */
function transformTrace(events: readonly TransformEvent[], fieldPath: string): TransformTrace {
  let current = fieldPath;
  const found: TransformEvent[] = [];
  let generated = false;
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (!covers(event.target, current)) continue;
    // A remove or select leaves no value at the path; a later default generated the current one.
    if (event.to === undefined) break;
    found.push(event);
    if (event.op === "default") {
      generated = true;
      break;
    }
    if (event.op === "rename") {
      const suffix = current.slice(event.target.length);
      current = `${event.path}${suffix}`;
    }
  }
  found.reverse();
  return { events: found, origin: current, generated };
}

/** A chain under construction. */
interface Chain {
  readonly events: LineageEvent[];
  readonly original: string;
  readonly generated: boolean;
  readonly snapshot: LineageSnapshot | undefined;
}

/** The public form of a report: metadata only, with no value, source path, or rejected input list. */
function publicReport(report: LineageReport): LineageReport {
  return {
    format: report.format,
    collection: report.collection,
    record: report.record,
    field: report.field,
    generated: report.generated,
    chain: report.chain.map((event) => ({
      format: event.format,
      stage: event.stage,
      op: event.op,
      input: {
        collection: event.input.collection,
        ...(event.input.sha256 === undefined ? {} : { sha256: event.input.sha256 }),
        ...(event.input.row === undefined ? {} : { row: event.input.row }),
        ...(event.input.page === undefined ? {} : { page: event.input.page }),
      },
      record: event.record,
      field: event.field,
      ...(event.rule === undefined ? {} : { rule: event.rule }),
      ...(event.source === undefined ? {} : { source: event.source }),
      ...(event.reason === undefined ? {} : { reason: event.reason }),
      ...(event.contributors === undefined ? {} : { contributors: event.contributors }),
      ...(event.output === undefined ? {} : { output: event.output }),
    })),
    outputs: report.outputs,
    summarized: report.summarized,
    omitted: report.omitted,
    ...(report.snapshot === undefined ? {} : { snapshot: report.snapshot }),
  };
}

/** The page URL and static API path that publish a record's field. */
function outputsOf(
  collection: Collection,
  record: DataRecord,
  fieldPath: string,
  context: LineageContext,
): LineageOutput[] {
  const config = context.config;
  if (config === undefined) return [];
  const entry = config.collections[collection.name];
  const outputs: LineageOutput[] = [];
  if (entry?.template !== undefined && entry.permalink !== undefined) {
    const url = recordUrl(collection.name, record.id, record.fields, entry, {
      base: config.base,
      position: record.position,
    });
    if (url.url !== undefined) outputs.push({ kind: "page", path: url.url });
  }
  const api = config.api;
  const published = api?.collections[collection.name];
  if (api !== undefined && published !== undefined) {
    const fieldPublished = published.fields.some(
      (field) => field === fieldPath || covers(field, fieldPath) || covers(fieldPath, field),
    );
    if (fieldPublished && isPublicReference(entry?.public, fieldPath)) {
      const base = config.base.replace(/\/+$/, "");
      outputs.push({
        kind: "api",
        path: `${base}/api/${api.version}/${collection.name}/${record.id}.json`,
      });
    }
  }
  return outputs;
}

/** The stages before the final collection's publish step, earliest first. */
async function chainFor(
  collection: Collection,
  record: DataRecord,
  fieldPath: string,
  context: LineageContext,
  depth: number,
  seen: ReadonlySet<string>,
  skipJoin: boolean,
): Promise<Chain> {
  const key = `${collection.name}\u0000${record.id}\u0000${fieldPath}\u0000${skipJoin ? "primary" : "full"}`;
  if (depth > 8 || seen.has(key)) return { events: [], original: fieldPath, generated: false, snapshot: undefined };
  const nextSeen = new Set(seen);
  nextSeen.add(key);
  const entry = context.config?.collections[collection.name];
  const raw = await inputAt(collection, record, context);

  // A derived value is computed from the record's date field after every transform and join. Trace the date first.
  const derived = record.derived?.[topOf(fieldPath)];
  if (derived !== undefined && !Object.hasOwn(record.fields, topOf(fieldPath))) {
    const rule = entry?.derived?.[topOf(fieldPath)];
    const sourceField = rule !== undefined && "field" in rule ? rule.field : undefined;
    const before =
      sourceField === undefined
        ? { events: [], original: fieldPath, generated: false, snapshot: undefined }
        : await chainFor(collection, record, sourceField, context, depth + 1, nextSeen, skipJoin);
    return {
      events: [
        ...before.events,
        {
          format: LINEAGE_FORMAT,
          stage: `derived:${topOf(fieldPath)}`,
          op: "compute",
          input: raw,
          record: record.id,
          field: fieldPath,
          rule: topOf(fieldPath),
          ...(sourceField === undefined ? {} : { from: sourceField }),
          contributors: sourceField === undefined ? 0 : 1,
        },
      ],
      original: before.original,
      generated: true,
      snapshot: before.snapshot,
    };
  }

  // A join runs after the primary collection's transform. The selected destination is the final value.
  const joined = record.joined?.fields[topOf(fieldPath)];
  if (!skipJoin && joined !== undefined) {
    const sourceCollection = context.collections?.[joined.source];
    const sourceRecord = joinedRecordOf(record, entry, joined.source, sourceCollection);
    const sourceInput =
      sourceRecord !== undefined && sourceCollection !== undefined
        ? await inputAt(sourceCollection, sourceRecord, context)
        : sourceCollection === undefined
          ? raw
          : await inputOf(sourceCollection, context);
    const before = joined.source === collection.name
      ? await chainFor(collection, record, joined.input, context, depth + 1, nextSeen, true)
      : sourceRecord === undefined || sourceCollection === undefined
        ? { events: [], original: joined.input, generated: false, snapshot: undefined }
        : await chainFor(sourceCollection, sourceRecord, joined.input, context, depth + 1, nextSeen, false);
    return {
      events: [
        ...before.events,
        {
          format: LINEAGE_FORMAT,
          stage: `join:${joined.source}`,
          op: "select",
          input: joined.source === collection.name ? raw : sourceInput,
          record: record.id,
          field: fieldPath,
          source: joined.source,
          from: joined.input,
          reason: joined.reason,
          inputs: joined.inputs,
          contributors: joined.inputs.length,
        },
      ],
      original: before.original,
      generated: before.generated,
      snapshot: before.snapshot,
    };
  }

  // The collection's own rules ran before a join and, on an aggregate, after its summary was built.
  const trace = transformTrace(eventsOf(collection, record.id, context), fieldPath);
  const transformed: LineageEvent[] = trace.events.map((event) => {
    const suffix = covers(event.target, fieldPath) ? fieldPath.slice(event.target.length) : "";
    return {
      format: LINEAGE_FORMAT,
      stage: `transform:${event.rule}`,
      op: event.op,
      input: raw,
      record: record.id,
      field: `${event.target}${suffix}`,
      rule: event.rule,
      ...(event.op === "rename" ? { from: `${event.path}${suffix}` } : {}),
    };
  });

  let original = trace.origin;
  let generated = trace.generated;
  let snapshot: LineageSnapshot | undefined;
  let before: Chain = { events: [], original, generated, snapshot };
  let aggregateEvent: LineageEvent | undefined;

  const aggregate = entry?.aggregate;
  if (aggregate !== undefined && record.inputs !== undefined) {
    const sourceCollection = context.collections?.[collection.source];
    const top = topOf(original);
    const group = aggregate.by.find((candidate) => candidate.field === top);
    const metric = Object.entries(aggregate.metrics).find(([name]) => name === top);
    const contributing = record.inputs;
    let sourceField: string | undefined;
    if (group !== undefined) sourceField = group.field;
    else if (metric !== undefined && metric[1].op !== "count") sourceField = metric[1].field;
    const first =
      sourceField === undefined || sourceCollection === undefined
        ? undefined
        : contributing
            .map((id) => sourceCollection.records.find((candidate) => candidate.id === id))
            .find((candidate) => candidate !== undefined && at(candidate.fields, segmentsOf(sourceField)).found);
    before =
      first === undefined || sourceCollection === undefined || sourceField === undefined
        ? { events: [], original, generated: false, snapshot: undefined }
        : await chainFor(sourceCollection, first, sourceField, context, depth + 1, nextSeen, false);
    const sourceInput = sourceCollection === undefined ? raw : await inputOf(sourceCollection, context);
    snapshot = reportSnapshot(sourceCollection?.snapshot) ??
      (sourceInput.sha256 === undefined ? undefined : { ref: `sha256:${sourceInput.sha256}` });
    aggregateEvent = {
      format: LINEAGE_FORMAT,
      stage: `aggregate:${collection.source}`,
      op: "aggregate",
      input: sourceInput,
      record: record.id,
      field: original,
      rule: group !== undefined ? `by:${group.field}` : `metric:${top}`,
      ...(sourceField === undefined || group !== undefined ? {} : { from: sourceField }),
      contributors: contributing.length,
    };
    generated = true;
    original = before.original;
  }

  // A schema rename moved an earlier field to its current name before any transform read it.
  const renames: LineageEvent[] = [];
  const schemaRenames = entry?.schemaRenames;
  if (schemaRenames !== undefined) {
    for (let step = 0; step < 16; step++) {
      let renamed = false;
      for (const [now, old] of Object.entries(schemaRenames)) {
        if (!covers(now, original)) continue;
        const suffix = original.slice(now.length);
        renames.push({
          format: LINEAGE_FORMAT,
          stage: "schema-rename",
          op: "rename",
          input: raw,
          record: record.id,
          field: `${now}${suffix}`,
          rule: `schemaRenames.${now}`,
          from: `${old}${suffix}`,
        });
        original = `${old}${suffix}`;
        renamed = true;
        break;
      }
      if (!renamed) break;
    }
  }

  const chain: LineageEvent[] = [
    ...before.events,
    ...(aggregateEvent === undefined ? [] : [aggregateEvent]),
    ...renames,
    ...transformed,
  ];
  if (!generated) {
    chain.unshift({
      format: LINEAGE_FORMAT,
      stage: "source",
      op: "origin",
      input: raw,
      record: record.id,
      field: original,
    });
  }
  return {
    events: chain,
    original,
    generated,
    snapshot: snapshot ?? before.snapshot,
  };
}

/** Keeps the first and the newest stages, so a capped chain still names its source and its latest rule. */
function cap(chain: readonly LineageEvent[]): { readonly events: readonly LineageEvent[]; readonly omitted: number } {
  if (chain.length <= LINEAGE_EVENT_LIMIT) return { events: chain, omitted: 0 };
  const omitted = chain.length - LINEAGE_EVENT_LIMIT;
  return {
    events: [chain[0]!, ...chain.slice(chain.length - (LINEAGE_EVENT_LIMIT - 1))],
    omitted,
  };
}

/** Where a removed field went, for a missing-target message. */
function removalOf(collection: Collection, record: DataRecord, fieldPath: string, context: LineageContext): string | undefined {
  const events = eventsOf(collection, record.id, context);
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event.to === undefined && covers(event.target, fieldPath)) return event.rule;
  }
  return undefined;
}

/**
 * Explains one field of one record: its `format: 1` chain from the raw source to the page and API paths, or a message
 * naming the missing collection, record, or field. `context.public` returns only permitted metadata, checked against
 * the collection's `public` policy with {@link isPublicReference}.
 */
export async function explain(
  collection: Collection,
  recordId: string,
  fieldPath: string,
  context: LineageContext = {},
): Promise<LineageResult> {
  if (collection === undefined || collection === null) {
    return { ok: false, error: "no collection was given" };
  }
  const record = collection.records.find((candidate) => candidate.id === recordId);
  if (record === undefined) {
    return { ok: false, error: `collection "${collection.name}" has no record "${recordId}"` };
  }
  const segments = segmentsOf(fieldPath);
  if (segments.length === 0) {
    return { ok: false, error: `a field path is required, such as "title" or "author.name"` };
  }
  const found = at(fieldsWithDerived(record), segments);
  if (!found.found) {
    const rule = removalOf(collection, record, fieldPath, context);
    const hint = rule === undefined ? "" : `; transform step "${rule}" removed it`;
    return { ok: false, error: `record "${collection.name}/${recordId}" has no field "${fieldPath}"${hint}` };
  }
  if (context.public === true) {
    if (context.config === undefined) {
      return { ok: false, error: "a public report needs the site config to check the field's public policy" };
    }
    const policy = context.config.collections[collection.name]?.public;
    if (!isPublicReference(policy, fieldPath)) {
      return {
        ok: false,
        error: `field "${fieldPath}" of "${collection.name}" is not public; add it to \`collections.${collection.name}.public\` or drop --public`,
      };
    }
  }

  const built = await chainFor(collection, record, fieldPath, context, 0, new Set(), false);
  const outputs = outputsOf(collection, record, fieldPath, context);
  const publish: LineageEvent[] = outputs.map((output) => ({
    format: LINEAGE_FORMAT,
    stage: "publish",
    op: "publish",
    input: built.events[0]?.input ?? { collection: collection.name },
    record: record.id,
    field: fieldPath,
    output,
  }));
  const limited = cap([...built.events, ...publish]);
  const snapshot = built.snapshot;
  const report: LineageReport = {
    format: LINEAGE_FORMAT,
    collection: collection.name,
    record: record.id,
    field: fieldPath,
    value: found.value,
    generated: built.generated,
    chain: limited.events,
    outputs,
    summarized: limited.omitted > 0,
    omitted: limited.omitted,
    ...(snapshot === undefined ? {} : { snapshot }),
  };
  return { ok: true, report: context.public === true ? publicReport(report) : report };
}
