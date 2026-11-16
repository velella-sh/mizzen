/**
 * The snapshot record: where a collection's data was recorded from, at which commit or version, and when. It lives in
 * `mizzen.lock.json` under `snapshots.<collection>`, so a build reads it and never computes it.
 *
 * `capturedAt` comes from the data (a commit's date, a response's `Last-Modified`), never from the build clock: it is
 * a `YYYY-MM-DD` date or a UTC instant to the second (`YYYY-MM-DDTHH:MM:SSZ`). A millisecond instant, which is what a
 * clock reading looks like, is refused. Entries are written in a fixed field order.
 */
import { execFileSync } from "node:child_process";
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

/** What {@link gitSnapshot} found. */
export type GitSnapshotResult =
  | { readonly ok: true; readonly snapshot: CollectionSnapshot; readonly dirty: boolean }
  | { readonly ok: false; readonly message: string };

/** Runs `git` in `cwd`; the text it printed, or `undefined` when it failed. The local repository is the only thing read. */
function git(cwd: string, args: readonly string[]): string | undefined {
  try {
    return execFileSync("git", [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return undefined;
  }
}

/** A Unix time in seconds as a UTC instant to the second, `YYYY-MM-DDTHH:MM:SSZ`. */
export function instantOfUnix(seconds: number): string {
  return `${new Date(seconds * 1000).toISOString().slice(0, 19)}Z`;
}

/**
 * Reads the last commit that touched `source` (a path relative to `root`) and its commit date, from the local
 * repository only. The date is the commit's own, so the same commit always gives the same snapshot. A file with
 * uncommitted changes is refused unless `allowDirty` is set; the snapshot then still names the last commit.
 */
export function gitSnapshot(root: string, source: string, allowDirty: boolean): GitSnapshotResult {
  if (git(root, ["rev-parse", "--is-inside-work-tree"])?.trim() !== "true") {
    return { ok: false, message: `${root} is not inside a git repository, so there is no commit to record.` };
  }
  const status = git(root, ["status", "--porcelain", "--", source]);
  if (status === undefined) return { ok: false, message: `Cannot read the git status of ${source}.` };
  const dirty = status.trim() !== "";
  if (dirty && !allowDirty) {
    return { ok: false, message: `${source} has uncommitted changes. Commit them, or pass --allow-dirty to record the last commit anyway.` };
  }
  const log = git(root, ["log", "-1", "--format=%H%n%ct", "--", source])?.trim().split("\n");
  const [commit, seconds] = log ?? [];
  if (commit === undefined || commit === "" || seconds === undefined || !/^\d+$/.test(seconds)) {
    return { ok: false, message: `${source} has no commit yet, so there is nothing to record.` };
  }
  const version = /(\d+(?:\.\d+)+)/.exec(git(root, ["--version"]) ?? "")?.[1];
  return {
    ok: true,
    dirty,
    snapshot: {
      source,
      ref: commit,
      capturedAt: instantOfUnix(Number(seconds)),
      tool: "git",
      ...(version === undefined ? {} : { toolVersion: version }),
    },
  };
}

/** What the lock holds about one pinned source, as far as a snapshot needs it. */
export interface PinnedSource {
  /** The source address: an `https:` URL or `npm:<package>/<path>`. */
  readonly address: string;
  /** The package name, for an `npm:` source. */
  readonly packageName?: string;
  /** The exact installed version, for an `npm:` source. */
  readonly version?: string;
  /** SHA-256 of the pinned bytes. */
  readonly sha256: string;
  /** The date the lock stores for the fetch, for a URL. */
  readonly fetchedAt?: string;
}

/**
 * The snapshot of a package or URL source, built only from what the lock holds: nothing is fetched again. A package
 * records its name and exact version as `ref`; a URL records its content hash as `ref` and the lock's fetch date as
 * `capturedAt`, and has no date when the lock holds none.
 */
export function snapshotOfPinned(pinned: PinnedSource): CollectionSnapshot {
  if (pinned.address.startsWith("npm:") && pinned.packageName !== undefined && pinned.version !== undefined) {
    return orderedSnapshot({ source: pinned.address, ref: `${pinned.packageName}@${pinned.version}`, tool: "npm" });
  }
  return orderedSnapshot({
    source: pinned.address,
    ref: `sha256:${pinned.sha256}`,
    ...(pinned.fetchedAt === undefined ? {} : { capturedAt: pinned.fetchedAt }),
    tool: "mizzen",
  });
}

/** An HTTP date header (`Last-Modified` or `Date`) as a UTC instant to the second; `undefined` when it is not a date. */
export function instantOfHttpDate(value: string | null): string | undefined {
  if (value === null) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? instantOfUnix(Math.floor(time / 1000)) : undefined;
}

/** The fields a template may show with `:snapshot[field]`. */
export const SNAPSHOT_TEMPLATE_FIELDS = SNAPSHOT_FIELDS;

/**
 * A snapshot field as a page shows it. `capturedAt` is a date in the page's language and that language's own calendar
 * (UTC, so every time zone gives the same text); every other field is printed as the lock holds it. `undefined` when the
 * snapshot, or the field, is absent: nothing is printed that the lock does not hold.
 */
export function snapshotText(snapshot: CollectionSnapshot | undefined, field: string, lang: string): string | undefined {
  if (snapshot === undefined) return undefined;
  const value = (snapshot as unknown as Record<string, unknown>)[field];
  if (typeof value !== "string" || value === "") return undefined;
  if (field !== "capturedAt") return value;
  const instant = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
  if (!Number.isFinite(instant)) return undefined;
  try {
    return new Intl.DateTimeFormat(lang, { dateStyle: "long", timeZone: "UTC" }).format(instant);
  } catch {
    return new Intl.DateTimeFormat("en", { dateStyle: "long", timeZone: "UTC" }).format(instant);
  }
}

/** A collection whose snapshot is older than `maxAgeDays`. */
export interface StaleSnapshot {
  readonly collection: string;
  readonly capturedAt: string;
  /** Whole days between `capturedAt` and the date given. */
  readonly ageDays: number;
}

const DAY_MS = 86_400_000;

/**
 * Collections whose snapshot `capturedAt` is more than `maxAgeDays` days before `today` (a `YYYY-MM-DD` date the caller
 * supplies: this never reads the system clock). Empty when `maxAgeDays` is unset or `today` is not a date; a snapshot
 * without a `capturedAt` is never stale. Sorted by collection name.
 */
export function staleSnapshots(
  snapshots: Readonly<Record<string, CollectionSnapshot>> | undefined,
  maxAgeDays: number | undefined,
  today: string,
): StaleSnapshot[] {
  if (snapshots === undefined || maxAgeDays === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return [];
  const now = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(now)) return [];
  const out: StaleSnapshot[] = [];
  for (const collection of Object.keys(snapshots).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const capturedAt = snapshots[collection]!.capturedAt;
    if (capturedAt === undefined) continue;
    const then = Date.parse(`${capturedAt.slice(0, 10)}T00:00:00Z`);
    if (!Number.isFinite(then)) continue;
    const ageDays = Math.floor((now - then) / DAY_MS);
    if (ageDays > maxAgeDays) out.push({ collection, capturedAt, ageDays });
  }
  return out;
}
