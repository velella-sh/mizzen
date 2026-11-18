/**
 * A whole-build cache for `mizzen build` (#1060): the output of a build is kept in `.mizzen/cache` and copied back
 * when every input that shaped it is unchanged.
 *
 * The key is one SHA-256 of the site's config file and its resolved config values, every discovered source file (pages,
 * assets, app pages, and `_data`), every file a code snippet may read (including folders discovery skips), each
 * collection's history file, the navigation file, every file of the theme, every
 * file of the outputs folder, the
 * `defaultLayout` and `themeFiles` options, the engine's version, the runtime's version, and {@link CACHE_FORMAT}.
 * Paths and bytes count; timestamps do not. Config and navigation are part of the same hash as the pages, so changing
 * either misses the cache for every page.
 *
 * The entry holds a copy of the finished output folder and `manifest.json` with the file list, each file's hash, a
 * checksum of the manifest itself, and the build's diagnostics. A hit is verified file by file before it is restored,
 * so a corrupt or half-written entry is a miss, never bad output. {@link restoreCache} reports whether an unusable
 * entry was missing, corrupt, or written by an incompatible version. Every failure here is swallowed by
 * {@link restoreCache} and {@link writeCache}: a cache that cannot be read or written leaves the build to run cold.
 *
 * Every cache operation takes the folder {@link LOCK_NAME} in the cache root, so readers never see an entry while a
 * writer replaces it and pruning never removes an entry being read or written. A lock is abandoned when the process it
 * recorded died, or when it never recorded an owner and is older than {@link OWNER_GRACE_MS}; age alone never breaks a
 * lock whose owner is alive, so a restore or write that legitimately takes minutes keeps its exclusivity instead of
 * being overlapped by a competitor. A waiter gives up after {@link LOCK_WAIT_MS} and builds cold, which costs one cold
 * build rather than a hung one, and an operation that lost ownership publishes and prunes nothing. After a write, at
 * most {@link CACHE_RETENTION} entries are kept: the newest,
 * including the entry just written. An entry is copied into a temporary folder, each file hashed as it is copied,
 * published with one rename, and only then does pruning run; an interrupted staging or backup folder is removed by the
 * next operation.
 *
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { CONFIG_FILE } from "../config/load.ts";
import type { Diagnostic, PreviewPolicy, SiteConfig } from "../contracts/index.ts";
import { snippetSources } from "../content/code-snippets/dependencies.ts";
import { discover } from "../content/discover.ts";
import { parseFrontMatter } from "../content/frontmatter.ts";
import { repositoryStateKey } from "../model/reviewers.ts";
import { expandIncludes } from "../content/includes.ts";
import { version } from "../index.ts";
import { LOCK_FILE, readLock, storedPath } from "../data/lock.ts";
import { URLS_LOCK_FILE } from "../data/urls-lock.ts";
import { BLOCKS_LOCK_FILE } from "../blocks/lock.ts";
import { NETWORK_LOCK_FILE } from "../network/lock.ts";
import { resolveNpmSource } from "../data/package-source.ts";
import { historyPath } from "../data/changes/format.ts";

/** Bumped when the meaning of an entry changes, so an entry written by an older engine is never trusted. */
export const CACHE_FORMAT = 2;

/** How many entries a cache keeps, newest first. A prune never removes the entry it just wrote. */
export const CACHE_RETENTION = 4;

/** The folder in the cache root that every read, write, and prune takes, so they never overlap. */
const LOCK_NAME = ".lock";

/** A recovery guard untouched for this long belongs to a breaker that died; only guards age out, never locks. */
const STALE_MS = 120_000;

/** A lock folder with no owner is still being created, or was abandoned; after this long it is abandoned. */
const OWNER_GRACE_MS = 500;

/** How long an operation waits for the lock before it gives up and builds cold. */
const LOCK_WAIT_MS = 20_000;

/** Delay between attempts to take a busy lock. */
const LOCK_RETRY_MS = 25;

/** Prefixes of the folders a write stages and swaps through; leftovers are abandoned state. */
const TEMP_PREFIX = ".tmp-";
const OLD_PREFIX = ".old-";

/** Folder under a site root that holds the cache, relative to the root. */
export const CACHE_DIR = ".mizzen/cache";

/** Folders that never affect a build, skipped while hashing a theme or outputs folder. */
const SKIP_DIRS = new Set(["node_modules", ".git", ".mizzen", "dist", "test"]);

/** A key has 64 lowercase hexadecimal characters, and so does a directory named after one. */
const KEY = /^[0-9a-f]{64}$/;

/** What {@link cacheKey} needs. */
export interface CacheKeyOptions {
  /** Absolute site root. */
  readonly root: string;
  /** Absolute source folder, already resolved from the config. */
  readonly sourceDir: string;
  /** The site config as loaded from the root. */
  readonly config: SiteConfig;
  /** Absolute theme root. */
  readonly themeRoot: string;
  /** Absolute folder the outputs are read from. */
  readonly outputsDir: string;
  /** Absolute output folder, left out of the snippet walk when it sits inside the source folder. */
  readonly out?: string;
  /** Layout for a page that names none. */
  readonly defaultLayout?: string;
  /** Theme files copied into the output. */
  readonly themeFiles?: readonly string[];
  /** The engine version folded into the key. Default: the engine's `version`. */
  readonly engineVersion?: string;
  /** The runtime folded into the key. Default: the running Node and ICU versions. */
  readonly runtimeVersion?: string;
  /**
   * The stale state of the site's covered pages, as the build attaches it to `Page.stale`. A covered file and the review
   * lock live outside the source folder, so without this a whole-build hit would restore an older state.
   */
  readonly stale?: string;
  /** The digest of the site's plugin declarations and declared inputs; empty or absent for a site without plugins. */
  readonly pluginKey?: string;
  /** The preview policy; a preview build writes different head tags, so it never shares a normal build's entry. */
  readonly preview?: PreviewPolicy;
  /** The public build a preview is compared with, by its build hash; the diff report is part of the entry. */
  readonly baseline?: string;
}

/** The file list and diagnostics of a cache hit. */
export interface CacheRestore {
  /** A new staging folder holding the restored output, ready for the caller to move into place. */
  readonly staging: string;
  /** Every file restored, relative to the staging folder, sorted by path. */
  readonly files: readonly string[];
  /** The findings of the build that wrote the entry, sorted. */
  readonly diagnostics: readonly Diagnostic[];
}

/** Why an entry could not be used: no entry, unreadable bytes, or an entry this engine must not read. */
export type CacheMissReason = "missing" | "corrupt" | "incompatible";

/** What {@link restoreCache} takes besides the entry's identity. */
export interface RestoreOptions {
  /** Called with the reason a hit was not used. Reporting never changes the restored output. */
  readonly onMiss?: (reason: CacheMissReason) => void;
}

/** What a cache entry records. */
interface CacheManifest {
  readonly version: number;
  readonly key: string;
  readonly engine: string;
  readonly files: readonly string[];
  readonly hashes: Readonly<Record<string, string>>;
  readonly diagnostics: readonly Diagnostic[];
  /** SHA-256 of every other field, so a corrupted manifest is a miss rather than stale diagnostics. */
  readonly checksum: string;
}

/** The part of a manifest a hit relies on; {@link checksumOf} covers exactly this. */
type CachePayload = Omit<CacheManifest, "checksum">;

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** SHA-256 of the bytes, as 64 lowercase hex characters. */
function hashOf(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** JSON with object keys sorted at every level, so equal config values always hash the same. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort(byCodePoint)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** SHA-256 of the manifest's payload; the file list, hashes, and diagnostics are as much an entry as its output. */
function checksumOf(payload: CachePayload): string {
  return hashOf(
    JSON.stringify({
      version: payload.version,
      key: payload.key,
      engine: payload.engine,
      files: payload.files,
      hashes: payload.hashes,
      diagnostics: payload.diagnostics,
    }),
  );
}

/** True for a path an entry may name: relative, `/`-separated, and with no empty, `.`, or `..` segment. */
function isInside(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/.test(path)) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** A file found under a walked folder, and whether it is a symbolic link. */
interface WalkedFile {
  readonly path: string;
  readonly symlink: boolean;
}

/** Every file under `dir`, skipping folders that cannot affect a build, sorted by path. A missing folder has none. */
async function filesUnder(dir: string): Promise<WalkedFile[]> {
  const found: WalkedFile[] = [];

  async function walk(current: string, rel: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(join(current, entry.name), path);
      } else if (entry.isFile()) {
        found.push({ path, symlink: false });
      } else if (entry.isSymbolicLink()) {
        // A directory link is recorded too, but never traversed: only file links are supported here.
        found.push({ path, symlink: true });
      }
    }
  }

  await walk(dir, "");
  return found.sort((a, b) => byCodePoint(a.path, b.path));
}

/** True when `path` is `root` or below it; both are real paths with no symbolic links left in them. */
function isWithin(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/** Runs `run` for every item, at most `limit` at a time, so a thousand small reads stay inside the file descriptor limit. */
async function inBatches<T>(items: readonly T[], limit: number, run: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await run(items[index]!, index);
    }
  });
  await Promise.all(workers);
}

/** A held cache lock, or why it could not be taken. */
type LockRead = { readonly token: string } | "missing" | "failed";

/** The PID in an owner file, or `undefined` when it is not one this module wrote. */
function ownerPid(owner: string): number | undefined {
  const pid = Number.parseInt(owner.split("\n")[0] ?? "", 10);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** The PID a creator recorded together with its ownership token, or `undefined` for an unfinished owner file. */
function ownerRecorded(owner: string): number | undefined {
  const pid = ownerPid(owner);
  const lines = owner.split("\n");
  return pid !== undefined && (lines[1] ?? "").trim() !== "" ? pid : undefined;
}

/**
 * True when the process that wrote `owner` (a PID and a token, one per line) is gone. Unknown means alive.
 *
 * A signal of `0` proves presence, not identity, and #109 forbids weighing a live PID against age, so nothing here can
 * notice the OS handing a dead owner's PID to an unrelated process: such a lock reads as owned and is not broken. The
 * cache stays correct anyway, because a competitor only ever waits {@link LOCK_WAIT_MS} and builds cold, publishes and
 * prunes nothing, and recovery resumes once that recycled PID is freed: the cost is the speedup, never the output.
 * `EPERM` (a PID we may not signal, so a process of another user) counts as alive for the same reason: calling it dead
 * would let a competitor break a lock whose owner is running.
 */
function ownerIsDead(owner: string): boolean {
  const pid = ownerPid(owner);
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as { code?: unknown }).code === "ESRCH";
  }
}

/** What a breaker saw: the lock folder's inode and owner bytes, so replacement is provable. */
export interface CacheLockProbe {
  readonly ino: number;
  readonly owner: string | undefined;
  readonly abandoned: boolean;
}

/** Reads a lock and decides whether it may be broken; `undefined` when the lock vanished. */
async function probeAbandonedLock(lock: string): Promise<CacheLockProbe | undefined> {
  const info = await stat(lock).catch(() => undefined);
  // A lock that vanished was released; the caller retries instead of removing a fresh lock that replaced it.
  if (info === undefined) return undefined;
  const owner = await readFile(join(lock, "owner"), "utf8").catch(() => undefined);
  if (owner === undefined || ownerRecorded(owner) === undefined) {
    // No owner was recorded, so nothing is working under this lock: it is either still being created by a process
    // that has not written its owner yet, or the crash of one that never will. Only the grace period separates them.
    return { ino: info.ino, owner, abandoned: Date.now() - info.mtimeMs > OWNER_GRACE_MS };
  }
  // Age alone never abandons a lock. A whole-build restore or write of a large site is expected to take minutes, and
  // breaking it then would let a second operation publish or prune over it. Recovery waits for the owner to die, and
  // the one thing it cannot tell apart (a dead owner whose PID was reused) is written on `ownerIsDead`.
  return { ino: info.ino, owner, abandoned: ownerIsDead(owner) };
}

/** Serializes breakers for one lock; a guard left by a dead breaker is recovered like the lock itself. */
async function acquireBreakGuard(lock: string): Promise<string | undefined> {
  const guard = `${lock}.recover`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(guard, `${process.pid}\n${randomUUID()}\n`);
      return guard;
    } catch (err) {
      if ((err as { code?: unknown }).code !== "EEXIST") return undefined;
      if (attempt > 0) return undefined;
      const info = await stat(guard).catch(() => undefined);
      const owner = await readFile(guard, "utf8").catch(() => undefined);
      if (info === undefined || Date.now() - info.mtimeMs < STALE_MS) return undefined;
      if (owner !== undefined && !ownerIsDead(owner)) return undefined;
      // shortcut: two breakers may both recover a guard left by a process that died; the inode check
      // under the new guard still protects a lock another breaker just made.
      await rm(guard, { force: true }).catch(() => undefined);
    }
  }
  return undefined;
}

/** Breaks the lock only while it is still the one `probe` saw, under a guard that serializes breakers. */
async function breakAbandonedLock(lock: string, probe: CacheLockProbe): Promise<boolean> {
  if (!probe.abandoned) return false;
  const guard = await acquireBreakGuard(lock);
  if (guard === undefined) return false;
  try {
    const info = await stat(lock).catch(() => undefined);
    const owner = await readFile(join(lock, "owner"), "utf8").catch(() => undefined);
    // The inode alone is not enough: a filesystem may reuse it for the replacement lock immediately.
    if (info === undefined || info.ino !== probe.ino || owner !== probe.owner) return false;
    await rm(lock, { recursive: true, force: true }).catch(() => undefined);
    return true;
  } finally {
    await rm(guard, { force: true }).catch(() => undefined);
  }
}

/**
 * Takes the cache lock, waiting a bounded time for another operation. A missing cache root is a miss, and any other
 * failure means the cache is unusable this run: both leave the caller to build cold rather than hang.
 */
async function lockCache(cacheRoot: string): Promise<LockRead> {
  const lock = join(cacheRoot, LOCK_NAME);
  const token = randomUUID();
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    if (Date.now() >= deadline) return "failed";
    try {
      await mkdir(lock);
      try {
        await writeFile(join(lock, "owner"), `${process.pid}\n${token}\n`);
      } catch {
        await rm(lock, { recursive: true, force: true }).catch(() => undefined);
        return "failed";
      }
      return { token };
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (code === "ENOENT") return "missing";
      if (code !== "EEXIST") return "failed";
      const probe = await probeAbandonedLock(lock);
      if (probe !== undefined && (await breakAbandonedLock(lock, probe))) continue;
      await sleep(LOCK_RETRY_MS);
    }
  }
}

/** True when the lock still carries this operation's token, so its shared writes are still exclusive. */
async function ownsLock(cacheRoot: string, token: string): Promise<boolean> {
  const owner = await readFile(join(cacheRoot, LOCK_NAME, "owner"), "utf8").catch(() => undefined);
  return owner !== undefined && owner.includes(token);
}

/** Releases a lock this call took. A lock since broken and retaken by another operation is left alone. */
async function unlockCache(cacheRoot: string, token: string): Promise<void> {
  const lock = join(cacheRoot, LOCK_NAME);
  const owner = await readFile(join(lock, "owner"), "utf8").catch(() => undefined);
  if (owner === undefined) {
    // Another operation may be between creating the lock and writing its owner; leave a fresh one alone.
    const info = await stat(lock).catch(() => undefined);
    if (info !== undefined && Date.now() - info.mtimeMs < OWNER_GRACE_MS) return;
  } else if (!owner.includes(token) && !ownerIsDead(owner)) {
    return;
  }
  await rm(lock, { recursive: true, force: true }).catch(() => undefined);
}

/** The lock primitives, exported so the concurrency tests can drive two breakers deterministically. */
export const cacheLockInternals = {
  probeAbandonedLock,
  breakAbandonedLock,
  lockCache,
  unlockCache,
  ownsLock,
};

/** Removes staging, backup, and lock state left by an operation that died; called only while holding the lock. */
async function cleanAbandoned(cacheRoot: string): Promise<void> {
  try {
    for (const entry of await readdir(cacheRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(TEMP_PREFIX) || entry.name.startsWith(OLD_PREFIX)) {
        await rm(join(cacheRoot, entry.name), { recursive: true, force: true }).catch(() => undefined);
      }
    }
  } catch {
    // A cache that cannot be swept is still correct; the stale folders cost only disk.
  }
}

/** One file of the cache key: a label that names its role, and where to read it. */
interface KeyInput {
  readonly label: string;
  readonly path: string;
  /** The folder the link at `path` must resolve inside; set only for symbolic links found by {@link filesUnder}. */
  readonly linkRoot?: string;
  /** Hash only the file's front matter, so a body-only edit does not change the shared settings digest. */
  readonly frontMatterOnly?: boolean;
  /** Hash nothing: the file's path is its contribution, because its bytes never reach a rendered page. */
  readonly pathOnly?: boolean;
}

/**
 * The files a collection contributes to a cache key: its source — a local file, an installed package's file and version,
 * or the stored bytes of a pinned URL — its schema file, which decides which records reach a page, and its history file,
 * `data-changes/<name>.jsonl`, whose events are read as the `<name>.changes` collection. A package source
 * comes back as real paths the resolver proved are inside the package folder, never as a path built with `join`, so a
 * link cannot make the key read outside it. A site with no collections contributes nothing, so its key stays exactly
 * what 0.2.0 produced. Both lock files are inputs whenever collections exist: `mizzen.lock.json` decides which bytes a
 * remote or package source reads, and `urls.lock.json` decides which record URLs are accepted, which ones redirect, and
 * which findings a build reports. A lock file's absence is part of the key too, so creating or deleting one misses.
 */
async function collectionInputs(
  options: { readonly root: string; readonly config: SiteConfig },
  withSources = true,
): Promise<KeyInput[]> {
  const names = Object.keys(options.config.collections);
  if (names.length === 0) return [];
  const inputs: KeyInput[] = [
    { label: "data-lock", path: join(options.root, LOCK_FILE) },
    { label: "urls-lock", path: join(options.root, URLS_LOCK_FILE) },
  ];
  const lock = (await readLock(options.root).catch(() => undefined))?.lock;
  for (const name of names.sort(byCodePoint)) {
    const source = options.config.collections[name]!.source;
    if (!withSources) {
      // The records' own bytes are keyed one by one, by the page each reaches; only what shapes every record stays.
    } else if (source.startsWith("npm:")) {
      const resolved = await resolveNpmSource(options.root, source).catch(() => undefined);
      if (resolved?.source === undefined) continue;
      inputs.push({ label: `collection/${name}/package`, path: resolved.source.packageFile });
      inputs.push({ label: `collection/${name}/source`, path: resolved.source.file });
    } else if (/^https:\/\//.test(source)) {
      const pinned = lock?.sources[source];
      if (pinned !== undefined) inputs.push({ label: `collection/${name}/source`, path: storedPath(options.root, pinned.sha256) });
    } else if (!/^[a-z][a-z\d+.-]*:/i.test(source)) {
      const path = resolve(options.root, source);
      const rel = relative(options.root, path);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
      inputs.push({ label: `collection/${name}/source`, path });
    }
    // A history file is read as the `<name>.changes` collection, so its events shape pages even when no record source does.
    inputs.push({ label: `collection/${name}/history`, path: join(options.root, historyPath(name)) });
    const schema = options.config.collections[name]!.schema;
    if (schema !== undefined) {
      const path = resolve(options.root, schema);
      const rel = relative(options.root, path);
      // The schema decides whether a record reaches a page, so its bytes shape the output; it is read, never fetched.
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
      inputs.push({ label: `collection/${name}/schema`, path });
    }
  }
  return inputs;
}

/**
 * The digest of a symbolic link: its target path relative to `root` and the target's bytes, or a marker when the link
 * is broken, leaves `root`, or cannot be read. The target is read through its resolved path, so a link replaced after
 * the check cannot redirect the read, and the markers never equal a file digest, so an unusable link can never alias
 * a missing input to an unrelated entry.
 */
async function symlinkDigest(path: string, root: string): Promise<string> {
  try {
    const [realRoot, real] = await Promise.all([realpath(root), realpath(path)]);
    if (!isWithin(realRoot, real)) return hashOf("symlink\0!outside");
    const hash = createHash("sha256");
    hash.update(`symlink\0${relative(realRoot, real).split(sep).join("/")}\0`);
    hash.update(await readFile(real));
    return hash.digest("hex");
  } catch {
    return hashOf("symlink\0!unreadable");
  }
}

/**
 * The cache key of a build: SHA-256 of everything that shapes the output. Config and navigation are part of the same
 * hash, so a change to either invalidates every page. Files are read in parallel but hashed in a fixed order; a missing
 * file adds no digest, so its appearance changes the key, and a file of empty bytes never stands in for a missing one.
 */
export async function cacheKey(options: CacheKeyOptions): Promise<string> {
  const engine = options.engineVersion ?? version;
  const runtime = options.runtimeVersion ?? `${process.versions.node}/${process.versions.icu ?? ""}`;
  const themeFiles = [...new Set(options.themeFiles ?? [])].sort(byCodePoint);
  const inputs: KeyInput[] = [{ label: "config", path: join(options.root, CONFIG_FILE) }];
  // The block lock turns block ids on and decides each page's `blocks`, so its bytes shape the output; its absence too.
  inputs.push({ label: "blocks-lock", path: join(options.root, BLOCKS_LOCK_FILE) });
  // The locked network decides the base, the project links, and what themes see, so its bytes are part of the key.
  if (options.config.network !== undefined) inputs.push({ label: "network-lock", path: join(options.root, NETWORK_LOCK_FILE) });

  const files = await discover(options.sourceDir, {
    include: options.config.include,
    exclude: options.config.exclude,
  });
  for (const file of files) {
    inputs.push({ label: `source/${file.kind}/${file.path}`, path: join(options.sourceDir, file.path) });
  }
  // A snippet may read any file under the source folder, including one in a folder discovery skips. Discovery's
  // list is above; these are the rest, so an edited, moved, or deleted source misses the cache.
  const discovered = new Set(files.map((file) => file.path));
  for (const path of await snippetSources({
    sourceDir: options.sourceDir,
    ...(options.out === undefined ? {} : { skip: [options.out] }),
  })) {
    if (discovered.has(path)) continue;
    inputs.push({ label: `snippet/${path}`, path: join(options.sourceDir, path) });
  }

  // The navigation file may live outside the source folder, so it is hashed on its own as well.
  inputs.push({ label: "navigation", path: resolve(options.root, options.config.navigation) });
  inputs.push(...overrideInputs(options));
  inputs.push(...(await collectionInputs(options)));

  for (const file of await filesUnder(options.themeRoot)) {
    inputs.push({
      label: `theme/${file.path}`,
      path: join(options.themeRoot, file.path),
      ...(file.symlink ? { linkRoot: options.themeRoot } : {}),
    });
  }
  for (const file of await filesUnder(options.outputsDir)) {
    inputs.push({
      label: `outputs/${file.path}`,
      path: join(options.outputsDir, file.path),
      ...(file.symlink ? { linkRoot: options.outputsDir } : {}),
    });
  }

  const digests: string[] = new Array(inputs.length);
  await inBatches(inputs, 32, async (input, index) => {
    if (input.linkRoot !== undefined) {
      digests[index] = await symlinkDigest(input.path, input.linkRoot);
      return;
    }
    try {
      digests[index] = hashOf(await readFile(input.path));
    } catch {
      digests[index] = "";
    }
  });

  const hash = createHash("sha256");
  hash.update("mizzen-cache\0");
  hash.update(`${CACHE_FORMAT}\0${engine}\0${runtime}\0`);
  // Review evidence moves with the repository, not the files: a commit must miss the cache that rendered the old date.
  hash.update(`repository\0${repositoryStateKey(options.root)}\0`);
  // A covered file or the review lock can change without a source file changing.
  hash.update(`stale\0${options.stale ?? ""}\0`);
  // The config values matter as well as the file: a missing config takes its title from the folder name.
  hash.update(`config\0${canonicalJson(options.config)}\0`);
  hash.update(`defaultLayout\0${options.defaultLayout ?? ""}\0`);
  // A preview changes every page's robots and canonical, so its pages are never the ones a normal build rendered. The
  // commit names the report the entry holds, so a preview of another commit is never answered by this one.
  hash.update(`preview\0${options.preview?.canonicalBase ?? ""}\0${options.preview?.commit ?? ""}\0`);
  // The diff report an entry holds names the public build it compared, so another baseline must not reuse it.
  hash.update(`baseline\0${options.baseline ?? ""}\0`);
  hash.update(`themeFiles\0${themeFiles.join("\0")}\0`);
  // A plugin's version, settings, declared inputs, and code file shape its output; its digest covers them all.
  hash.update(`plugins\0${options.pluginKey ?? ""}\0`);
  for (let index = 0; index < inputs.length; index++) {
    hash.update(`${inputs[index]!.label}\0${digests[index]!}\0`);
  }
  // Discovery skips `_` folders, but a page can include a snippet from one, and the snippet's bytes shape the page.
  // Without them an include edit would be a whole-build hit that restores the old page.
  for (const path of await includedSnippets(files, options.sourceDir)) {
    let digest = "";
    try {
      digest = hashOf(await readFile(join(options.sourceDir, path)));
    } catch {
      digest = "";
    }
    hash.update(`include/${path}\0${digest}\0`);
  }
  return hash.digest("hex");
}

/** Every file any doc page includes, sorted; a missing include has no bytes to hash and is already a diagnostic. */
export async function includedSnippets(
  files: readonly { readonly kind: string; readonly path: string }[],
  sourceDir: string,
): Promise<string[]> {
  const found = new Set<string>();
  for (const file of files) {
    if (file.kind !== "doc") continue;
    try {
      const source = await readFile(join(sourceDir, file.path), "utf8");
      const front = parseFrontMatter(source, file.path);
      const expanded = await expandIncludes({
        body: front.body,
        bodyLine: front.bodyLine,
        file: file.path,
        sourceDir,
      });
      for (const dependency of expanded.includes) if (dependency.missing !== true) found.add(dependency.path);
    } catch {
      // A page that cannot be read is reported by the build; the key simply has one input fewer.
    }
  }
  return [...found].sort(byCodePoint);
}

/**
 * The settings a page render may depend on besides the page itself: the resolved config, the navigation, every data
 * file, every theme and output file, the default layout, the engine, and the runtime. A doc page contributes its front
 * matter, not its body: a body-only edit changes one page's render key, while a title, date, data, navigation, or theme
 * change changes every key, so no page can be rendered from with stale chrome or metadata.
 */
export interface RenderSettingsOptions {
  readonly root: string;
  readonly sourceDir: string;
  readonly config: SiteConfig;
  readonly themeRoot: string;
  readonly outputsDir: string;
  readonly defaultLayout?: string | undefined;
  readonly themeFiles?: readonly string[] | undefined;
  readonly engineVersion?: string | undefined;
  readonly runtimeVersion?: string | undefined;
  /** The digest of the site's plugin declarations and declared inputs; a plugin change always retires every render. */
  readonly pluginKey?: string | undefined;
  /** The preview policy; a preview changes every page's head, so its pages cannot come from a normal build's cache. */
  readonly preview?: PreviewPolicy | undefined;
  /**
   * The site's shape without its records' fields: every page's URL and title, the navigation, and each collection's
   * record ids. When it is given, the source bytes of a collection are not part of the key, because a record page is
   * keyed by its own record and the records it references (see `renderPageKey`) and a list page by its collection. A
   * layout that reads another record's fields without being a list page is outside that contract.
   */
  readonly recordShape?: string | undefined;
}

/** The site modules and CSS sidecars an override names, so editing one misses the cache. */
function overrideInputs(options: { readonly root: string; readonly config: SiteConfig }): readonly KeyInput[] {
  const out: KeyInput[] = [];
  const overrides = options.config.theme.overrides;
  if (overrides === undefined) return out;
  for (const folder of ["layouts", "components"] as const) {
    const map = overrides[folder];
    if (map === undefined) continue;
    for (const name of Object.keys(map).sort(byCodePoint)) {
      const path = resolve(options.root, map[name] ?? "");
      out.push({ label: `override/${folder}/${name}`, path }, { label: `override/${folder}/${name}/css`, path: path.replace(/\.ts$/, ".css") });
    }
  }
  return out;
}

/** The absolute paths of the local files that collections read, which a record-keyed render cache keys per record. */
function localCollectionSources(options: { readonly root: string; readonly config: SiteConfig }): Set<string> {
  const paths = new Set<string>();
  for (const collection of Object.values(options.config.collections)) {
    const source = collection.source;
    if (source.startsWith("npm:") || /^[a-z][a-z\d+.-]*:/i.test(source)) continue;
    paths.add(resolve(options.root, source));
  }
  return paths;
}

/** The SHA-256 of the settings {@link RenderSettingsOptions} describes, for the per-page render cache. */
export async function renderSettingsKey(options: RenderSettingsOptions): Promise<string> {
  const engine = options.engineVersion ?? version;
  const runtime = options.runtimeVersion ?? `${process.versions.node}/${process.versions.icu ?? ""}`;
  const themeFiles = [...new Set(options.themeFiles ?? [])].sort(byCodePoint);
  const inputs: KeyInput[] = [{ label: "config", path: join(options.root, CONFIG_FILE) }];
  // The locked network decides the base, the project links, and what themes see, so its bytes are part of the key.
  if (options.config.network !== undefined) inputs.push({ label: "network-lock", path: join(options.root, NETWORK_LOCK_FILE) });

  const recordKeyed = options.recordShape !== undefined ? localCollectionSources(options) : new Set<string>();
  for (const file of await discover(options.sourceDir, {
    include: options.config.include,
    exclude: options.config.exclude,
  })) {
    if (recordKeyed.has(join(options.sourceDir, file.path))) continue;
    // A doc page's body is its own render key; its front matter is shared with every page that shows its title.
    if (file.kind === "doc") {
      inputs.push({ label: `page/${file.path}`, path: join(options.sourceDir, file.path), frontMatterOnly: true });
    } else if (file.kind === "asset") {
      // An asset's bytes do not reach a page's HTML; its path already arrives through the page that names it.
      inputs.push({ label: `asset/${file.path}`, path: join(options.sourceDir, file.path), pathOnly: true });
    } else {
      inputs.push({ label: `source/${file.kind}/${file.path}`, path: join(options.sourceDir, file.path) });
    }
  }

  inputs.push({ label: "navigation", path: resolve(options.root, options.config.navigation) });
  inputs.push(...overrideInputs(options));
  inputs.push(...(await collectionInputs(options, options.recordShape === undefined)));

  for (const file of await filesUnder(options.themeRoot)) {
    inputs.push({
      label: `theme/${file.path}`,
      path: join(options.themeRoot, file.path),
      ...(file.symlink ? { linkRoot: options.themeRoot } : {}),
    });
  }
  for (const file of await filesUnder(options.outputsDir)) {
    inputs.push({
      label: `outputs/${file.path}`,
      path: join(options.outputsDir, file.path),
      ...(file.symlink ? { linkRoot: options.outputsDir } : {}),
    });
  }

  const digests: string[] = new Array(inputs.length);
  await inBatches(inputs, 32, async (input, index) => {
    if (input.pathOnly === true) {
      digests[index] = "";
      return;
    }
    if (input.linkRoot !== undefined) {
      digests[index] = await symlinkDigest(input.path, input.linkRoot);
      return;
    }
    try {
      const source = await readFile(input.path);
      digests[index] = hashOf(input.frontMatterOnly === true ? frontMatterText(source.toString("utf8")) : source);
    } catch {
      digests[index] = "";
    }
  });

  const hash = createHash("sha256");
  hash.update("mizzen-render\0");
  hash.update(`${engine}\0${runtime}\0`);
  hash.update(`repository\0${repositoryStateKey(options.root)}\0`);
  // The as-of date is per page: a page that reads it puts it in its own render key, so a date move retires those pages
  // and no other.
  hash.update(`config\0${canonicalJson({ ...options.config, asOf: undefined })}\0`);
  hash.update(`defaultLayout\0${options.defaultLayout ?? ""}\0`);
  hash.update(`preview\0${options.preview?.canonicalBase ?? ""}\0`);
  if (options.recordShape !== undefined) hash.update(`recordShape\0${options.recordShape}\0`);
  // A model hook can change site data every page reads, so a plugin change retires every render.
  hash.update(`plugins\0${options.pluginKey ?? ""}\0`);
  hash.update(`themeFiles\0${themeFiles.join("\0")}\0`);
  for (let index = 0; index < inputs.length; index++) {
    hash.update(`${inputs[index]!.label}\0${digests[index]!}\0`);
  }
  return hash.digest("hex");
}

/** The front-matter text of one Markdown file, fences included, or the whole file when it has none. */
function frontMatterText(source: string): string {
  const front = parseFrontMatter(source, "");
  if (front.bodyLine <= 1) return "";
  const lines = source.split(/(?<=\n)/);
  return lines.slice(0, front.bodyLine - 1).join("");
}

/** True when `value` is a manifest this version wrote and can trust the shape of. */
function isManifest(value: unknown): value is CacheManifest {
  if (typeof value !== "object" || value === null) return false;
  const manifest = value as Partial<CacheManifest>;
  if (typeof manifest.version !== "number" || typeof manifest.key !== "string" || !KEY.test(manifest.key)) return false;
  if (typeof manifest.engine !== "string") return false;
  if (typeof manifest.checksum !== "string" || !KEY.test(manifest.checksum)) return false;
  if (!Array.isArray(manifest.files) || !manifest.files.every((file): file is string => typeof file === "string")) return false;
  if (typeof manifest.hashes !== "object" || manifest.hashes === null) return false;
  if (!Array.isArray(manifest.diagnostics)) return false;
  return manifest.diagnostics.every(
    (d): boolean =>
      typeof d === "object" &&
      d !== null &&
      typeof (d as Diagnostic).id === "string" &&
      typeof (d as Diagnostic).message === "string" &&
      ((d as Diagnostic).severity === "error" ||
        (d as Diagnostic).severity === "warning" ||
        (d as Diagnostic).severity === "info"),
  );
}

/** An entry that can be restored, or why there is none. */
type EntryRead =
  | { readonly entry: { readonly dir: string; readonly manifest: CacheManifest } }
  | { readonly reason: CacheMissReason };

/** Reads and checks an entry at `dir`. Missing bytes are a miss, bad bytes corruption, another format incompatible. */
async function readEntryAt(dir: string, key: string): Promise<EntryRead> {
  let text: string;
  try {
    text = await readFile(join(dir, "manifest.json"), "utf8");
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    return { reason: code === "ENOENT" || code === "ENOTDIR" ? "missing" : "corrupt" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { reason: "corrupt" };
  }
  if (typeof parsed !== "object" || parsed === null) return { reason: "corrupt" };
  const manifest = parsed as Partial<CacheManifest>;
  if (manifest.version !== CACHE_FORMAT || manifest.engine !== version) return { reason: "incompatible" };
  if (!isManifest(parsed) || parsed.key !== key) return { reason: "corrupt" };
  if (parsed.checksum !== checksumOf(parsed)) return { reason: "corrupt" };

  for (const file of parsed.files) {
    if (!isInside(file)) return { reason: "corrupt" };
    const expected = parsed.hashes[file];
    if (typeof expected !== "string" || !KEY.test(expected)) return { reason: "corrupt" };
  }
  return { entry: { dir, manifest: parsed } };
}

/** Reads and checks the entry for `key`. A key that is not a key can name nothing. */
async function readEntry(cacheRoot: string, key: string): Promise<EntryRead> {
  if (!KEY.test(key)) return { reason: "missing" };
  return readEntryAt(join(cacheRoot, key), key);
}

/**
 * Copies the entry for `key` into a fresh staging folder beside `out`, checking every file against its hash as it
 * reads it, so a corrupt or half-written entry is a miss rather than bad output. Returns `undefined` when there is no
 * usable entry, reporting why; the caller then builds cold. The cache lock is held while the entry is read, so a
 * concurrent writer cannot replace it between the manifest and its files.
 */
export async function restoreCache(
  cacheRoot: string,
  key: string,
  out: string,
  options: RestoreOptions = {},
): Promise<CacheRestore | undefined> {
  const held = await lockCache(cacheRoot);
  if (typeof held === "string") {
    options.onMiss?.(held === "missing" ? "missing" : "corrupt");
    return undefined;
  }

  try {
    await cleanAbandoned(cacheRoot);
    if (!(await ownsLock(cacheRoot, held.token))) {
      options.onMiss?.("corrupt");
      return undefined;
    }
    const read = await readEntry(cacheRoot, key);
    if ("reason" in read) {
      options.onMiss?.(read.reason);
      return undefined;
    }

    const parent = dirname(out);
    await mkdir(parent, { recursive: true });
    const staging = await mkdtemp(join(parent, `.${basename(out)}-build-`));
    try {
      const source = join(read.entry.dir, "out");
      const files = read.entry.manifest.files;
      const directories = new Set(files.map((file) => dirname(join(staging, file))));
      await Promise.all([...directories].map((dir) => mkdir(dir, { recursive: true })));
      await inBatches(files, 32, async (file) => {
        const bytes = await readFile(join(source, file));
        if (hashOf(bytes) !== read.entry.manifest.hashes[file]) throw new Error(`cache: "${file}" does not match its hash`);
        await writeFile(join(staging, file), bytes);
      });
      // A lock broken while the entry was being read means another operation may prune it; report a miss.
      if (!(await ownsLock(cacheRoot, held.token))) {
        await rm(staging, { recursive: true, force: true });
        options.onMiss?.("corrupt");
        return undefined;
      }
      return { staging, files: [...files].sort(byCodePoint), diagnostics: read.entry.manifest.diagnostics };
    } catch {
      await rm(staging, { recursive: true, force: true });
      options.onMiss?.("corrupt");
      return undefined;
    }
  } finally {
    await unlockCache(cacheRoot, held.token);
  }
}

/**
 * Writes an entry whole: a staged folder beside the target, each file hashed while it is copied, then one rename. The
 * manifest describes exactly the bytes written to the staged folder, so a published entry never needs a second read.
 * An existing entry is moved aside first and put back if the rename fails, so a failed write never loses the entry it
 * replaced. The caller holds the cache lock, so no reader observes the target between the two renames.
 */
async function writeEntry(
  cacheRoot: string,
  key: string,
  source: string,
  files: readonly string[],
  diagnostics: readonly Diagnostic[],
  owns: () => Promise<boolean>,
): Promise<boolean> {
  const temp = await mkdtemp(join(cacheRoot, TEMP_PREFIX));
  try {
    const out = join(temp, "out");
    const directories = new Set(files.map((file) => dirname(join(out, file))));
    await Promise.all([...directories].map((dir) => mkdir(dir, { recursive: true })));
    const digests: string[] = new Array(files.length);
    await inBatches(files, 32, async (file, index) => {
      const bytes = await readFile(join(source, file));
      digests[index] = hashOf(bytes);
      await writeFile(join(out, file), bytes);
    });
    const hashes: Record<string, string> = {};
    for (let index = 0; index < files.length; index++) hashes[files[index]!] = digests[index]!;
    const payload: CachePayload = { version: CACHE_FORMAT, key, engine: version, files, hashes, diagnostics };
    const manifest: CacheManifest = { ...payload, checksum: checksumOf(payload) };
    await writeFile(join(temp, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

    // Another operation may have broken and retaken a lock that outlived its lease; never publish then.
    if (!(await owns())) return false;
    const target = join(cacheRoot, key);
    const backup = join(cacheRoot, `${OLD_PREFIX}${key}-${randomUUID()}`);
    let replaced = false;
    try {
      await rename(target, backup);
      replaced = true;
    } catch (err) {
      if ((err as { code?: unknown }).code !== "ENOENT") throw err;
    }
    try {
      await rename(temp, target);
    } catch (err) {
      if (replaced) await rename(backup, target).catch(() => undefined);
      throw err;
    }
    if (replaced) await rm(backup, { recursive: true, force: true }).catch(() => undefined);
    return true;
  } finally {
    await rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Removes entries beyond the newest {@link CACHE_RETENTION}, keeping the entry just written. The caller holds the cache
 * lock, so every other entry is idle: pruning can remove neither an entry being read nor one being written.
 */
async function prune(cacheRoot: string, keep: string): Promise<void> {
  try {
    const entries: { name: string; path: string; mtime: number }[] = [];
    for (const entry of await readdir(cacheRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !KEY.test(entry.name)) continue;
      const path = join(cacheRoot, entry.name);
      const info = await stat(path).catch(() => undefined);
      entries.push({ name: entry.name, path, mtime: info?.mtimeMs ?? 0 });
    }
    entries.sort((a, b) => b.mtime - a.mtime || byCodePoint(b.name, a.name));

    const newest = entries.slice(0, CACHE_RETENTION);
    const retained = new Set(newest.map((entry) => entry.name));
    retained.add(keep);
    if (retained.size > CACHE_RETENTION) {
      const oldest = newest.at(-1);
      if (oldest !== undefined) retained.delete(oldest.name);
    }

    for (const entry of entries) {
      if (!retained.has(entry.name)) await rm(entry.path, { recursive: true, force: true }).catch(() => undefined);
    }
  } catch {
    // A cache that cannot be pruned is still correct; it costs only disk.
  }
}

/**
 * Records a finished build under `key`, with its files and diagnostics. The write is atomic and complete or absent:
 * a file list that does not match `source` writes no entry at all. Never throws: a cache that cannot be written only
 * costs the next build its speed.
 */
export async function writeCache(
  cacheRoot: string,
  key: string,
  source: string,
  files: readonly string[],
  diagnostics: readonly Diagnostic[],
): Promise<void> {
  try {
    if (!KEY.test(key)) return;
    const sorted = [...files].filter(isInside).sort(byCodePoint);
    // A list that does not describe the finished output is stale: write nothing, and do not even take the lock.
    await inBatches(sorted, 32, async (file) => {
      await stat(join(source, file));
    });

    await mkdir(cacheRoot, { recursive: true });
    const held = await lockCache(cacheRoot);
    if (typeof held === "string") return;
    try {
      await cleanAbandoned(cacheRoot);
      const owns = () => ownsLock(cacheRoot, held.token);
      if (!(await owns())) return;
      if (await writeEntry(cacheRoot, key, source, sorted, diagnostics, owns)) {
        if (await owns()) await prune(cacheRoot, key);
      }
    } finally {
      await unlockCache(cacheRoot, held.token);
    }
  } catch {
    // The build already succeeded; a cache failure never changes that.
  }
}

/** The default cache folder of a site: `<root>/.mizzen/cache`. */
export function cacheRootOf(root: string): string {
  return join(resolve(root), CACHE_DIR);
}
