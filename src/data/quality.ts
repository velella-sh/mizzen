/**
 * `mizzen data quality`: the rules in the config, read over the collections the config declares.
 *
 * A rule's `where` is a list page's `where`, applied with the same matcher, so a record outside the rule's scope is
 * reported as out of scope rather than as a finding. Findings are made in config order, then source order, then field
 * order, so two runs print the same lines.
 *
 * `coverage` and `count` compare the current data with `data-quality.json` in the site root, which `--write` records. A
 * missing or malformed baseline is a diagnostic, never a throw, and nothing reads the clock, so two runs over the same
 * files print the same lines.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  Collection,
  DataRecord,
  Diagnostic,
  QualityRule,
  QualityRuleKind,
  SiteConfig,
} from "../contracts/index.ts";
import { loadCollections } from "./collections.ts";
import { canonicalJson } from "./lock.ts";
import { compareCodePoint, filterRows, hasValue, parseQuery } from "./query.ts";
import { resolveIn } from "./record-context.ts";
import { referenceDateOf } from "./reference-date.ts";

/** The file `--write` records and the coverage and count rules compare against, in the site root. */
export const BASELINE_FILE = "data-quality.json";

/** The baseline key of a rule without a `where`: every record of the collection. */
const NO_SCOPE = "*";

/** One rule that a record fails, or the exception that holds it back. */
export interface QualityFinding {
  /** Stable id, such as `data.quality.completeness.items.a.author`. */
  readonly id: string;
  /** The rule's kind. */
  readonly kind: QualityRuleKind;
  /** How the config's policy reports it. */
  readonly severity: "warning" | "error";
  readonly collection: string;
  /** The record the finding names; empty for a collection-wide finding. */
  readonly record: string;
  /** The field the finding names; empty for a count finding. */
  readonly field: string;
  /** For coverage and count: the value the baseline holds. */
  readonly before?: number;
  /** For coverage and count: the value now. */
  readonly after?: number;
  /** For coverage and count: how far the value fell. */
  readonly drop?: number;
  /** For coverage and count: the rule's limit. */
  readonly maxDrop?: number;
  /** One line a reader can act on. */
  readonly message: string;
}

/** One rule's scope: the records it checked, and the records its `where` left out. */
export interface QualityScope {
  readonly collection: string;
  readonly kind: QualityRuleKind;
  /** Record ids the rule checked, in source order. */
  readonly checked: readonly string[];
  /** Record ids the rule's `where` left out, in source order. */
  readonly outOfScope: readonly string[];
}

/** What {@link checkQuality} found, ready for the CLI to print. */
export interface QualityReport {
  /** Findings in config order, then source order, then field order. */
  readonly findings: readonly QualityFinding[];
  /** One entry per rule that reads a loaded collection. */
  readonly scopes: readonly QualityScope[];
  /** Problems reading the config, the collections, the baseline, or a rule. */
  readonly diagnostics: readonly Diagnostic[];
  /** The baseline file `--write` wrote, when it wrote one. */
  readonly wrote?: string;
}

/** Options of {@link checkQuality}. */
export interface CheckQualityOptions {
  /** Absolute site root, where `mizzen.yml` and the data sources live. */
  readonly root: string;
  /** The loaded config. */
  readonly config: SiteConfig;
  /** Record the current data as the baseline instead of comparing against it. */
  readonly write?: boolean;
}

/** One scope's record count and field coverage, as {@link BASELINE_FILE} holds them. */
interface BaselineScope {
  readonly count: number;
  /** Percentage of the scope's records holding a value, by field, rounded to two decimals. */
  readonly fields: Readonly<Record<string, number>>;
}

/** What {@link BASELINE_FILE} holds: each collection, by scope key, as the last `--write` saw it. */
interface Baseline {
  readonly version: 1;
  readonly collections: Readonly<Record<string, Readonly<Record<string, BaselineScope>>>>;
}

/** A baseline while {@link checkQuality} builds it. */
interface BaselineDraft {
  readonly version: 1;
  readonly collections: Record<string, Record<string, BaselineScope>>;
}

/** Every top-level field the records hold, in code-point order. */
function fieldsOf(records: readonly DataRecord[]): readonly string[] {
  const fields = new Set<string>();
  for (const record of records) {
    for (const key of Object.keys(record.fields)) fields.add(key);
  }
  return [...fields].sort(compareCodePoint);
}

/** The records a rule's `where` keeps, and those it leaves out. */
function scopeOf(
  collection: Collection,
  where: ReturnType<typeof parseQuery>["where"],
): { readonly checked: readonly DataRecord[]; readonly outOfScope: readonly DataRecord[] } {
  const rows = collection.records.map((record) => ({
    record,
    id: record.id,
    fields: record.fields,
    ...(record.normalizedDates === undefined ? {} : { dates: record.normalizedDates }),
  }));
  const kept = new Set(filterRows(rows, where).map((row) => row.record));
  return {
    checked: collection.records.filter((record) => kept.has(record)),
    outOfScope: collection.records.filter((record) => !kept.has(record)),
  };
}

/** The records a rule's `where` keeps, after reporting a query or reference-date problem. */
function scopeOfRule(
  rule: QualityRule,
  collection: Collection,
  config: SiteConfig,
  diagnostics: Diagnostic[],
): { readonly checked: readonly DataRecord[]; readonly outOfScope: readonly DataRecord[] } {
  const reference = referenceDateOf(rule.collection, config.collections[rule.collection], {}, config.asOf);
  const query = parseQuery(rule.where, undefined, {
    file: "mizzen.yml",
    collection: rule.collection,
    ...(reference.date === undefined ? {} : { reference: reference.date }),
  });
  diagnostics.push(...query.diagnostics);
  if (query.needsReference && reference.error !== undefined) {
    diagnostics.push({ id: "data.reference-date", severity: "error", message: reference.error });
  }
  return scopeOf(collection, query.where);
}

/** The baseline key of a rule's `where`: `*` for every record, else the canonical JSON of the query. */
function scopeKeyOf(where: QualityRule["where"]): string {
  return where === undefined || Object.keys(where).length === 0 ? NO_SCOPE : canonicalJson(where);
}

/** A percentage rounded to two decimals, so equal data always writes equal bytes. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** The percentage of records that hold a value for each field. */
function coverageOf(records: readonly DataRecord[], fields: readonly string[]): Record<string, number> {
  const coverage: Record<string, number> = {};
  for (const field of fields) {
    let present = 0;
    for (const record of records) {
      const found = resolveIn(record.fields, field);
      if (found.found && hasValue(found.value)) present += 1;
    }
    coverage[field] = records.length === 0 ? 0 : round2((present / records.length) * 100);
  }
  return coverage;
}

/** One scope of the baseline, as the current records see it. */
function snapshotOf(records: readonly DataRecord[]): BaselineScope {
  return { count: records.length, fields: coverageOf(records, fieldsOf(records)) };
}

/** One object property, including one named `__proto__`. */
function own<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when `value` is a baseline this version can compare against. */
function isBaseline(value: unknown): value is Baseline {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.collections)) return false;
  for (const scopes of Object.values(value.collections)) {
    if (!isRecord(scopes)) return false;
    for (const scope of Object.values(scopes)) {
      if (!isRecord(scope) || typeof scope.count !== "number" || !Number.isSafeInteger(scope.count) || scope.count < 0) return false;
      if (!isRecord(scope.fields)) return false;
      for (const percent of Object.values(scope.fields)) {
        if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100) return false;
      }
    }
  }
  return true;
}

/** Reads the baseline: a missing file is `undefined` with no diagnostic, a malformed one a diagnostic. */
async function readBaseline(root: string): Promise<{ readonly baseline?: Baseline; readonly diagnostics: readonly Diagnostic[] }> {
  let text: string;
  try {
    text = await readFile(join(root, BASELINE_FILE), "utf8");
  } catch {
    return { diagnostics: [] };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      diagnostics: [{
        id: "data.quality-baseline",
        severity: "error",
        message: `${BASELINE_FILE} is not valid JSON: ${detail}`,
        help: `Fix the file, or run \`mizzen data quality --write\` to write it again.`,
      }],
    };
  }
  if (!isBaseline(value)) {
    return {
      diagnostics: [{
        id: "data.quality-baseline",
        severity: "error",
        message: `${BASELINE_FILE} is not a quality baseline this version reads.`,
        help: `Fix the file, or run \`mizzen data quality --write\` to write it again.`,
      }],
    };
  }
  return { baseline: value, diagnostics: [] };
}

/** Writes the baseline, canonical and ending in one LF, so a rerun writes the same bytes. */
async function writeBaseline(root: string, baseline: Baseline): Promise<void> {
  await writeFile(join(root, BASELINE_FILE), `${canonicalJson(baseline)}\n`);
}

/**
 * Applies every rule to the collections it names. A collection that did not load, a missing `maxDrop`, and a missing
 * baseline entry are diagnostics, never a throw: the other rules still run.
 */
export async function checkQuality(options: CheckQualityOptions): Promise<QualityReport> {
  const { root, config } = options;
  const write = options.write === true;
  const diagnostics: Diagnostic[] = [];
  const findings: QualityFinding[] = [];
  const scopes: QualityScope[] = [];
  const rules = config.quality?.rules ?? [];
  if (rules.length === 0 && !write) return { findings, scopes, diagnostics };

  const loaded = await loadCollections({ root, config });
  diagnostics.push(...loaded.diagnostics);

  const compares = !write && rules.some((rule) => rule.kind !== "completeness");
  const read: { readonly baseline?: Baseline; readonly diagnostics: readonly Diagnostic[] } = compares
    ? await readBaseline(root)
    : { diagnostics: [] };
  diagnostics.push(...read.diagnostics);
  const baseline = read.baseline;
  if (compares && baseline === undefined && read.diagnostics.length === 0) {
    diagnostics.push({
      id: "data.quality-baseline",
      severity: "error",
      message: `The config has coverage or count rules, but ${BASELINE_FILE} is missing.`,
      help: `Run \`mizzen data quality --write\` and commit ${BASELINE_FILE}.`,
    });
  }

  const draft: BaselineDraft = { version: 1, collections: {} };

  for (const rule of rules) {
    const collection = loaded.collections[rule.collection];
    if (collection === undefined) {
      diagnostics.push({
        id: "data.quality-collection",
        severity: "error",
        message: `A quality rule reads collection "${rule.collection}", which the config does not declare or could not load.`,
      });
      continue;
    }

    const { checked, outOfScope } = scopeOfRule(rule, collection, config, diagnostics);
    scopes.push({
      collection: rule.collection,
      kind: rule.kind,
      checked: checked.map((record) => record.id),
      outOfScope: outOfScope.map((record) => record.id),
    });

    if (write) {
      if (rule.kind !== "completeness") {
        const collectionScopes = (draft.collections[rule.collection] ??= {});
        collectionScopes[scopeKeyOf(rule.where)] = snapshotOf(checked);
      }
      continue;
    }

    const severity = config.quality?.policy[rule.kind] ?? "warning";
    if (rule.kind === "completeness") {
      const fields = rule.fields ?? fieldsOf(checked);
      for (const record of checked) {
        for (const field of fields) {
          const found = resolveIn(record.fields, field);
          if (found.found && hasValue(found.value)) continue;
          findings.push({
            id: `data.quality.completeness.${rule.collection}.${record.id}.${field}`,
            kind: rule.kind,
            severity,
            collection: rule.collection,
            record: record.id,
            field,
            message: `Record "${record.id}" of collection "${rule.collection}" is missing field "${field}".`,
          });
        }
      }
      continue;
    }

    if (rule.maxDrop === undefined) {
      diagnostics.push({
        id: "data.quality-max-drop",
        severity: "error",
        message: `The ${rule.kind} rule for collection "${rule.collection}" needs maxDrop.`,
        help: "Write maxDrop in mizzen.yml: percentage points for coverage, records for count.",
      });
      continue;
    }

    const entry = own(own(baseline?.collections, rule.collection), scopeKeyOf(rule.where));
    if (entry === undefined) {
      if (baseline !== undefined) {
        diagnostics.push({
          id: "data.quality-baseline",
          severity: "error",
          message: `The ${rule.kind} rule for collection "${rule.collection}" has no baseline entry for its scope.`,
          help: `Run \`mizzen data quality --write\` and commit ${BASELINE_FILE}.`,
        });
      }
      continue;
    }
    if (rule.kind === "count") {
      const before = entry.count;
      const after = checked.length;
      const drop = before - after;
      if (drop <= rule.maxDrop) continue;
      findings.push({
        id: `data.quality.count.${rule.collection}`,
        kind: rule.kind,
        severity,
        collection: rule.collection,
        record: "",
        field: "",
        before,
        after,
        drop,
        maxDrop: rule.maxDrop,
        message: `Collection "${rule.collection}" dropped from ${before} to ${after} records (drop ${drop}, maxDrop ${rule.maxDrop}).`,
      });
      continue;
    }

    const current = coverageOf(checked, fieldsOf(checked));
    const fields = rule.fields ?? [...new Set([...Object.keys(entry.fields), ...Object.keys(current)])].sort(compareCodePoint);
    for (const field of fields) {
      const before = own(entry.fields, field);
      // A field the baseline never saw has nothing to drop from; a field the data lost now covers nothing.
      if (before === undefined) continue;
      const after = own(current, field) ?? 0;
      const drop = round2(before - after);
      if (drop <= rule.maxDrop) continue;
      findings.push({
        id: `data.quality.coverage.${rule.collection}.${field}`,
        kind: rule.kind,
        severity,
        collection: rule.collection,
        record: "",
        field,
        before,
        after,
        drop,
        maxDrop: rule.maxDrop,
        message: `Field "${field}" of collection "${rule.collection}" dropped from ${before}% to ${after}% coverage (drop ${drop}, maxDrop ${rule.maxDrop}).`,
      });
    }
  }

  if (write) {
    // Every collection gets a whole-collection entry, even one no coverage rule names.
    for (const name of Object.keys(loaded.collections)) {
      const collectionScopes = (draft.collections[name] ??= {});
      if (collectionScopes[NO_SCOPE] === undefined) collectionScopes[NO_SCOPE] = snapshotOf(loaded.collections[name]!.records);
    }
    await writeBaseline(root, draft);
    return { findings, scopes, diagnostics, wrote: BASELINE_FILE };
  }

  return { findings, scopes, diagnostics };
}
