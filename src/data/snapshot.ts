/**
 * The snapshot record: where a collection's data was recorded from, at which commit or version, and when. It lives in
 * `mizzen.lock.json` under `snapshots.<collection>`, so a build reads it and never computes it.
 *
 * `capturedAt` comes from the data (a commit's date, a response's `Last-Modified`), never from the build clock: it is
 * a `YYYY-MM-DD` date or a UTC instant to the second (`YYYY-MM-DDTHH:MM:SSZ`). A millisecond instant, which is what a
 * clock reading looks like, is refused. Entries are written in a fixed field order.
 */
import type { CollectionSnapshot } from "../contracts/data.ts";

export type { CollectionSnapshot };

/** The fields of a snapshot, in the order they are written. */
export const SNAPSHOT_FIELDS = ["source", "ref", "capturedAt", "tool", "toolVersion"] as const;

const DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})Z)?$/;

/** True when `value` is a real calendar date or a UTC instant to the second, and so may be a `capturedAt`. */
export function isCapturedAt(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = DATE.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return false;
  if (match[4] === undefined) return true;
  return Number(match[4]) < 24 && Number(match[5]) < 60 && Number(match[6]) < 60;
}

/** What is wrong with a snapshot entry; empty when it is valid. */
export function snapshotProblems(value: unknown): readonly string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return ["a snapshot must be an object"];
  const entry = value as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of Object.keys(entry)) {
    if (!(SNAPSHOT_FIELDS as readonly string[]).includes(key)) problems.push(`unknown field "${key}"`);
  }
  if (typeof entry["source"] !== "string" || entry["source"] === "") problems.push("`source` is required");
  for (const key of ["ref", "tool", "toolVersion"] as const) {
    if (entry[key] !== undefined && (typeof entry[key] !== "string" || entry[key] === "")) problems.push(`\`${key}\` must be a non-empty string`);
  }
  if (entry["capturedAt"] !== undefined && !isCapturedAt(entry["capturedAt"])) {
    problems.push("`capturedAt` must be a date or a UTC instant to the second, taken from the data and not the build clock");
  }
  return problems;
}

/** The snapshot with its fields in the written order and no absent field. */
export function orderedSnapshot(snapshot: CollectionSnapshot): CollectionSnapshot {
  return {
    source: snapshot.source,
    ...(snapshot.ref === undefined ? {} : { ref: snapshot.ref }),
    ...(snapshot.capturedAt === undefined ? {} : { capturedAt: snapshot.capturedAt }),
    ...(snapshot.tool === undefined ? {} : { tool: snapshot.tool }),
    ...(snapshot.toolVersion === undefined ? {} : { toolVersion: snapshot.toolVersion }),
  };
}
