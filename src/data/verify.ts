/**
 * `mizzen data verify`: compares what `mizzen.lock.json` records with the data as it is now, and changes nothing.
 *
 * - A package collection's installed file is hashed and compared with the lock's entry.
 * - A URL collection's stored bytes are hashed and compared with the lock's entry (no network is touched; `mizzen data
 *   fetch --check` compares with the live URL).
 * - A file collection with a git snapshot is compared, record by record, with the file at the recorded commit; the first
 *   differing record is named with its position in the data file.
 *
 * A file collection with no snapshot has nothing recorded and is skipped, not failed.
 */
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "../config/load.ts";
import type { DataRecord, Diagnostic } from "../contracts/index.ts";
import { readText } from "./collections.ts";
import { canonicalJson, readLock, sha256, storedPath } from "./lock.ts";
import { resolveNpmSource } from "./package-source.ts";

/** What {@link verifyData} found. */
export interface VerifyDataResult {
  /** 0 when every recorded collection matches, 1 on any difference, 2 for a usage problem. */
  readonly code: number;
  /** One line per collection. */
  readonly messages: readonly string[];
  /** One line per difference. */
  readonly errors: readonly string[];
}

/** The first record that differs between a recorded and a current read, named with its source position. */
export function firstDifference(recorded: readonly DataRecord[], current: readonly DataRecord[]): string | undefined {
  const before = new Map(recorded.map((record) => [record.id, record]));
  for (const record of current) {
    const old = before.get(record.id);
    const at = `${record.position.file}:${record.position.startLine}:${record.position.startColumn}`;
    if (old === undefined) return `record "${record.id}" was added at ${at}`;
    if (canonicalJson(old.fields) !== canonicalJson(record.fields)) return `record "${record.id}" changed at ${at}`;
  }
  const now = new Set(current.map((record) => record.id));
  for (const record of recorded) {
    if (!now.has(record.id)) {
      return `record "${record.id}" was removed; it was at ${record.position.file}:${record.position.startLine}:${record.position.startColumn}`;
    }
  }
  return undefined;
}

function git(root: string, args: readonly string[]): string | undefined {
  try {
    return execFileSync("git", [...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 });
  } catch {
    return undefined;
  }
}

/** Verifies every collection the config declares against the lock. */
export async function verifyData(options: { readonly root: string }): Promise<VerifyDataResult> {
  const { root } = options;
  const messages: string[] = [];
  const errors: string[] = [];
  const loaded = loadConfig(root);
  for (const diagnostic of loaded.diagnostics) {
    if (diagnostic.severity === "error") errors.push(diagnostic.message);
  }
  const pinned = await readLock(root);
  for (const diagnostic of pinned.diagnostics) {
    if (diagnostic.severity === "error") errors.push(diagnostic.message);
  }
  if (errors.length > 0) return { code: 1, messages, errors };

  const lock = pinned.lock;
  const names = Object.keys(loaded.config.collections).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const name of names) {
    const entry = loaded.config.collections[name]!;
    const source = entry.source;
    const before = errors.length;

    if (source.startsWith("npm:") || source.startsWith("https://")) {
      const locked = lock.sources[source];
      if (locked === undefined) {
        errors.push(`${name}: "${source}" has no entry in mizzen.lock.json; run \`mizzen data fetch\`.`);
      } else {
        let bytes: Uint8Array | undefined;
        if (source.startsWith("npm:")) {
          const resolved = await resolveNpmSource(root, source);
          bytes = resolved.source === undefined ? undefined : await readFile(resolved.source.file).catch(() => undefined);
          if (resolved.source !== undefined && locked.version !== undefined && resolved.source.version !== locked.version) {
            errors.push(`${name}: installed version ${resolved.source.version} differs from the locked ${locked.version}.`);
          }
        } else {
          bytes = await readFile(storedPath(root, locked.sha256)).catch(() => undefined);
        }
        if (bytes === undefined) errors.push(`${name}: the data of "${source}" cannot be read.`);
        else if (sha256(bytes) !== locked.sha256) errors.push(`${name}: the content hash of "${source}" differs from the lock (${sha256(bytes).slice(0, 12)} now, ${locked.sha256.slice(0, 12)} locked).`);
      }
    } else {
      const snapshot = lock.snapshots?.[name];
      if (snapshot === undefined || snapshot.tool !== "git" || snapshot.ref === undefined) {
        messages.push(`skipped ${name}: no git snapshot in the lock`);
        continue;
      }
      const recordedText = git(root, ["show", `${snapshot.ref}:./${source}`]);
      if (recordedText === undefined) {
        errors.push(`${name}: cannot read ${source} at ${snapshot.ref}; is the commit in this repository?`);
        continue;
      }
      const currentText = await readFile(resolve(root, source), "utf8").catch(() => undefined);
      if (currentText === undefined) {
        errors.push(`${name}: ${source} was removed; the lock records it at ${snapshot.ref}.`);
        continue;
      }
      const scratch: Diagnostic[] = [];
      const idField = entry.id ?? "id";
      const recorded = readText(name, source, source, recordedText, idField, scratch);
      const current = readText(name, source, source, currentText, idField, scratch);
      if (recorded === undefined || current === undefined) {
        errors.push(`${name}: ${source} cannot be read as records${scratch[0] === undefined ? "" : `: ${scratch[0].message}`}`);
        continue;
      }
      const difference = firstDifference(recorded, current);
      if (difference !== undefined) errors.push(`${name}: ${difference}, not as recorded at ${snapshot.ref}.`);
    }
    if (errors.length === before) messages.push(`ok ${name}`);
  }
  return { code: errors.length > 0 ? 1 : 0, messages, errors };
}
