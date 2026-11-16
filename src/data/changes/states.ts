/**
 * Reads an earlier state of a collection: from a git ref, from a folder that holds an earlier copy of the data, or by
 * replaying the history file. The text goes through the same loaders as the build (`readText`), so CSV, YAML, and JSON
 * all work. Only the local repository is read; no git host is called. A ref or file that is not there is reported, never
 * thrown.
 */
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Diagnostic } from "../../contracts/index.ts";
import { readText } from "../collections.ts";
import type { ComparedRecord } from "./compare.ts";

/** An earlier state, or the problem that stopped it from being read. */
export type StateResult =
  | { readonly ok: true; readonly records: readonly ComparedRecord[] }
  | { readonly ok: false; readonly message: string };

/** What a state read needs to know about the collection. */
export interface StateTarget {
  /** The collection's name. */
  readonly name: string;
  /** The collection's `source`, a path relative to the site root. */
  readonly source: string;
  /** The field that holds the record id. Default `id`. */
  readonly id?: string;
}

function git(root: string, args: readonly string[]): string | undefined {
  try {
    return execFileSync("git", [...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 });
  } catch {
    return undefined;
  }
}

function parse(target: StateTarget, display: string, text: string): StateResult {
  const scratch: Diagnostic[] = [];
  const records = readText(target.name, target.source, display, text, target.id ?? "id", scratch);
  if (records === undefined) {
    return { ok: false, message: `${display} cannot be read as records${scratch[0] === undefined ? "" : `: ${scratch[0].message}`}` };
  }
  return { ok: true, records: records.map((record) => ({ id: record.id, fields: record.fields })) };
}

/** The collection's data at a git ref of the repository that holds `root`. */
export function stateAtRef(root: string, target: StateTarget, ref: string): StateResult {
  if (ref === "" || ref.startsWith("-")) return { ok: false, message: `"${ref}" is not a git ref.` };
  if (git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]) === undefined) {
    return { ok: false, message: `The git ref "${ref}" does not exist in this repository.` };
  }
  const text = git(root, ["show", `${ref}:./${target.source}`]);
  if (text === undefined) return { ok: false, message: `${target.source} does not exist at ${ref}.` };
  return parse(target, `${target.source} at ${ref}`, text);
}

/** The collection's data in a folder that holds an earlier copy of the site's data, at the same relative path. */
export async function stateInFolder(root: string, target: StateTarget, folder: string): Promise<StateResult> {
  const path = resolve(root, folder, target.source);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return { ok: false, message: `${path} does not exist.` };
  }
  return parse(target, path, text);
}

/** The part of a history event that rebuilding a state reads. */
export interface ReplayedEvent {
  readonly type: string;
  readonly record: string;
  readonly field?: string;
  readonly new?: unknown;
  readonly from?: string;
  readonly fields?: Readonly<Record<string, unknown>>;
}

/**
 * The state the history describes: `base` (the data an `imported` event summarizes, or nothing) with every event applied
 * in order. Only the fields the events carry exist in the result, which is why a comparison with it is over tracked
 * fields.
 */
export function replayHistory(base: readonly ComparedRecord[], events: readonly ReplayedEvent[]): readonly ComparedRecord[] {
  const state = new Map<string, Record<string, unknown>>(base.map((record) => [record.id, { ...record.fields }]));
  for (const event of events) {
    if (event.type === "added") state.set(event.record, { ...(event.fields ?? {}) });
    else if (event.type === "removed") state.delete(event.record);
    else if (event.type === "renamed" && event.from !== undefined) {
      const fields = state.get(event.from) ?? {};
      state.delete(event.from);
      state.set(event.record, fields);
    } else if (event.type === "changed" && event.field !== undefined) {
      const fields = state.get(event.record) ?? {};
      if (event.new === undefined) delete fields[event.field];
      else fields[event.field] = event.new;
      state.set(event.record, fields);
    }
  }
  return [...state].map(([id, fields]) => ({ id, fields }));
}
