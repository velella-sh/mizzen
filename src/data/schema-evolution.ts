/**
 * `mizzen data schema [dir] [--format text|json]`: compares each collection's current schema with the one its snapshot
 * recorded in `mizzen.lock.json`, and writes nothing. A collection whose data has no recorded schema is skipped.
 *
 * Exit 0 is every schema read and compared, 1 is a config, lock, or schema error, and 2 is a usage error.
 */
import { loadConfig } from "../config/load.ts";
import type { Diagnostic, SchemaSnapshot } from "../contracts/index.ts";
import { readLock } from "./lock.ts";
import { compileSchemas } from "./schema.ts";

/** The diagnostic a schema change reports. */
export type SchemaChangeId =
  | "data.schema-required-field-added"
  | "data.schema-optional-field-added"
  | "data.schema-field-removed"
  | "data.schema-field-renamed"
  | "data.schema-type-change"
  | "data.schema-enum-removed";

/** One top-level field the current schema gained or lost since the collection's data was recorded. */
export interface SchemaChange {
  /** Stable identifier, such as `data.schema-required-field-added`. */
  readonly id: SchemaChangeId;
  /** `error` when earlier records may no longer satisfy the schema; `warning` when they still do. */
  readonly severity: "error" | "warning";
  readonly field: string;
  /** `added` when the current schema declares the field and the baseline did not; `removed` when the reverse; `renamed` for a mapped old name. */
  readonly change: "added" | "removed" | "renamed" | "type-changed" | "enum-removed";
  /** What changed, in one sentence, naming the field and both versions. */
  readonly message: string;
  /** The baseline schema's version, as the lock recorded it. */
  readonly baseline: string;
  /** The current schema: its version and the file that declares it. */
  readonly current: { readonly version: string; readonly file: string };
}

/** A collection whose current schema could be compared with a recorded baseline. */
export interface SchemaReport {
  readonly collection: string;
  readonly file: string;
  readonly version: string;
  readonly baseline: string;
  readonly changes: readonly SchemaChange[];
}

/** A collection the command did not compare, and why. */
export interface SchemaSkip {
  readonly collection: string;
  readonly reason: string;
}

/** What {@link dataSchema} found, ready for the CLI to print. */
export interface DataSchemaResult {
  /** 0 when every schema was read and compared, 1 when the config, the lock, or a schema has an error. */
  readonly code: number;
  /** The report in the requested format, ending in a newline. */
  readonly output: string;
  /** Errors, printed to stderr. */
  readonly errors: readonly string[];
}

/**
 * The fields the current schema gained or lost since the baseline, sorted by field name. A `renames` entry keyed by
 * the new name reports its mapped pair as one rename instead of a removal and an addition.
 */
export function compareSchemas(
  current: SchemaSnapshot,
  baseline: SchemaSnapshot,
  renames: Readonly<Record<string, string>> = {},
): readonly SchemaChange[] {
  const changes: SchemaChange[] = [];
  const currentVersion = { version: current.version, file: current.file };
  const versions = `baseline ${short(baseline.version)} -> now ${short(current.version)}`;
  const push = (change: Omit<SchemaChange, "baseline" | "current">): void => {
    changes.push({ ...change, message: `${change.message}; ${versions}`, baseline: baseline.version, current: currentVersion });
  };
  /** The baseline name each new name replaces, for a pair that only the rename explains. */
  const renamedFrom = new Map<string, string>();
  for (const [now, was] of Object.entries(renames)) {
    if (baseline.fields[was] !== undefined && baseline.fields[now] === undefined && current.fields[now] !== undefined) renamedFrom.set(now, was);
  }
  const renamedOld = new Set(renamedFrom.values());
  const fields = [...new Set([...Object.keys(baseline.fields), ...Object.keys(current.fields)])].sort();
  for (const field of fields) {
    const was = baseline.fields[field];
    const now = current.fields[field];
    if (was === undefined && now !== undefined) {
      const old = renamedFrom.get(field);
      if (old !== undefined) {
        push({ id: "data.schema-field-renamed", severity: "warning", field, change: "renamed", message: `field \`${old}\` was renamed to \`${field}\`` });
      } else if (now.required) {
        push({ id: "data.schema-required-field-added", severity: "error", field, change: "added", message: `field \`${field}\` is required, and earlier records lack it` });
      } else {
        push({ id: "data.schema-optional-field-added", severity: "warning", field, change: "added", message: `field \`${field}\` was added as optional` });
      }
    } else if (was !== undefined && now === undefined) {
      if (!renamedOld.has(field)) push({ id: "data.schema-field-removed", severity: "warning", field, change: "removed", message: `field \`${field}\` was removed` });
    } else if (was !== undefined && now !== undefined) {
      if (was.type !== undefined && now.type !== undefined && was.type !== now.type) {
        push({
          id: "data.schema-type-change",
          severity: "error",
          field,
          change: "type-changed",
          message: `field \`${field}\` changed type from \`${was.type}\` to \`${now.type}\``,
        });
      }
      if (was.enum !== undefined && now.enum !== undefined) {
        const kept = new Set(now.enum.map(stableKey));
        const removed = was.enum.filter((value) => !kept.has(stableKey(value))).sort((a, b) => (stableKey(a) < stableKey(b) ? -1 : stableKey(a) > stableKey(b) ? 1 : 0));
        for (const value of removed) {
          push({ id: "data.schema-enum-removed", severity: "error", field, change: "enum-removed", message: `field \`${field}\` no longer accepts ${stableKey(value)}` });
        }
      }
    }
  }
  return changes;
}

/** A schema version short enough for one line of text; the JSON report carries the whole hash. */
function short(version: string): string {
  return version.slice(0, 12);
}

/** An enum value as comparable, printable text. */
function stableKey(value: unknown): string {
  return JSON.stringify(value) ?? "";
}

/** Compares every collection's schema with the one its snapshot recorded. */
export async function dataSchema(options: { readonly root: string; readonly format: "text" | "json" }): Promise<DataSchemaResult> {
  const loaded = loadConfig(options.root);
  const pinned = await readLock(options.root);
  const scratch: Diagnostic[] = [];
  const compiled = compileSchemas(options.root, loaded.config, {}, scratch);
  const errors = [...loaded.diagnostics, ...pinned.diagnostics, ...scratch]
    .filter((finding) => finding.severity === "error")
    .map((finding) => finding.message);

  const reports: SchemaReport[] = [];
  const skipped: SchemaSkip[] = [];
  const names = Object.keys(loaded.config.collections).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const name of names) {
    const schema = compiled.schemas[name];
    const baseline = pinned.lock.snapshots?.[name]?.schema;
    if (baseline === undefined) {
      const reason = compiled.unchecked.includes(name) ? "no schema is declared or recorded" : "no schema is recorded; run `mizzen data snapshot`";
      skipped.push({ collection: name, reason });
      continue;
    }
    if (schema === undefined) {
      skipped.push({ collection: name, reason: "the schema cannot be read" });
      continue;
    }
    reports.push({
      collection: name,
      file: schema.file,
      version: schema.version,
      baseline: baseline.version,
      changes: compareSchemas(schema, baseline, loaded.config.collections[name]?.schemaRenames ?? {}),
    });
  }

  if (options.format === "json") {
    return { code: errors.length === 0 ? 0 : 1, output: `${JSON.stringify({ collections: reports, skipped, errors })}\n`, errors };
  }

  const lines: string[] = [];
  for (const report of reports) {
    if (report.changes.length === 0) {
      lines.push(`ok ${report.collection}: ${report.file} matches baseline ${short(report.baseline)}`);
      continue;
    }
    lines.push(`${report.collection}: ${report.file}, baseline ${short(report.baseline)} -> now ${short(report.version)}`);
    for (const change of report.changes) lines.push(`  ${change.severity} ${change.id}: ${change.message}`);
  }
  for (const skip of skipped) lines.push(`skipped ${skip.collection}: ${skip.reason}`);
  return { code: errors.length === 0 ? 0 : 1, output: lines.length === 0 ? "" : `${lines.join("\n")}\n`, errors };
}
