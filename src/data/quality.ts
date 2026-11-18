/**
 * `mizzen data quality`: the rules in the config, read over the collections the config declares.
 *
 * A rule's `where` is a list page's `where`, applied with the same matcher, so a record outside the rule's scope is
 * reported as out of scope rather than as a finding. Findings are made in config order, then source order, then field
 * order, so two runs print the same lines.
 *
 * shortcut: only completeness runs here; coverage and count land with the rest of the epic.
 */
import type {
  Collection,
  DataRecord,
  Diagnostic,
  QualityRuleKind,
  SiteConfig,
} from "../contracts/index.ts";
import { loadCollections } from "./collections.ts";
import { compareCodePoint, filterRows, hasValue, parseQuery } from "./query.ts";
import { resolveIn } from "./record-context.ts";
import { referenceDateOf } from "./reference-date.ts";

/** One rule that a record fails, or the exception that holds it back. */
export interface QualityFinding {
  /** Stable id, such as `data.quality.completeness.items.a.author`. */
  readonly id: string;
  /** The rule's kind. */
  readonly kind: QualityRuleKind;
  /** How the config's policy reports it. */
  readonly severity: "warning" | "error";
  readonly collection: string;
  readonly record: string;
  readonly field: string;
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
  /** Problems reading the config, the collections, or a rule. */
  readonly diagnostics: readonly Diagnostic[];
}

/** Options of {@link checkQuality}. */
export interface CheckQualityOptions {
  /** Absolute site root, where `mizzen.yml` and the data sources live. */
  readonly root: string;
  /** The loaded config. */
  readonly config: SiteConfig;
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

/**
 * Applies every completeness rule to the collections it names. A collection that did not load is a diagnostic, never
 * a throw: the other rules still run.
 */
export async function checkQuality(options: CheckQualityOptions): Promise<QualityReport> {
  const { root, config } = options;
  const diagnostics: Diagnostic[] = [];
  const findings: QualityFinding[] = [];
  const scopes: QualityScope[] = [];
  const rules = config.quality?.rules ?? [];
  if (rules.length === 0) return { findings, scopes, diagnostics };

  const loaded = await loadCollections({ root, config });
  diagnostics.push(...loaded.diagnostics);

  for (const rule of rules) {
    if (rule.kind !== "completeness") continue;
    const collection = loaded.collections[rule.collection];
    if (collection === undefined) {
      diagnostics.push({
        id: "data.quality-collection",
        severity: "error",
        message: `A quality rule reads collection "${rule.collection}", which the config does not declare or could not load.`,
      });
      continue;
    }

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

    const { checked, outOfScope } = scopeOf(collection, query.where);
    const fields = rule.fields ?? fieldsOf(checked);
    const severity = config.quality?.policy[rule.kind] ?? "warning";
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
    scopes.push({
      collection: rule.collection,
      kind: rule.kind,
      checked: checked.map((record) => record.id),
      outOfScope: outOfScope.map((record) => record.id),
    });
  }

  return { findings, scopes, diagnostics };
}
