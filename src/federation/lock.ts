/**
 * `federation.lock.json`: the manifest's own hash and every bundle pinned by SHA-256. A build reads only this file and
 * the bundle bytes it names under `.mizzen/federation/`, so it is offline and repeatable. The file is canonical (keys
 * sorted, LF, one trailing newline) and holds no timestamp, so fetching unchanged bundles writes the same bytes.
 */
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  FederationLock,
  FederationLockEntry,
  KnowledgeBundle,
  LoadedFederation,
} from "../contracts/federation.ts";
import { canonicalJson, sha256 } from "../data/lock.ts";
import { readBundle } from "./bundle.ts";
import { byCodePoint } from "./contract.ts";

/** The lock file name at a site root. */
export const FEDERATION_LOCK_FILE = "federation.lock.json";

/** Folder under a site root that holds the fetched bundles, named by their SHA-256. */
export const FEDERATION_STORE = ".mizzen/federation";

/** The lock's text: canonical JSON and one trailing line feed, bundles in project order. */
export function federationLockText(lock: FederationLock): string {
  const bundles: Record<string, FederationLockEntry> = {};
  for (const project of Object.keys(lock.bundles).sort(byCodePoint)) {
    bundles[project] = lock.bundles[project]!;
  }
  return `${canonicalJson({ version: lock.version, manifest: lock.manifest, bundles })}\n`;
}

/** SHA-256 of the lock's text: the lock's identity in the cache key and the build. */
export function federationLockHash(lock: FederationLock): string {
  return sha256(federationLockText(lock));
}

/** Where one bundle's bytes live: `<root>/.mizzen/federation/<sha256>.json`. */
export function bundlePath(root: string, digest: string): string {
  return join(root, FEDERATION_STORE, `${digest}.json`);
}

/** True when `value` has the shape this engine reads as a lock. */
export function isFederationLock(value: unknown): value is FederationLock {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const lock = value as Record<string, unknown>;
  if (lock.version !== 1) return false;
  if (typeof lock.manifest !== "object" || lock.manifest === null) return false;
  const manifest = lock.manifest as Record<string, unknown>;
  if (typeof manifest.source !== "string" || typeof manifest.sha256 !== "string") return false;
  if (typeof lock.bundles !== "object" || lock.bundles === null || Array.isArray(lock.bundles)) return false;
  for (const entry of Object.values(lock.bundles as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null) return false;
    const pin = entry as Record<string, unknown>;
    if (typeof pin.project !== "string" || typeof pin.namespace !== "string" || typeof pin.role !== "string") return false;
    if (typeof pin.source !== "string" || typeof pin.optional !== "boolean") return false;
    if (pin.missing !== undefined && typeof pin.missing !== "string") return false;
    if (pin.sha256 !== undefined && typeof pin.sha256 !== "string") return false;
    if (pin.snapshot !== undefined && (typeof pin.snapshot !== "object" || pin.snapshot === null)) return false;
  }
  return true;
}

/** Reads the lock, or `undefined` when the site declares none. */
export async function readFederationLock(root: string): Promise<FederationLock | undefined> {
  let text: string;
  try {
    text = await readFile(join(root, FEDERATION_LOCK_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const value = JSON.parse(text) as unknown;
  if (!isFederationLock(value)) throw new Error(`${FEDERATION_LOCK_FILE} is not a federation lock this engine reads.`);
  return value;
}

/** Writes the lock through a staging rename, so no reader sees a partial file. */
export async function writeFederationLock(root: string, lock: FederationLock): Promise<void> {
  await writeFile(join(root, FEDERATION_LOCK_FILE), federationLockText(lock));
}

/** Writes one bundle's bytes through a staging rename. */
export async function writeBundle(root: string, digest: string, text: string): Promise<void> {
  const dir = join(root, FEDERATION_STORE);
  await mkdir(dir, { recursive: true });
  const staging = await mkdtemp(join(dir, ".stage-"));
  try {
    await writeFile(join(staging, `${digest}.json`), text);
    await rename(join(staging, `${digest}.json`), bundlePath(root, digest));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * The federated knowledge a build reads: every pinned bundle that still verifies, and every locked project whose bytes
 * are absent or fail verification. A bundle that fails verification is never replaced by a freshly fetched one, and a
 * missing optional project makes the result `partial` rather than failing; a missing required project is also named in
 * `requiredMissing` so the caller can raise it.
 */
export interface FederationLoad {
  readonly loaded: LoadedFederation;
  /** The locked projects that are required and absent, so a build reports them as an error. */
  readonly requiredMissing: readonly string[];
  /** The lock's own hash, for the build cache key. */
  readonly lockHash?: string;
}

/** Loads the lock and its pinned bundles. This is the only federation unit a build calls. */
export async function loadFederation(root: string): Promise<FederationLoad> {
  const lock = await readFederationLock(root);
  if (lock === undefined) {
    return { loaded: { bundles: new Map(), missing: [], partial: false }, requiredMissing: [] };
  }
  const bundles = new Map<string, KnowledgeBundle>();
  const missing: { project: string; optional: boolean; reason: string }[] = [];
  const requiredMissing: string[] = [];
  const digests: string[] = [];
  for (const project of Object.keys(lock.bundles).sort(byCodePoint)) {
    const pin = lock.bundles[project]!;
    if (pin.sha256 === undefined) {
      const reason = pin.missing ?? "the lock pins no bundle and gives no reason.";
      missing.push({ project, optional: pin.optional, reason });
      if (!pin.optional) requiredMissing.push(project);
      continue;
    }
    let text: string;
    try {
      text = await readFile(bundlePath(root, pin.sha256), "utf8");
    } catch {
      missing.push({ project, optional: pin.optional, reason: "the pinned bundle is missing from the local store." });
      if (!pin.optional) requiredMissing.push(project);
      continue;
    }
    if (sha256(text) !== pin.sha256) {
      missing.push({ project, optional: pin.optional, reason: "the stored bytes do not match the pinned SHA-256." });
      if (!pin.optional) requiredMissing.push(project);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      missing.push({ project, optional: pin.optional, reason: "the pinned bundle is not valid JSON." });
      if (!pin.optional) requiredMissing.push(project);
      continue;
    }
    const read = readBundle(parsed);
    if (read.bundle === undefined) {
      missing.push({ project, optional: pin.optional, reason: read.problem ?? "the pinned bundle was refused." });
      if (!pin.optional) requiredMissing.push(project);
      continue;
    }
    if (read.bundle.project !== project) {
      missing.push({ project, optional: pin.optional, reason: `the pinned bundle belongs to "${read.bundle.project}".` });
      if (!pin.optional) requiredMissing.push(project);
      continue;
    }
    bundles.set(project, read.bundle);
    digests.push(`${project}\u0000${read.bundle.digest}`);
  }
  const partial = missing.length > 0;
  const fingerprint = sha256(canonicalJson({ lock: federationLockHash(lock), bundles: digests.sort(byCodePoint) }));
  return {
    loaded: { lock, bundles, missing, partial, fingerprint },
    requiredMissing,
    lockHash: federationLockHash(lock),
  };
}
