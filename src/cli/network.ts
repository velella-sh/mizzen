/**
 * `mizzen network check <file>`, `mizzen network update [dir]`, and `mizzen network sitemap <dir>`: the commands of the
 * shared network. `check` reads one local file. `update` is the only command that fetches the network, and it writes
 * `network.lock.json`; a build reads only that lock. `sitemap` writes the organization site's sitemap index.
 */
import { resolve } from "node:path";
import type { AccessGrant, AccessPolicy } from "../contracts/permissions.ts";
import { readAccessPolicyFile } from "../permissions/file.ts";
import { gatedFetch, type GatedFetch } from "../permissions/network.ts";
import { checkNetworkFile } from "../network/check.ts";
import type { NetworkFetchLike } from "../network/fetch.ts";
import { writeNetworkSitemap } from "../network/sitemap.ts";
import { updateNetwork } from "../network/update.ts";

/** What the network commands print through. */
export interface NetworkIo {
  readonly log: (message: string) => void;
  readonly error: (message: string) => void;
  /** The fetcher `update` uses; defaults to the global `fetch`. */
  readonly fetch?: NetworkFetchLike;
  /** The access policy `update` is held to; absent means the command's historical behavior. */
  readonly access?: AccessPolicy;
  /** Approvals for the network stage, when the policy requires one. */
  readonly approvals?: readonly AccessGrant[];
  /** The input snapshot approvals were made under; defaults to `network` for a manual update. */
  readonly snapshot?: string;
}

/** The help text of the `network` command. */
export const networkUsage = `Usage: mizzen network <subcommand> [options]

Subcommands:
  check <file>              Check a local network file: ids, paths, titles
  update [dir]              Fetch the network file and each public project's page list, and write network.lock.json
  sitemap [dir|lock] --url <origin> --out <dir>
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
  const tail: string[] = [];
  let access = io.access;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--policy") {
      const file = rest[++i];
      if (file === undefined) {
        io.error("mizzen: --policy needs a file");
        return 2;
      }
      const loaded = await readAccessPolicyFile(file);
      if (loaded.policy === undefined) {
        for (const problem of loaded.problems) io.error(`mizzen: ${problem}`);
        return 2;
      }
      access = loaded.policy;
    } else {
      tail.push(arg);
    }
  }
  const gated: NetworkFetchLike =
    access === undefined
      ? (io.fetch ?? ((url, init) => fetch(url, init)))
      : (gatedFetch(
          {
            policy: access,
            task: access.task,
            snapshot: io.snapshot ?? "network",
            stage: "verify",
            ...(io.approvals === undefined ? {} : { approvals: io.approvals }),
          },
          io.fetch ?? ((url, init) => fetch(url, init)),
        ) as GatedFetch);

  if (subcommand === "check") {
    const files = tail.filter((arg) => !arg.startsWith("-"));
    const flags = tail.filter((arg) => arg.startsWith("-"));
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
    const flags = tail.filter((arg) => arg.startsWith("-"));
    const unknown = flags.find((flag) => flag !== "--check" && flag !== "--accept");
    if (unknown !== undefined) {
      io.error(`mizzen: unknown option: ${unknown}`);
      return 2;
    }
    const dirs = tail.filter((arg) => !arg.startsWith("-"));
    if (dirs.length > 1) {
      io.error("mizzen: network update takes at most one folder");
      return 2;
    }
    const result = await updateNetwork({
      root: resolve(dirs[0] ?? "."),
      fetch: gated,
      check: flags.includes("--check"),
      accept: flags.includes("--accept"),
    });
    for (const line of result.lines) io.log(line);
    for (const line of result.errors) io.error(line);
    return result.code;
  }
  if (subcommand === "sitemap") {
    let url: string | undefined;
    let out = ".";
    const inputs: string[] = [];
    for (let i = 0; i < tail.length; i++) {
      const arg = tail[i]!;
      if (arg === "--url" || arg === "--out") {
        const value = tail[++i];
        if (value === undefined) {
          io.error(`mizzen: ${arg} needs a value`);
          return 2;
        }
        if (arg === "--url") url = value;
        else out = value;
      } else if (arg.startsWith("-")) {
        io.error(`mizzen: unknown option: ${arg}`);
        return 2;
      } else inputs.push(arg);
    }
    if (inputs.length > 1) {
      io.error("mizzen: network sitemap takes one folder or lock file");
      return 2;
    }
    const result = await writeNetworkSitemap({ input: resolve(inputs[0] ?? "."), url, out: resolve(out) });
    for (const line of result.lines) io.log(line);
    for (const line of result.errors) io.error(line);
    return result.code;
  }
  io.error(`mizzen: unknown network subcommand: ${subcommand}`);
  return 2;
}
