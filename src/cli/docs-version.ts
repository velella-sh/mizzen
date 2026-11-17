/**
 * `mizzen versions snapshot <version> [dir] [--dry-run]`: freeze the current docs and navigation into a new version
 * folder (#597).
 *
 * The command prints the files the snapshot records, in the order the snapshot writes them. `--dry-run` prints the same
 * list and writes nothing. A refused snapshot (an invalid name, an existing folder, or a version that is not newer)
 * prints the reason and writes nothing; the exit code is 1. A usage problem is 2.
 */
import { resolve } from "node:path";
import { createSnapshot, SnapshotError, type SnapshotResult } from "../versions/snapshot.ts";

/** Where the command prints. */
export interface DocsVersionIo {
  readonly log: (message: string) => void;
  readonly error: (message: string) => void;
}

export const docsVersionUsage = `Usage: mizzen versions snapshot <version> [dir] [--dry-run]

  snapshot   Copy the current pages and navigation into a new version folder

Options:
  --dry-run   Print the files the snapshot would write, and write nothing
  -h, --help  Show this help
`;

/** Parsed `versions snapshot` arguments. */
interface SnapshotArgs {
  readonly root: string;
  readonly version: string;
  readonly dryRun: boolean;
}

function parseSnapshot(args: readonly string[]): SnapshotArgs | { readonly error: string } {
  const positional: string[] = [];
  let dryRun = false;
  for (const arg of args) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg.startsWith("-")) return { error: `unknown option: ${arg}` };
    else positional.push(arg);
  }
  const [version, root, extra] = positional;
  if (version === undefined) return { error: "versions snapshot needs a version name, such as v2" };
  if (extra !== undefined) return { error: `unexpected argument: ${extra}` };
  return { version, root: resolve(root ?? "."), dryRun };
}

/** Runs `mizzen versions <args>` and returns the exit code. */
export async function runDocsVersion(args: readonly string[], io: DocsVersionIo): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "-h" || subcommand === "--help" || subcommand === "help") {
    io.log(docsVersionUsage);
    return 0;
  }
  if (subcommand === "snapshot") return snapshot(rest, io);
  io.error(`mizzen: unknown versions command: ${subcommand ?? ""}\n\n${docsVersionUsage}`);
  return 2;
}

async function snapshot(args: readonly string[], io: DocsVersionIo): Promise<number> {
  if (args.includes("-h") || args.includes("--help")) {
    io.log(docsVersionUsage);
    return 0;
  }
  const parsed = parseSnapshot(args);
  if ("error" in parsed) {
    io.error(`mizzen: ${parsed.error}\n\n${docsVersionUsage}`);
    return 2;
  }

  let result: SnapshotResult;
  try {
    result = await createSnapshot({ root: parsed.root, version: parsed.version, dryRun: parsed.dryRun });
  } catch (error) {
    if (error instanceof SnapshotError) {
      io.error(`mizzen: ${error.message}`);
      return 1;
    }
    throw error;
  }

  const count = `${result.files.length} file${result.files.length === 1 ? "" : "s"}`;
  io.log(`${result.version}: ${parsed.dryRun ? `would write ${count} (dry run; nothing written)` : `wrote ${count}`}`);
  for (const file of result.files) io.log(`  ${result.version}/${file}`);
  return 0;
}
