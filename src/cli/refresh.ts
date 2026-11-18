/**
 * `mizzen data refresh [dir] --collections <a,b> --report <file>`: fetches the selected collection sources, validates
 * the result, and writes one `mizzen-refresh/1` report that a CI job reads to decide whether to open a pull request.
 *
 * A refresh is a proposal, not a publish. The report is written even when a stage fails, the lock is restored to its
 * previous bytes when validation fails, and the only files the command writes are the lock and its private store. The
 * report holds counts, record ids, diagnostics, and stage names; it never holds an environment value or a credential.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonicalJson, LOCK_FILE, readLock, sha256 } from "../data/lock.ts";
import { checkQuality } from "../data/quality.ts";
import type { Diagnostic } from "../contracts/index.ts";
import { loadCollections } from "../data/collections.ts";
import { loadConfig } from "../config/load.ts";
import { dataFetch, type FetchLike } from "./data.ts";

/** The report format version. */
export const REFRESH_SCHEMA = "mizzen-refresh/1";

/** The stage that stopped a failed refresh, or the last stage a successful one ran. */
export type RefreshStage = "config" | "fetch" | "validate" | "quality" | "done";

/** One source the refresh touched, as the lock sees it before and after. */
export interface RefreshSource {
  readonly source: string;
  readonly collections: readonly string[];
  readonly status: "new" | "changed" | "unchanged";
}

/** One collection's record counts and the ids that changed. */
export interface RefreshCollection {
  readonly name: string;
  readonly before: number;
  readonly after: number;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

/** The counts a pull request body shows. */
export interface RefreshTotals {
  readonly before: number;
  readonly after: number;
  readonly added: number;
  readonly removed: number;
  readonly changed: number;
}

/** The JSON document written to `--report` and, with `--json`, to stdout. */
export interface RefreshReport {
  readonly schema: typeof REFRESH_SCHEMA;
  readonly status: "changed" | "unchanged" | "failed";
  readonly stage: RefreshStage;
  /** Selected collection names, in code-point order. */
  readonly collections: readonly string[];
  readonly lock: {
    readonly file: string;
    readonly before: string | null;
    readonly after: string | null;
    /** True when a failed validation restored the previous lock bytes. */
    readonly restored: boolean;
  };
  readonly sources: readonly RefreshSource[];
  readonly changes: {
    readonly collections: readonly RefreshCollection[];
    readonly totals: RefreshTotals;
  };
  readonly validation: {
    readonly diagnostics: readonly {
      readonly id: string;
      readonly severity: string;
      readonly message: string;
      readonly help?: string;
    }[];
    readonly quality: {
      readonly findings: number;
      readonly warnings: number;
      readonly errors: number;
    };
  };
  readonly errors: readonly string[];
}

/** Options of {@link dataRefresh}. */
export interface DataRefreshOptions {
  /** The site root: the folder that holds `mizzen.yml`. */
  readonly root: string;
  /** Collections to fetch. Unset: every collection. */
  readonly collections?: readonly string[];
  /** The JSON report to write. Created with its parent folders. */
  readonly report: string;
  /** The fetcher; defaults to the runtime's global `fetch`. Tests pass one that talks to a local server. */
  readonly fetch?: FetchLike;
}

/** What {@link dataRefresh} did, ready for the CLI to print. */
export interface DataRefreshResult {
  /** 0 for a changed or unchanged result, 1 for a failed stage, 2 for a usage problem. */
  readonly code: number;
  readonly report: RefreshReport;
  readonly messages: readonly string[];
  readonly errors: readonly string[];
}

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `undefined` for missing bytes; the file's hash otherwise. */
function hashOf(bytes: Uint8Array | undefined): string | null {
  return bytes === undefined ? null : sha256(bytes);
}

/** The report's diagnostic list, with the fields a reader needs and none of the source bytes. */
function diagnosticsOf(diagnostics: readonly Diagnostic[]): RefreshReport["validation"]["diagnostics"] {
  return diagnostics.map((diagnostic) => ({
    id: diagnostic.id,
    severity: diagnostic.severity,
    message: diagnostic.message,
    ...(diagnostic.help === undefined ? {} : { help: diagnostic.help }),
  }));
}

/** One collection's record-level comparison. */
function compareCollection(
  name: string,
  before: readonly { readonly id: string; readonly fields: Readonly<Record<string, unknown>> }[],
  after: readonly { readonly id: string; readonly fields: Readonly<Record<string, unknown>> }[],
): RefreshCollection {
  const old = new Map(before.map((record) => [record.id, record]));
  const now = new Map(after.map((record) => [record.id, record]));
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const id of now.keys()) {
    const earlier = old.get(id);
    if (earlier === undefined) added.push(id);
    else if (canonicalJson(earlier.fields) !== canonicalJson(now.get(id)!.fields)) changed.push(id);
  }
  for (const id of old.keys()) if (!now.has(id)) removed.push(id);
  added.sort(byCodePoint);
  removed.sort(byCodePoint);
  changed.sort(byCodePoint);
  return { name, before: before.length, after: after.length, added, removed, changed };
}

/** The totals of every collection's comparison. */
function totalsOf(collections: readonly RefreshCollection[]): RefreshTotals {
  return {
    before: collections.reduce((total, entry) => total + entry.before, 0),
    after: collections.reduce((total, entry) => total + entry.after, 0),
    added: collections.reduce((total, entry) => total + entry.added.length, 0),
    removed: collections.reduce((total, entry) => total + entry.removed.length, 0),
    changed: collections.reduce((total, entry) => total + entry.changed.length, 0),
  };
}

/** The sources the selected collections read, grouped by address. A file source has no lock entry. */
function addressesOf(
  config: { readonly collections: Readonly<Record<string, { readonly source: string }>> },
  names: readonly string[],
): Map<string, string[]> {
  const addresses = new Map<string, string[]>();
  for (const name of names) {
    const source = config.collections[name]!.source;
    if (!/^[a-z][a-z\d+.-]*:/i.test(source)) continue;
    const owners = addresses.get(source) ?? [];
    owners.push(name);
    addresses.set(source, owners);
  }
  return addresses;
}

/** Writes the report, creating its folder. */
async function writeReport(path: string, report: RefreshReport): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
}

/**
 * Refreshes the selected collections and writes the report. Nothing is thrown for a stage failure: the report names
 * the stage, the errors, and the lock it restored, so a CI job can upload it as evidence.
 */
export async function dataRefresh(options: DataRefreshOptions): Promise<DataRefreshResult> {
  const root = options.root;
  const reportPath = options.report;
  const messages: string[] = [];
  const errors: string[] = [];
  const lockPath = join(root, LOCK_FILE);
  const beforeBytes = await readFile(lockPath).catch(() => undefined);
  const beforeHash = hashOf(beforeBytes);
  const beforeLock = await readLock(root);
  let stage: RefreshStage = "config";
  let afterHash = beforeHash;
  let restored = false;
  let names: string[] = [];
  let sources: RefreshSource[] = [];
  let comparisons: RefreshCollection[] = [];
  let validation: RefreshReport["validation"] = {
    diagnostics: [],
    quality: { findings: 0, warnings: 0, errors: 0 },
  };

  const finish = async (status: RefreshReport["status"], code: number): Promise<DataRefreshResult> => {
    const report: RefreshReport = {
      schema: REFRESH_SCHEMA,
      status,
      stage,
      collections: names,
      lock: { file: LOCK_FILE, before: beforeHash, after: afterHash, restored },
      sources,
      changes: { collections: comparisons, totals: totalsOf(comparisons) },
      validation,
      errors,
    };
    await writeReport(reportPath, report);
    messages.push(`wrote ${reportPath}`);
    return { code, report, messages, errors };
  };

  const fail = async (): Promise<DataRefreshResult> => finish("failed", 1);

  const loaded = loadConfig(root);
  const configErrors = loaded.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (configErrors.length > 0) {
    errors.push(...configErrors.map((diagnostic) => diagnostic.message));
    validation = { ...validation, diagnostics: diagnosticsOf(loaded.diagnostics) };
    return fail();
  }
  const config = loaded.config;

  const requested = options.collections;
  if (requested !== undefined) {
    const unknown = requested.filter((name) => config.collections[name] === undefined);
    if (unknown.length > 0) {
      errors.push(...unknown.map((name) => `No collection named "${name}" in mizzen.yml.`));
      return finish("failed", 2);
    }
  }
  names = Object.keys(config.collections)
    .filter((name) => requested === undefined || requested.includes(name))
    .sort(byCodePoint);

  const lockErrors = beforeLock.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (lockErrors.length > 0) {
    errors.push(...lockErrors.map((diagnostic) => diagnostic.message));
    validation = { ...validation, diagnostics: diagnosticsOf(beforeLock.diagnostics) };
    return fail();
  }

  const before = await loadCollections({ root, config });
  const beforeByName = new Map(Object.entries(before.collections));

  stage = "fetch";
  let fetched;
  try {
    fetched = await dataFetch({
      root,
      collections: names,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
    return fail();
  }
  messages.push(...fetched.messages);
  if (fetched.code !== 0) {
    errors.push(...fetched.errors);
    return finish("failed", fetched.code === 2 ? 2 : 1);
  }

  const afterBytes = await readFile(lockPath).catch(() => undefined);
  afterHash = hashOf(afterBytes);
  const afterLock = await readLock(root);
  const after = await loadCollections({ root, config });
  const afterByName = new Map(Object.entries(after.collections));

  const addresses = addressesOf(config, names);
  sources = [...addresses.keys()].sort(byCodePoint).map((source) => {
    const pinned = beforeLock.lock.sources[source];
    const next = afterLock.lock.sources[source];
    const status = pinned === undefined ? "new" : next === undefined || pinned.sha256 !== next.sha256 ? "changed" : "unchanged";
    return { source, collections: (addresses.get(source) ?? []).sort(byCodePoint), status };
  });

  comparisons = names.map((name) =>
    compareCollection(name, beforeByName.get(name)?.records ?? [], afterByName.get(name)?.records ?? []),
  );

  stage = "validate";
  const validationErrors = after.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  validation = { ...validation, diagnostics: diagnosticsOf(after.diagnostics) };
  if (validationErrors.length > 0) {
    errors.push(...validationErrors.map((diagnostic) => diagnostic.message));
  } else {
    stage = "quality";
    const quality = await checkQuality({ root, config });
    validation = {
      diagnostics: diagnosticsOf([...after.diagnostics, ...quality.diagnostics]),
      quality: quality.totals,
    };
    const qualityErrors = quality.findings.filter((finding) => finding.severity === "error");
    const diagnosticErrors = quality.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    errors.push(...qualityErrors.map((finding) => finding.message));
    errors.push(...diagnosticErrors.map((diagnostic) => diagnostic.message));
  }

  if (errors.length > 0) {
    if (beforeBytes === undefined) await rm(lockPath, { force: true });
    else await writeFile(lockPath, beforeBytes);
    restored = true;
    return fail();
  }

  stage = "done";
  const changed = beforeHash !== afterHash || sources.some((source) => source.status !== "unchanged");
  for (const entry of comparisons) {
    messages.push(
      `${entry.name}: ${entry.before} -> ${entry.after} records (${entry.added.length} added, ${entry.removed.length} removed, ${entry.changed.length} changed)`,
    );
  }
  return finish(changed ? "changed" : "unchanged", 0);
}
