/**
 * The identity of an archived report run: its own id, the date it ran, the commit it scanned, and the collection
 * snapshot the lock pinned. The fields are read from names the site configures, so a run may be called anything; the
 * record id is used only when no id field is configured.
 *
 * A run id is the address of one archived report. Two records cannot share it, and a record cannot reuse an id the
 * archive already published with different inputs: that would replace the published report without a tracked change.
 * Both cases are reported and the offending run is left out. Nothing here reads the build clock or the network.
 */
import type { Collection, CollectionSnapshot, DataRecord, Diagnostic, RecordPos } from "../../contracts/index.ts";
import { sourcePosOf } from "../positions.ts";

/** The fields a run record names its identity in. */
export interface RunFields {
  /** Field that holds the run id; the record's id when absent. */
  readonly id?: string;
  /** Field that holds the date the run is for. Default `date`. */
  readonly date?: string;
  /** Field that holds the commit the run scanned. Default `commit`. */
  readonly commit?: string;
}

/** One run the archive can identify. */
export interface ArchivedRun {
  /** The run id: the address of its archived report. */
  readonly id: string;
  /** The date the run is for, as the source writes it. */
  readonly date: string;
  /** The commit the run scanned. */
  readonly commit: string;
  /** The collection snapshot the lock held when the run was identified; absent when the lock holds none. */
  readonly inputs?: CollectionSnapshot;
}

/** Options of {@link identifyRuns}. */
export interface RunIndexOptions {
  /** The field names the records use. */
  readonly fields?: RunFields;
  /**
   * Runs the archive already published. A current run that keeps one of their ids must keep its date and commit too;
   * the collection snapshot is current for every run, so it is not part of that comparison.
   */
  readonly published?: readonly ArchivedRun[];
}

/** What {@link identifyRuns} found. */
export interface RunIndexResult {
  /** The runs that can be archived, in source order; a repeated id or an overwrite is left out. */
  readonly runs: readonly ArchivedRun[];
  /** The repeated ids and untracked overwrites, in source order. */
  readonly diagnostics: readonly Diagnostic[];
}

/** A non-empty string field, or `undefined`. */
function valueOf(record: DataRecord, field: string): string | undefined {
  const value = record.fields[field];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** `file:line:column` of a position, for a message that names an earlier record. */
function where(pos: RecordPos): string {
  return `${pos.file}:${pos.startLine}:${pos.startColumn}`;
}

/**
 * Reads every record of `collection` as a run. A record without an id, a date, or a commit is `data.report-run-invalid`;
 * an id used twice is `data.report-run-duplicate-id`; and an id published with other inputs is
 * `data.report-run-untracked-overwrite`.
 */
export function identifyRuns(collection: Collection, options: RunIndexOptions = {}): RunIndexResult {
  const fields = options.fields ?? {};
  const dateField = fields.date ?? "date";
  const commitField = fields.commit ?? "commit";
  const published = new Map<string, ArchivedRun>();
  for (const run of options.published ?? []) if (!published.has(run.id)) published.set(run.id, run);

  const runs: ArchivedRun[] = [];
  const diagnostics: Diagnostic[] = [];
  const seen = new Map<string, DataRecord>();

  for (const record of collection.records) {
    const id = fields.id === undefined ? (record.id === "" ? undefined : record.id) : valueOf(record, fields.id);
    const date = valueOf(record, dateField);
    const commit = valueOf(record, commitField);
    if (id === undefined || date === undefined || commit === undefined) {
      const missing = [
        ...(id === undefined ? [fields.id === undefined ? "run id" : `\`${fields.id}\``] : []),
        ...(date === undefined ? [`\`${dateField}\``] : []),
        ...(commit === undefined ? [`\`${commitField}\``] : []),
      ];
      diagnostics.push({
        id: "data.report-run-invalid",
        severity: "error",
        message: `Record "${record.id}" of "${collection.name}" has no ${missing.join(" or ")}; a run needs an id, a date, and the commit it scanned.`,
        pos: sourcePosOf(record.position),
        help: "Give every run an id, a date, and the commit it scanned.",
      });
      continue;
    }

    const earlier = seen.get(id);
    if (earlier !== undefined) {
      diagnostics.push({
        id: "data.report-run-duplicate-id",
        severity: "error",
        message: `Record "${record.id}" of "${collection.name}" repeats run id "${id}", first used at ${where(earlier.position)} (${where(record.position)}).`,
        pos: sourcePosOf(record.position),
        help: "Give each run its own id.",
      });
      continue;
    }
    seen.set(id, record);

    const old = published.get(id);
    if (old !== undefined && (old.date !== date || old.commit !== commit)) {
      diagnostics.push({
        id: "data.report-run-untracked-overwrite",
        severity: "error",
        message: `Run "${id}" of "${collection.name}" was published for ${old.date} at ${old.commit}, but the source now pins ${date} at ${commit}; its archived report would change without a tracked run.`,
        pos: sourcePosOf(record.position),
        help: "Publish the changed inputs under a new run id, or restore the published run.",
      });
      continue;
    }

    runs.push({
      id,
      date,
      commit,
      ...(collection.snapshot === undefined ? {} : { inputs: collection.snapshot }),
    });
  }

  return { runs, diagnostics };
}
