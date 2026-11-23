import { ingestEvidence } from "../evidence/store.ts";

const usage = "Usage: mizzen evidence ingest <envelope.json> [dir] [--artifact <file>]";

export async function runEvidence(
  args: readonly string[],
  io: { readonly log: (message: string) => void; readonly error: (message: string) => void },
): Promise<number> {
  const [command, ...rest] = args;
  if (command === "help" || rest[0] === "--help" || rest[0] === "-h") {
    io.log(usage);
    return 0;
  }
  const paths: string[] = [];
  let artifact: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--artifact" && artifact === undefined && rest[i + 1] && !rest[i + 1]!.startsWith("-")) {
      artifact = rest[++i]!;
    } else if (!arg.startsWith("-")) {
      paths.push(arg);
    } else {
      io.error(usage);
      return 2;
    }
  }
  const [file, root = "."] = paths;
  if (command !== "ingest" || file === undefined || paths.length > 2) {
    io.error(usage);
    return 2;
  }
  try {
    io.log(await ingestEvidence(root, file, artifact));
    return 0;
  } catch (error) {
    io.error(`mizzen: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
