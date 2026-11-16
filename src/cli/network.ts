/**
 * `mizzen network check <file>`, `mizzen network update [dir]`, and `mizzen network sitemap <dir>`: the commands of the
 * shared network. `check` reads one local file. `update` is the only command that fetches the network, and it writes
 * `network.lock.json`; a build reads only that lock. `sitemap` writes the organization site's sitemap index.
 */
import { resolve } from "node:path";
import { checkNetworkFile } from "../network/check.ts";
import type { NetworkFetchLike } from "../network/fetch.ts";
import { updateNetwork } from "../network/update.ts";

/** What the network commands print through. */
export interface NetworkIo {
  readonly log: (message: string) => void;
  readonly error: (message: string) => void;
  /** The fetcher `update` uses; defaults to the global `fetch`. */
  readonly fetch?: NetworkFetchLike;
}

/** The help text of the `network` command. */
export const networkUsage = `Usage: mizzen network <subcommand> [options]

Subcommands:
  check <file>              Check a local network file: ids, paths, titles
  update [dir]              Fetch the network file and each public project's page list, and write network.lock.json
  sitemap <network-lock-or-file> --url <origin> --out <dir>
                            Write one sitemap index that points to each public project's sitemap

Options:
  --check                   For update: compare with the lock without writing
  --accept                  For update: accept changed pages, clearing the "changed" marks in the lock
  --url <origin>            For sitemap: the organization site's origin, such as https://example.org
  --out <dir>               For sitemap: folder that receives sitemap.xml and robots.txt (default: .)

Exit codes: 0 ok, 1 problems, 2 usage.`;

/** Runs `mizzen network ...`. Returns the exit code. */
export async function runNetwork(args: readonly string[], io: NetworkIo): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === undefined || subcommand === "-h" || subcommand === "--help" || subcommand === "help") {
    io.log(networkUsage);
    return subcommand === undefined ? 2 : 0;
  }
  if (subcommand === "check") {
    const files = rest.filter((arg) => !arg.startsWith("-"));
    const flags = rest.filter((arg) => arg.startsWith("-"));
    if (flags.length > 0) {
      io.error(`mizzen: unknown option: ${flags[0]}`);
      return 2;
    }
    if (files.length !== 1) {
      io.error("mizzen: network check needs one file: mizzen network check <file>");
      return 2;
    }
    const result = await checkNetworkFile(files[0]!);
    if (result.code === 0) {
      io.log(`${files[0]}: ok, ${result.projects ?? 0} project${result.projects === 1 ? "" : "s"}`);
      return 0;
    }
    for (const line of result.lines) io.error(line);
    return result.code;
  }
  if (subcommand === "update") {
    const flags = rest.filter((arg) => arg.startsWith("-"));
    const unknown = flags.find((flag) => flag !== "--check" && flag !== "--accept");
    if (unknown !== undefined) {
      io.error(`mizzen: unknown option: ${unknown}`);
      return 2;
    }
    const dirs = rest.filter((arg) => !arg.startsWith("-"));
    if (dirs.length > 1) {
      io.error("mizzen: network update takes at most one folder");
      return 2;
    }
    const result = await updateNetwork({
      root: resolve(dirs[0] ?? "."),
      fetch: io.fetch ?? ((url, init) => fetch(url, init)),
      check: flags.includes("--check"),
      accept: flags.includes("--accept"),
    });
    for (const line of result.lines) io.log(line);
    for (const line of result.errors) io.error(line);
    return result.code;
  }
  io.error(`mizzen: unknown network subcommand: ${subcommand}`);
  return 2;
}
