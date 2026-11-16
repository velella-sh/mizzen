/**
 * Reads the locked network for a build. This is the only network unit a build imports: it reads `network.lock.json`
 * from disk and never fetches, so the build is offline and repeatable. Age is a warning only, and it reads the lock's
 * modification time, which no build output holds.
 */
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Diagnostic, NetworkConfig, SiteNetwork } from "../contracts/index.ts";
import { publicProjects } from "./visibility.ts";
import { NETWORK_LOCK_FILE, readNetworkLock, type LockedProject, type NetworkLock } from "./lock.ts";

/** Days after which a lock is reported as stale, when the config sets no `maxAgeDays`. */
export const DEFAULT_MAX_AGE_DAYS = 30;

/** What {@link loadLockedNetwork} returns. */
export interface LoadedNetwork {
  readonly lock?: NetworkLock;
  /** SHA-256 of the lock file's bytes. */
  readonly hash?: string;
  /** The lock's entry for this site's project. */
  readonly project?: LockedProject;
  /** What themes see: public projects only. */
  readonly site?: SiteNetwork;
  readonly diagnostics: readonly Diagnostic[];
}

/** The `Site.network` value of a lock: the public projects, in the network file's order. */
export function siteNetwork(lock: NetworkLock, current: string, hash: string): SiteNetwork {
  return {
    current,
    lock: hash,
    projects: publicProjects(lock.projects)
      .map((project) => ({
        id: project.id,
        path: project.path,
        title: project.title,
        current: project.id === current,
        ...(project.search === undefined ? {} : { search: project.search }),
      })),
  };
}

/** Loads and checks the lock for the site at `root`. `now` is injectable so a test controls the age. */
export async function loadLockedNetwork(
  root: string,
  network: NetworkConfig,
  now: () => number = Date.now,
): Promise<LoadedNetwork> {
  const read = await readNetworkLock(root);
  if (read.lock === undefined) return { diagnostics: read.diagnostics };
  const lock = read.lock;
  const diagnostics: Diagnostic[] = [];
  const project = lock.projects.find((candidate) => candidate.id === network.project);
  if (project === undefined) {
    diagnostics.push({
      id: "network.unknown-project",
      severity: "error",
      message: `The site config names the project "${network.project}", but ${NETWORK_LOCK_FILE} does not list it.`,
      help: `Use one of: ${lock.projects.map((p) => p.id).join(", ")}. Or run \`mizzen network update\` after the network file adds it.`,
    });
    return { lock, ...(read.hash === undefined ? {} : { hash: read.hash }), diagnostics };
  }
  const days = network.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  const modified = await stat(join(root, NETWORK_LOCK_FILE)).then((s) => s.mtimeMs, () => undefined);
  if (modified !== undefined && now() - modified > days * 86_400_000) {
    diagnostics.push({
      id: "network.lock-stale",
      severity: "warning",
      message: `${NETWORK_LOCK_FILE} is older than ${days} days.`,
      help: "Run `mizzen network update` and commit the result.",
    });
  }
  return {
    lock,
    ...(read.hash === undefined ? {} : { hash: read.hash }),
    project,
    site: siteNetwork(lock, network.project, read.hash ?? ""),
    diagnostics,
  };
}
