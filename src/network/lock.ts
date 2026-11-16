/**
 * `network.lock.json`: the pinned copy of the shared network file and of each public project's page list. A build reads
 * only this file. It is canonical (keys sorted, LF, one trailing newline) and holds no timestamp, so two updates on the
 * same input write the same bytes. It is validated against `schema/network-lock.schema.json` on every read.
 */
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import type { AnalyticsConfig } from "../contracts/config.ts";
import type { Diagnostic } from "../contracts/index.ts";
import { canonicalJson, sha256 } from "../data/lock.ts";

/** The lock file name at a site root. */
export const NETWORK_LOCK_FILE = "network.lock.json";

/** One page in a project's page list. */
export interface LockedPage {
  /** The page's URL below the project's base, such as `/guide/`. */
  readonly path: string;
  readonly title: string;
  /** SHA-256 of the page's rendered body, from the project's manifest. */
  readonly sha256: string;
  /** The hash before the latest update that changed it; absent for a page that did not change. */
  readonly previous?: string;
}

/** One project of the locked network. */
export interface LockedProject {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly public: boolean;
  readonly analytics?: AnalyticsConfig;
  /** Folder of the search index below the project's path, when the network file names one. */
  readonly search?: string;
  /** The page list as fetched; present for a public project only. */
  readonly manifest?: {
    readonly url: string;
    readonly sha256: string;
    readonly pages: readonly LockedPage[];
  };
}

/** The whole lock file. */
export interface NetworkLock {
  readonly version: 1;
  /** The network file's address as the config writes it. */
  readonly source: string;
  /** SHA-256 of the network file's bytes. */
  readonly sha256: string;
  readonly projects: readonly LockedProject[];
}

const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;
const schema = JSON.parse(readFileSync(new URL("../../schema/network-lock.schema.json", import.meta.url), "utf8")) as object;
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The lock's text: canonical JSON, pages sorted by path, and one trailing line feed. */
export function networkLockText(lock: NetworkLock): string {
  const projects = lock.projects.map((project) =>
    project.manifest === undefined
      ? project
      : { ...project, manifest: { ...project.manifest, pages: [...project.manifest.pages].sort((a, b) => byCodePoint(a.path, b.path)) } },
  );
  return `${canonicalJson({ ...lock, projects })}\n`;
}

/** SHA-256 of the lock file's text: the lock's identity in the cache key and the build. */
export function networkLockHash(lock: NetworkLock): string {
  return sha256(networkLockText(lock));
}

/** What {@link readNetworkLock} found. */
export interface NetworkLockRead {
  /** The lock; `undefined` when the file is missing or invalid. */
  readonly lock?: NetworkLock;
  /** SHA-256 of the file's bytes, when it was read. */
  readonly hash?: string;
  readonly diagnostics: readonly Diagnostic[];
}

/** Reads and validates the lock at `root`. A missing file is an error naming `mizzen network update`. */
export async function readNetworkLock(root: string): Promise<NetworkLockRead> {
  let text: string;
  try {
    text = await readFile(join(root, NETWORK_LOCK_FILE), "utf8");
  } catch {
    return {
      diagnostics: [{
        id: "network.lock-missing",
        severity: "error",
        message: `${NETWORK_LOCK_FILE} does not exist, and the site config has a \`network\` key.`,
        help: "Run `mizzen network update` to write it, then commit it.",
      }],
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return {
      diagnostics: [{
        id: "network.lock-invalid",
        severity: "error",
        message: `${NETWORK_LOCK_FILE} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        help: "Run `mizzen network update` to write it again.",
      }],
    };
  }
  if (!validate(value)) {
    return {
      diagnostics: [{
        id: "network.lock-invalid",
        severity: "error",
        message: `${NETWORK_LOCK_FILE} does not match schema/network-lock.schema.json.`,
        help: "Run `mizzen network update` to write it again.",
      }],
    };
  }
  return { lock: value as NetworkLock, hash: sha256(text), diagnostics: [] };
}

/** Writes the lock at `root`. */
export async function writeNetworkLock(root: string, lock: NetworkLock): Promise<void> {
  await writeFile(join(root, NETWORK_LOCK_FILE), networkLockText(lock));
}

/**
 * What changed between two locks, one line per change, in project order: `new`, `removed`, `changed` for a project
 * whose title, path, visibility, or settings differ, and for each page `+`, `-`, or `~` under its project.
 * An unchanged lock gives no lines.
 */
export function diffLocks(before: NetworkLock | undefined, after: NetworkLock): readonly string[] {
  const lines: string[] = [];
  if (before === undefined) {
    lines.push(`new lock for ${after.source}`);
  } else if (before.sha256 !== after.sha256) {
    lines.push(`network file changed (${before.sha256.slice(0, 8)} -> ${after.sha256.slice(0, 8)})`);
  }
  const old = new Map((before?.projects ?? []).map((project) => [project.id, project]));
  const seen = new Set<string>();
  for (const project of after.projects) {
    seen.add(project.id);
    const was = old.get(project.id);
    if (was === undefined) {
      lines.push(`new project ${project.id}`);
    } else if (canonicalJson({ ...was, manifest: undefined }) !== canonicalJson({ ...project, manifest: undefined })) {
      lines.push(`changed project ${project.id}`);
    }
    const oldPages = new Map((was?.manifest?.pages ?? []).map((page) => [page.path, page]));
    const newPages = new Map((project.manifest?.pages ?? []).map((page) => [page.path, page]));
    for (const [path, page] of [...newPages].sort((a, b) => byCodePoint(a[0], b[0]))) {
      const before = oldPages.get(path);
      if (was?.manifest === undefined && before === undefined) continue;
      if (before === undefined) lines.push(`  + ${project.id}:${path}`);
      else if (before.sha256 !== page.sha256) lines.push(`  ~ ${project.id}:${path}`);
    }
    for (const path of [...oldPages.keys()].sort(byCodePoint)) {
      if (!newPages.has(path) && project.manifest !== undefined) lines.push(`  - ${project.id}:${path}`);
    }
    if (was?.manifest === undefined && project.manifest !== undefined) {
      lines.push(`  ${project.manifest.pages.length} page${project.manifest.pages.length === 1 ? "" : "s"} listed for ${project.id}`);
    }
  }
  for (const id of old.keys()) {
    if (!seen.has(id)) lines.push(`removed project ${id}`);
  }
  return lines;
}
