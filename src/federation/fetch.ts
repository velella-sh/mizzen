/**
 * `mizzen federation fetch`: reads the manifest and each project's bundle, verifies every one, and writes
 * `federation.lock.json` plus the bundle bytes under `.mizzen/federation/`. A normal build reads only those files.
 *
 * The network is a seam: `fetch` is a function the caller supplies, so a test drives the whole flow offline and the CLI
 * uses Node's global `fetch`. An unchanged set of bundles writes the same bytes, and a bundle that fails verification is
 * refused rather than pinned, so the lock never records bytes a reader cannot trust.
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  FederationLock,
  FederationLockEntry,
  FederationManifest,
  KnowledgeBundle,
} from "../contracts/federation.ts";
import { sha256 } from "../data/lock.ts";
import { bundleText, readBundle } from "./bundle.ts";
import { byCodePoint } from "./contract.ts";
import {
  FEDERATION_LOCK_FILE,
  federationLockText,
  type FederationLoad,
  loadFederation,
  writeBundle,
  writeFederationLock,
} from "./lock.ts";
import { type FederationProblem, parseFederationManifest, sourceText } from "./manifest.ts";

/** Reads one address: an `https:` URL, or a path relative to the manifest's folder. */
export type FederationFetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** What one project contributed to a fetch. */
export interface FetchedBundle {
  readonly project: string;
  readonly entry: FederationLockEntry;
  /** The verified bundle text, or `undefined` when the project has none. */
  readonly text?: string;
  /** Why the project has no bundle, when it may be absent. */
  readonly reason?: string;
}

/** What a fetch returns: the lock, every bundle, and the lines a reader sees. */
export interface FederationFetchResult {
  readonly lock?: FederationLock;
  readonly bundles: readonly FetchedBundle[];
  readonly lines: readonly string[];
  readonly problems: readonly FederationProblem[];
}

/** The manifest text and folder, read from an `https:` URL or a path relative to `root`. */
async function readManifest(
  root: string,
  source: string,
  fetch: FederationFetchLike,
): Promise<{ readonly text: string; readonly folder: string; readonly problems: readonly FederationProblem[] } | undefined> {
  if (/^https:\/\//.test(source)) {
    try {
      const response = await fetch(source);
      if (!response.ok) throw new Error(`the manifest answered ${response.status}.`);
      return { text: await response.text(), folder: source.replace(/\/[^/]*$/, ""), problems: [] };
    } catch (error) {
      return { text: "", folder: source, problems: [{ path: "/manifest", code: "federation.manifest-unreadable", message: `Cannot read ${source}: ${error instanceof Error ? error.message : String(error)}.` }] };
    }
  }
  try {
    return { text: await readFile(resolve(root, source), "utf8"), folder: resolve(root, dirname(source)), problems: [] };
  } catch (error) {
    return { text: "", folder: resolve(root, dirname(source)), problems: [{ path: "/manifest", code: "federation.manifest-unreadable", message: `Cannot read ${source}: ${error instanceof Error ? error.message : String(error)}.` }] };
  }
}

/** One project's bundle text, or the reason it has none. */
async function readProjectBundle(
  folder: string,
  entry: FederationManifest["projects"][number],
  fetch: FederationFetchLike,
): Promise<{ readonly text?: string; readonly reason?: string }> {
  const source = entry.source;
  try {
    if (source.url !== undefined) {
      const response = await fetch(source.url);
      if (!response.ok) return { reason: `the bundle answered ${response.status}.` };
      return { text: await response.text() };
    }
    return { text: await readFile(resolve(folder, source.path!), "utf8") };
  } catch (error) {
    return { reason: `the bundle could not be read: ${error instanceof Error ? error.message : String(error)}.` };
  }
}

/** The pin for one verified bundle. */
function entryOf(project: FederationManifest["projects"][number], bundle: KnowledgeBundle, text: string): FederationLockEntry {
  return {
    project: project.id,
    namespace: project.namespace,
    role: project.role,
    sha256: sha256(text),
    snapshot: bundle.snapshot,
    source: sourceText(project.source),
    optional: project.optional === true,
  };
}

/** An entry for a project whose bundle is absent. */
function absentEntry(project: FederationManifest["projects"][number], reason: string): FederationLockEntry {
  return {
    project: project.id,
    namespace: project.namespace,
    role: project.role,
    source: sourceText(project.source),
    optional: project.optional === true,
    missing: reason,
  };
}

/**
 * Fetches and pins every project in the manifest. A required project whose bundle is absent or fails verification is a
 * problem and stops the write; an optional one is pinned as absent with its reason, so a later build is `partial` and
 * keeps every snapshot it already had.
 */
export async function fetchFederation(options: {
  readonly root: string;
  readonly manifest: string;
  readonly fetch: FederationFetchLike;
  /** Writes nothing and returns the diff, so a CI check can compare. */
  readonly check?: boolean;
}): Promise<FederationFetchResult> {
  const read = await readManifest(options.root, options.manifest, options.fetch);
  if (read === undefined) return { bundles: [], lines: [], problems: [] };
  if (read.problems.length > 0) return { bundles: [], lines: [], problems: read.problems };

  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text) as unknown;
  } catch (error) {
    return {
      bundles: [],
      lines: [],
      problems: [{ path: "", code: "federation.manifest-invalid", message: `The manifest is not JSON: ${error instanceof Error ? error.message : String(error)}.` }],
    };
  }
  const { manifest, problems } = parseFederationManifest(parsed);
  if (manifest === undefined) return { bundles: [], lines: [], problems };

  const bundles: FetchedBundle[] = [];
  const failures: FederationProblem[] = [];
  for (const project of manifest.projects) {
    const fetched = await readProjectBundle(read.folder, project, options.fetch);
    if (fetched.text === undefined) {
      if (project.optional === true) {
        const reason = fetched.reason ?? "the bundle is absent.";
        bundles.push({ project: project.id, entry: absentEntry(project, reason), reason });
        continue;
      }
      failures.push({
        path: `/projects/${manifest.projects.indexOf(project)}`,
        code: "federation.bundle-unreadable",
        message: `The required project "${project.id}" has no bundle: ${fetched.reason ?? "absent"}`,
      });
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(fetched.text) as unknown;
    } catch (error) {
      failures.push({ path: `/projects/${manifest.projects.indexOf(project)}`, code: "federation.bundle-invalid", message: `The bundle of "${project.id}" is not JSON: ${error instanceof Error ? error.message : String(error)}.` });
      continue;
    }
    const bundle = readBundle(value);
    if (bundle.bundle === undefined) {
      failures.push({ path: `/projects/${manifest.projects.indexOf(project)}`, code: "federation.bundle-invalid", message: `The bundle of "${project.id}" was refused: ${bundle.problem}.` });
      continue;
    }
    if (bundle.bundle.project !== project.id || bundle.bundle.namespace !== project.namespace) {
      failures.push({
        path: `/projects/${manifest.projects.indexOf(project)}`,
        code: "federation.bundle-mismatch",
        message: `The bundle names "${bundle.bundle.project}/${bundle.bundle.namespace}", but the manifest names "${project.id}/${project.namespace}".`,
      });
      continue;
    }
    bundles.push({ project: project.id, entry: entryOf(project, bundle.bundle, bundleText(bundle.bundle)), text: bundleText(bundle.bundle) });
  }

  if (failures.length > 0) return { bundles, lines: [], problems: failures };

  const lock: FederationLock = {
    version: 1,
    manifest: { source: options.manifest, sha256: sha256(read.text) },
    bundles: Object.fromEntries(
      bundles.map((entry) => [entry.project, entry.entry] as const).sort((a, b) => byCodePoint(a[0], b[0])),
    ),
  };

  // The lock before this fetch is what the diff compares; reading it after a write would always say nothing changed.
  const before = await loadFederation(options.root);

  if (options.check !== true) {
    for (const entry of bundles) {
      if (entry.text === undefined) continue;
      await writeBundle(options.root, entry.entry.sha256!, entry.text);
    }
    const existing = await readFile(resolve(options.root, FEDERATION_LOCK_FILE), "utf8").catch(() => undefined);
    if (existing === undefined || existing !== federationLockText(lock)) {
      await writeFederationLock(options.root, lock);
    }
  }

  return { lock, bundles, lines: diffLines(before, lock, bundles), problems: [] };
}

/** A readable diff between what the lock held and what the fetch read, one line per change. */
function diffLines(previous: FederationLoad, next: FederationLock, bundles: readonly FetchedBundle[]): string[] {
  const before = previous.loaded.lock;
  if (before === undefined) return [`new lock for ${next.manifest.source}`, ...bundles.map((entry) => `  pinned ${entry.project}`)];
  const lines: string[] = [];
  if (before.manifest.sha256 !== next.manifest.sha256) {
    lines.push(`manifest changed (${before.manifest.sha256.slice(0, 8)} -> ${next.manifest.sha256.slice(0, 8)})`);
  }
  for (const entry of bundles) {
    const was = before.bundles[entry.project];
    if (was === undefined) lines.push(`  new project ${entry.project}`);
    else if (was.sha256 !== entry.entry.sha256) lines.push(`  ~ ${entry.project} ${was.snapshot?.version ?? "absent"} -> ${entry.entry.snapshot?.version ?? "absent"}`);
  }
  for (const project of Object.keys(before.bundles).sort(byCodePoint)) {
    if (!next.bundles[project]) lines.push(`  removed project ${project}`);
  }
  return lines;
}
