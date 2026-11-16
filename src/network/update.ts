/** `mizzen network update`: fetches the network and writes (or compares) `network.lock.json`. */
import { loadConfig } from "../config/load.ts";
import { fetchNetwork, type NetworkFetchLike } from "./fetch.ts";
import { formatProblem } from "./check.ts";
import { diffLocks, networkLockText, NETWORK_LOCK_FILE, readNetworkLock, writeNetworkLock } from "./lock.ts";

/** What {@link updateNetwork} returns: an exit code and the lines to print. */
export interface UpdateResult {
  readonly code: 0 | 1 | 2;
  readonly lines: readonly string[];
  readonly errors: readonly string[];
}

/**
 * Fetches the network named by the site config and writes the lock. With `check`, writes nothing and returns 1 when the
 * lock would change. With `accept`, the "changed" marks of earlier updates are cleared.
 */
export async function updateNetwork(options: {
  readonly root: string;
  readonly fetch: NetworkFetchLike;
  readonly check?: boolean;
  readonly accept?: boolean;
}): Promise<UpdateResult> {
  const { config, diagnostics } = loadConfig(options.root);
  const bad = diagnostics.filter((d) => d.severity === "error");
  if (bad.length > 0) return { code: 1, lines: [], errors: bad.map((d) => `${d.id}: ${d.message}`) };
  if (config.network === undefined) {
    return { code: 2, lines: [], errors: ["mizzen.yml has no `network` key. Add `network: { source, project }` first."] };
  }
  const existing = await readNetworkLock(options.root);
  const fetched = await fetchNetwork({
    source: config.network.source,
    project: config.network.project,
    root: options.root,
    fetch: options.fetch,
    ...(existing.lock === undefined ? {} : { previous: existing.lock }),
    ...(options.accept === true ? { accept: true } : {}),
  });
  if (fetched.lock === undefined) {
    return { code: 1, lines: [], errors: [...fetched.problems.map((p) => formatProblem(config.network!.source, p)), ...fetched.errors] };
  }
  const diff = diffLocks(existing.lock, fetched.lock);
  const same = existing.lock !== undefined && networkLockText(existing.lock) === networkLockText(fetched.lock);
  if (options.check === true) {
    return same
      ? { code: 0, lines: [`${NETWORK_LOCK_FILE} is up to date`], errors: [] }
      : { code: 1, lines: diff, errors: [`${NETWORK_LOCK_FILE} is out of date. Run \`mizzen network update\`.`] };
  }
  if (same) return { code: 0, lines: [`${NETWORK_LOCK_FILE} is up to date`], errors: [] };
  await writeNetworkLock(options.root, fetched.lock);
  return { code: 0, lines: [...diff, `wrote ${NETWORK_LOCK_FILE}`], errors: [] };
}
