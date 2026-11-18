/**
 * `mizzen data transform-diff`: runs the transformation rules of two configurations over the same locked input and
 * reports what the records and their published outputs would become.
 *
 * Both configurations are read from the site root and hashed, so a report names exactly the files it compared. The
 * collection's input is hashed too, from the same bytes a build reads (a local file or the lock's pinned hash): two
 * rule versions over different bytes are not a comparison, and the command refuses with a clear target error rather
 * than showing a change the rules did not make.
 *
 * Records are aligned by id and reported as added, removed, or changed. A field's state is explicit: absent means the
 * field is missing, a present null is a null, and a change between two types carries both. Each changed field names
 * the transformation steps that last wrote it on each side, or says that no step did. Transform and validation
 * failures keep their side and stage, and make the whole result incomplete.
 *
 * The published outputs are the ones the 0.2.4 dependency graph names for the changed records. The graph is built
 * from the site's current `mizzen.yml`, the configuration a build would use; building it writes nothing.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "../config/load.ts";
import type { CollectionConfig, SiteConfig } from "../contracts/config.ts";
import type { Diagnostic } from "../contracts/index.ts";
import { buildModel } from "../model/build.ts";
import {
  buildDependencyGraph,
  explainAffectedOutputs,
  recordNodeId,
} from "../pipeline/dependency-graph.ts";
import { loadCollections } from "./collections.ts";
import { canonicalJson, readLock, sha256 } from "./lock.ts";
import type { TransformEvent } from "./transform.ts";

/** Which configuration a record, field attribution, or failure came from. */
export type RuleSide = "baseline" | "proposed";

/** The JSON shape of a field, with `missing` kept apart from `null`. */
export type FieldType = "missing" | "null" | "boolean" | "number" | "string" | "array" | "object";

/** One present field value and its type. A missing field has no {@link FieldValue} at all. */
export interface FieldValue {
  readonly type: Exclude<FieldType, "missing">;
  readonly value: unknown;
}

/** A transformation step that wrote a field on one side. */
export interface RuleRef {
  readonly side: RuleSide;
  readonly rule: string;
  readonly op: string;
}

/** One field whose value, presence, or type differs between the two rule versions. */
export interface FieldDelta {
  /** Dot path from the record's top level. */
  readonly path: string;
  /** Whether the field appeared, disappeared, or kept a path with a different value. */
  readonly change: "added" | "removed" | "changed";
  /** The value the baseline wrote; absent when the field is missing there. */
  readonly before?: FieldValue;
  /** The value the proposal writes; absent when the field is missing there. */
  readonly after?: FieldValue;
  /** True when both sides hold a value and their types differ. */
  readonly typeChange: boolean;
  /** The steps that last wrote the field on each side, in baseline-then-proposed order. */
  readonly rules: readonly RuleRef[];
  /** Why no step could be named; present only when {@link rules} is empty. */
  readonly unknown?: string;
}

/** One record that the two rule versions align on, or that only one side produces. */
export interface RecordDelta {
  readonly id: string;
  readonly change: "added" | "removed" | "changed";
  /** Changed fields sorted by path; empty for an added or removed record. */
  readonly fields: readonly FieldDelta[];
}

/** Where a side's transformation or validation failed. */
export interface RuleFailure {
  readonly side: RuleSide;
  readonly stage: "transform" | "validation-input" | "validation-output";
  /** The diagnostic id, such as `data.transform-unit`. */
  readonly id: string;
  readonly message: string;
  /** The step named by the diagnostic, when it names one. */
  readonly rule?: string;
}

/** One published output the changed records reach. */
export interface AffectedOutput {
  /** The output's URL or path. */
  readonly path: string;
  readonly role: "page" | "list" | "feed" | "api";
  /** Ids of the changed records that reach this output, sorted. */
  readonly records: readonly string[];
  /** True when the dependency graph is incomplete and cannot name a reason. */
  readonly unknown?: true;
}

/** The two configurations and the input they share. */
export interface RuleDiffReport {
  readonly baseline: { readonly path: string; readonly sha256: string };
  readonly proposed: { readonly path: string; readonly sha256: string };
  readonly collection: string;
  readonly input: {
    readonly baselineSource: string;
    readonly proposedSource: string;
    readonly sha256: string;
  };
  /** False when either side reported a transformation or validation failure. */
  readonly complete: boolean;
  readonly counts: {
    readonly added: number;
    readonly removed: number;
    readonly changed: number;
    readonly fields: number;
    readonly outputs: number;
  };
  /** Added, removed, and changed records in id order. */
  readonly records: readonly RecordDelta[];
  /** Failures from both sides, baseline first, then in the order the loader made them. */
  readonly failures: readonly RuleFailure[];
  /** Outputs the changed records reach, in path order. */
  readonly affected: readonly AffectedOutput[];
  /** Why the affected outputs could not be read, when the site model failed. */
  readonly impactError?: string;
}

/** Options of {@link diffRuleVersions}. */
export interface RuleDiffOptions {
  /** The site root: the folder that holds `mizzen.yml`, the lock file, and `node_modules`. */
  readonly root: string;
  /** The baseline config path, relative to the root. */
  readonly baseline: string;
  /** The proposed config path, relative to the root. */
  readonly proposed: string;
  /** The collection to compare; required when both configs declare more than one with rules. */
  readonly collection?: string;
  /** Print JSON instead of text. */
  readonly format?: "text" | "json";
  /** Compare without changing the exit code for a difference: 0 unchanged, 1 changed, 2 failed. */
  readonly check?: boolean;
}

/** What {@link diffRuleVersions} produced. */
export interface RuleDiffResult {
  /** 0 unchanged (or compared without `--check`), 1 changed under `--check`, 2 an invalid target or failure. */
  readonly code: number;
  /** The text or JSON report; empty when the target is invalid. */
  readonly output: string;
  /** Target errors and failures to print on stderr. */
  readonly errors: readonly string[];
  /** The structured report, when a comparison ran. */
  readonly report?: RuleDiffReport;
}

/** Text order by code point, so a report is the same whatever the host locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** True for a plain mapping, not an array or a scalar. */
function isMapping(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The type of a present value. */
function typeOf(value: unknown): Exclude<FieldType, "missing"> {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (isMapping(value)) return "object";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (typeof value === "string") return "string";
  return "string";
}

/** The value at a key, and whether the field is present; `undefined` is treated as absent. */
function fieldOf(fields: Readonly<Record<string, unknown>>, key: string): FieldValue | undefined {
  if (!Object.hasOwn(fields, key)) return undefined;
  const value = fields[key];
  if (value === undefined) return undefined;
  return { type: typeOf(value), value };
}

/** The last step that wrote `path` on one side, or `undefined`. */
function lastRuleOf(events: readonly TransformEvent[], path: string): TransformEvent | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event.path === path || event.target === path) return event;
  }
  return undefined;
}

/** The steps that explain a changed field, or the reason none does. */
function attributionOf(
  path: string,
  baseline: readonly TransformEvent[],
  proposed: readonly TransformEvent[],
): Pick<FieldDelta, "rules" | "unknown"> {
  const rules: RuleRef[] = [];
  for (const [side, events] of [["baseline", baseline], ["proposed", proposed]] as const) {
    const event = lastRuleOf(events, path);
    if (event !== undefined) rules.push({ side, rule: event.rule, op: event.op });
  }
  // shortcut: only transform events are attributed; dates, derived fields, and validation changes name no step.
  if (rules.length === 0) {
    return { rules, unknown: "no transformation step wrote this field; dates, derived fields, or validation may have changed it" };
  }
  return { rules };
}

/** Emits one delta for each field path whose presence, value, or type differs. */
function fieldDeltas(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
  events: { readonly baseline: readonly TransformEvent[]; readonly proposed: readonly TransformEvent[] },
): FieldDelta[] {
  const deltas: FieldDelta[] = [];
  const walk = (left: Readonly<Record<string, unknown>>, right: Readonly<Record<string, unknown>>, prefix: string): void => {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort(byCodePoint);
    for (const key of keys) {
      const path = prefix === "" ? key : `${prefix}.${key}`;
      const was = fieldOf(left, key);
      const now = fieldOf(right, key);
      if (was === undefined) {
        if (now === undefined) continue;
        deltas.push({ path, change: "added", after: now, typeChange: false, ...attributionOf(path, events.baseline, events.proposed) });
        continue;
      }
      if (now === undefined) {
        deltas.push({ path, change: "removed", before: was, typeChange: false, ...attributionOf(path, events.baseline, events.proposed) });
        continue;
      }
      if (isMapping(was.value) && isMapping(now.value)) {
        walk(was.value, now.value, path);
        continue;
      }
      if (canonicalJson(was.value) === canonicalJson(now.value)) continue;
      deltas.push({
        path,
        change: "changed",
        before: was,
        after: now,
        typeChange: was.type !== now.type,
        ...attributionOf(path, events.baseline, events.proposed),
      });
    }
  };
  walk(before, after, "");
  return deltas;
}

/** Keeps the first record for each id, so a duplicate id cannot make the report depend on map insertion. */
function byId(records: readonly { readonly id: string; readonly fields: Readonly<Record<string, unknown>> }[]): Map<string, { readonly id: string; readonly fields: Readonly<Record<string, unknown>> }> {
  const found = new Map<string, { readonly id: string; readonly fields: Readonly<Record<string, unknown>> }>();
  for (const record of records) if (!found.has(record.id)) found.set(record.id, record);
  return found;
}

/** The id order of every record either side produced. */
function alignedIds(baseline: Map<string, unknown>, proposed: Map<string, unknown>): string[] {
  return [...new Set([...baseline.keys(), ...proposed.keys()])].sort(byCodePoint);
}

/** The stage a diagnostic belongs to, or `undefined` when it is not a transformation or validation failure. */
function stageOf(id: string): RuleFailure["stage"] | undefined {
  if (id.startsWith("data.record-invalid-input")) return "validation-input";
  if (id.startsWith("data.record-invalid-output")) return "validation-output";
  if (/^data\.transform-/u.test(id)) return "transform";
  return undefined;
}

/** The step a diagnostic message names, when it names one. */
function ruleOf(diagnostic: Diagnostic, stage: RuleFailure["stage"]): string | undefined {
  const step = /^Step "([^"]+)"/u.exec(diagnostic.message);
  if (step !== null) return step[1];
  if (stage !== "validation-output") return undefined;
  return / after step "([^"]+)"/u.exec(diagnostic.message)?.[1];
}

/** The failures of one side, in the order the loader made them. */
function failuresOf(side: RuleSide, diagnostics: readonly Diagnostic[]): RuleFailure[] {
  const failures: RuleFailure[] = [];
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity !== "error") continue;
    const stage = stageOf(diagnostic.id);
    if (stage === undefined) continue;
    const rule = ruleOf(diagnostic, stage);
    failures.push({ side, stage, id: diagnostic.id, message: diagnostic.message, ...(rule === undefined ? {} : { rule }) });
  }
  return failures;
}

/** A configuration loaded from `path`, with its bytes hashed. */
interface LoadedConfig {
  readonly path: string;
  readonly sha256: string;
  readonly config: SiteConfig;
}

/** Reads and validates one config; `message` names it as the caller referred to it. */
async function configAt(root: string, path: string, label: "baseline" | "proposed"): Promise<{ readonly loaded?: LoadedConfig; readonly error?: string }> {
  let text: string;
  try {
    text = await readFile(resolve(root, path), "utf8");
  } catch (err) {
    return { error: `${label} config "${path}" cannot be read: ${err instanceof Error ? err.message : String(err)}` };
  }
  const { config, diagnostics } = loadConfig(root, { path });
  const broken = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (broken.length > 0) {
    return { error: `${label} config "${path}" is invalid: ${broken.map((diagnostic) => diagnostic.message).join("; ")}` };
  }
  return { loaded: { path, sha256: sha256(text), config } };
}

/** The input hash of a collection's source: its local bytes, or the lock's pinned hash for a remote or package source. */
async function inputHash(root: string, entry: CollectionConfig): Promise<{ readonly sha256: string; readonly error?: string }> {
  if (!/^[a-z][a-z\d+.-]*:/i.test(entry.source)) {
    try {
      return { sha256: sha256(await readFile(resolve(root, entry.source))) };
    } catch (err) {
      return { sha256: "", error: `input "${entry.source}" cannot be read: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  const { lock, diagnostics } = await readLock(root);
  const invalid = diagnostics.find((diagnostic) => diagnostic.severity === "error");
  if (invalid !== undefined) return { sha256: "", error: invalid.message };
  const pinned = lock.sources[entry.source];
  if (pinned === undefined) {
    return { sha256: "", error: `input "${entry.source}" has no entry in mizzen.lock.json; run \`mizzen data fetch\`` };
  }
  return { sha256: pinned.sha256 };
}

/** The collection to compare: the requested name, or the only one both configs give rules. */
function chooseCollection(baseline: SiteConfig, proposed: SiteConfig, requested: string | undefined): { readonly name?: string; readonly error?: string } {
  if (requested !== undefined) {
    if (baseline.collections[requested] === undefined || proposed.collections[requested] === undefined) {
      return { error: `both configurations must declare collection "${requested}"` };
    }
    return { name: requested };
  }
  const names = [...new Set([...Object.keys(baseline.collections), ...Object.keys(proposed.collections)])]
    .filter((name) => {
      const left = baseline.collections[name];
      const right = proposed.collections[name];
      return left !== undefined && right !== undefined && ((left.transform?.steps.length ?? 0) > 0 || (right.transform?.steps.length ?? 0) > 0);
    })
    .sort(byCodePoint);
  if (names.length === 1) return { name: names[0]! };
  if (names.length === 0) return { error: "both configurations declare no collection with transformation rules" };
  return { error: `both configurations declare more than one collection with rules; name one with --collection: ${names.join(", ")}` };
}

/** The affected output paths of changed records, from the 0.2.4 dependency graph. */
async function affectedFor(root: string, collection: string, ids: readonly string[]): Promise<{ readonly outputs: readonly AffectedOutput[]; readonly error?: string }> {
  if (ids.length === 0) return { outputs: [] };
  try {
    const model = await buildModel(root);
    const built = await buildDependencyGraph({ root, site: model.site });
    const explained = explainAffectedOutputs(built.graph, ids.map((id) => recordNodeId(collection, id)));
    const prefix = `record:${collection}/`;
    const outputs = explained
      .map((output) => ({
        path: output.path,
        role: output.role,
        records: [...new Set(output.reasons.map((reason) => (reason.record.startsWith(prefix) ? reason.record.slice(prefix.length) : reason.record)))].sort(byCodePoint),
        ...(output.unknown === true ? { unknown: true as const } : {}),
      }))
      .sort((a, b) => byCodePoint(a.path, b.path) || byCodePoint(a.role, b.role));
    return { outputs };
  } catch (err) {
    return { outputs: [], error: `affected outputs unavailable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** A value as the text report prints it. */
function valueText(value: FieldValue | undefined): string {
  if (value === undefined) return "missing";
  if (value.type === "null") return "null";
  const json = JSON.stringify(value.value);
  return json === undefined || json.length > 40 ? value.type : `${value.type} ${json}`;
}

/** The rules that explain a field as one short phrase. */
function ruleText(delta: FieldDelta): string {
  if (delta.rules.length === 0) return `unknown: ${delta.unknown ?? "no step wrote this field"}`;
  return delta.rules.map((rule) => `${rule.side} ${rule.rule} (${rule.op})`).join(", ");
}

/** The report for a terminal. */
function formatText(report: RuleDiffReport): string {
  const lines = [
    `rule diff: ${report.collection}`,
    `baseline ${report.baseline.path} (sha256 ${report.baseline.sha256.slice(0, 12)})`,
    `proposed ${report.proposed.path} (sha256 ${report.proposed.sha256.slice(0, 12)})`,
    `input ${report.input.baselineSource} (sha256 ${report.input.sha256.slice(0, 12)})`,
    `complete: ${report.complete ? "yes" : "no"}`,
    `records: ${report.counts.added} added, ${report.counts.removed} removed, ${report.counts.changed} changed; ` +
      `${report.counts.fields} fields; ${report.counts.outputs} affected outputs`,
  ];
  if (report.records.length === 0) lines.push("", "no record changes");
  for (const record of report.records) {
    lines.push("", `${record.change === "added" ? "+" : record.change === "removed" ? "-" : "~"} ${report.collection}/${record.id}`);
    for (const field of record.fields) {
      const mark = field.change === "added" ? "+" : field.change === "removed" ? "-" : "~";
      lines.push(`  ${mark} ${field.path}: ${valueText(field.before)} -> ${valueText(field.after)} (${ruleText(field)})`);
    }
  }
  if (report.failures.length > 0) {
    lines.push("", "failures:");
    for (const failure of report.failures) {
      const rule = failure.rule === undefined ? "" : ` step "${failure.rule}"`;
      lines.push(`  ${failure.side} ${failure.stage}${rule}: ${failure.message}`);
    }
  }
  if (report.impactError !== undefined) lines.push("", report.impactError);
  else if (report.affected.length > 0) {
    lines.push("", "affected outputs:");
    for (const output of report.affected) {
      const records = output.records.length === 0 ? "" : ` [${output.records.join(", ")}]`;
      lines.push(`  ${output.path} (${output.role})${output.unknown === true ? " unknown" : ""}${records}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** The report as JSON, two-space indented, ending with one line feed. */
export function ruleDiffJson(report: RuleDiffReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/**
 * Runs both configurations over the same input and returns the report. An unreadable or unequal target is a usage
 * error: no comparison runs, so a difference the input caused is never mistaken for one the rules made.
 */
export async function diffRuleVersions(options: RuleDiffOptions): Promise<RuleDiffResult> {
  const loadedBaseline = await configAt(options.root, options.baseline, "baseline");
  if (loadedBaseline.loaded === undefined) return { code: 2, output: "", errors: [loadedBaseline.error!] };
  const loadedProposed = await configAt(options.root, options.proposed, "proposed");
  if (loadedProposed.loaded === undefined) return { code: 2, output: "", errors: [loadedProposed.error!] };
  const baseline = loadedBaseline.loaded;
  const proposed = loadedProposed.loaded;

  const chosen = chooseCollection(baseline.config, proposed.config, options.collection);
  if (chosen.name === undefined) return { code: 2, output: "", errors: [chosen.error!] };
  const name = chosen.name;
  const baselineEntry = baseline.config.collections[name]!;
  const proposedEntry = proposed.config.collections[name]!;

  const [baselineHash, proposedHash] = await Promise.all([
    inputHash(options.root, baselineEntry),
    inputHash(options.root, proposedEntry),
  ]);
  if (baselineHash.error !== undefined) return { code: 2, output: "", errors: [`baseline ${baselineHash.error}`] };
  if (proposedHash.error !== undefined) return { code: 2, output: "", errors: [`proposed ${proposedHash.error}`] };
  if (baselineHash.sha256 !== proposedHash.sha256) {
    return {
      code: 2,
      output: "",
      errors: [
        `baseline reads "${baselineEntry.source}" (sha256 ${baselineHash.sha256.slice(0, 12)}) and proposed reads ` +
          `"${proposedEntry.source}" (sha256 ${proposedHash.sha256.slice(0, 12)}); a comparison needs one input with the same hash`,
      ],
    };
  }

  const baselineEvents: TransformEvent[] = [];
  const proposedEvents: TransformEvent[] = [];
  const narrowed = (config: SiteConfig, entry: CollectionConfig): SiteConfig => ({ ...config, collections: { [name]: entry } });
  const [left, right] = await Promise.all([
    loadCollections({ root: options.root, config: narrowed(baseline.config, baselineEntry), onTransformEvent: (event) => baselineEvents.push(event) }),
    loadCollections({ root: options.root, config: narrowed(proposed.config, proposedEntry), onTransformEvent: (event) => proposedEvents.push(event) }),
  ]);

  const errors: string[] = [];
  if (left.collections[name] === undefined) {
    errors.push(`baseline could not load collection "${name}": ${left.diagnostics.filter((finding) => finding.severity === "error").map((finding) => finding.message).join("; ") || "no records"}`);
  }
  if (right.collections[name] === undefined) {
    errors.push(`proposed could not load collection "${name}": ${right.diagnostics.filter((finding) => finding.severity === "error").map((finding) => finding.message).join("; ") || "no records"}`);
  }
  if (errors.length > 0) return { code: 2, output: "", errors };

  const leftRecords = byId(left.collections[name]!.records);
  const rightRecords = byId(right.collections[name]!.records);
  const records: RecordDelta[] = [];
  const changedIds: string[] = [];
  for (const id of alignedIds(leftRecords, rightRecords)) {
    const was = leftRecords.get(id);
    const now = rightRecords.get(id);
    if (was === undefined) {
      records.push({ id, change: "added", fields: [] });
      changedIds.push(id);
      continue;
    }
    if (now === undefined) {
      records.push({ id, change: "removed", fields: [] });
      changedIds.push(id);
      continue;
    }
    const fields = fieldDeltas(was.fields, now.fields, { baseline: baselineEvents, proposed: proposedEvents });
    if (fields.length === 0) continue;
    records.push({ id, change: "changed", fields });
    changedIds.push(id);
  }

  const failures = [...failuresOf("baseline", left.diagnostics), ...failuresOf("proposed", right.diagnostics)];
  const affected = await affectedFor(options.root, name, changedIds);
  const report: RuleDiffReport = {
    baseline: { path: baseline.path, sha256: baseline.sha256 },
    proposed: { path: proposed.path, sha256: proposed.sha256 },
    collection: name,
    input: { baselineSource: baselineEntry.source, proposedSource: proposedEntry.source, sha256: baselineHash.sha256 },
    complete: failures.length === 0,
    counts: {
      added: records.filter((record) => record.change === "added").length,
      removed: records.filter((record) => record.change === "removed").length,
      changed: records.filter((record) => record.change === "changed").length,
      fields: records.reduce((total, record) => total + record.fields.length, 0),
      outputs: affected.outputs.length,
    },
    records,
    failures,
    affected: affected.outputs,
    ...(affected.error === undefined ? {} : { impactError: affected.error }),
  };

  const changed = records.length > 0;
  const code = failures.length > 0 ? 2 : options.check === true && changed ? 1 : 0;
  return {
    code,
    output: options.format === "json" ? ruleDiffJson(report) : formatText(report),
    errors: failures.map((failure) => `${failure.side} ${failure.stage}: ${failure.message}`),
    report,
  };
}
