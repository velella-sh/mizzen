/**
 * `mizzen references check <file|-> [dir]`: resolves a stored set of machine references against this build.
 *
 * The file holds one JSON array of `BlockReference` values (`{"version": 1, "page": "<source path>", "block": "<id>"}`);
 * `-` reads stdin. Each reference is answered in input order with `resolved` and the block's current URL, `removed`
 * when `blocks.lock.json` recorded the id but this build no longer has it, or `unknown` when the lock never saw it.
 * The command prints one JSON array of resolutions and exits 1 when any reference is not resolved, so a batch check
 * is one call. It builds the model, never the theme, like `mizzen pack`.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readBlocksLock } from "../blocks/lock.ts";
import { referenceProblem, resolveReferences } from "../blocks/reference.ts";
import type { BlockReference } from "../contracts/index.ts";
import { buildModel } from "../model/build.ts";
import { readStandardInput } from "./pack-request.ts";

/** Where the command prints. */
export interface ReferencesIo {
  readonly write: (message: string) => void;
  readonly error: (message: string) => void;
}

export const referencesUsage = `Usage: mizzen references check <file|-> [dir]

  check    Resolve stored references against the site's current build

  <file|->  A JSON array of references: {"version": 1, "page": "<source>", "block": "<id>"}
  [dir]     The site root (default: .)
`;

interface CheckArgs {
  readonly input: string;
  readonly root: string;
}

function parseCheck(args: readonly string[]): CheckArgs | { readonly error: string } {
  let input: string | undefined;
  let root = ".";
  for (const arg of args) {
    if (arg.startsWith("-") && arg !== "-") return { error: `unknown option: ${arg}` };
    if (input === undefined) input = arg;
    else if (root === ".") root = arg;
    else return { error: `unexpected argument: ${arg}` };
  }
  if (input === undefined) return { error: "references check needs a file, or - for stdin" };
  return { input, root };
}

/** A reference array, with the first problem named when the file is not one. */
function readReferences(text: string): readonly BlockReference[] | { readonly error: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return { error: `the references file is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!Array.isArray(value)) return { error: "the references file must hold a JSON array" };
  for (const [index, entry] of value.entries()) {
    const problem = referenceProblem(entry);
    if (problem !== undefined) return { error: `reference ${index + 1}: ${problem}` };
  }
  return value as readonly BlockReference[];
}

/** Runs `mizzen references`; returns the exit code. */
export async function runReferences(args: readonly string[], io: ReferencesIo): Promise<number> {
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    io.write(`${referencesUsage.replace(/\n$/, "")}\n`);
    return 0;
  }
  if (args[0] !== "check") {
    io.error(`mizzen: unknown references command: ${args[0]}\n\n${referencesUsage}`);
    return 2;
  }
  const parsed = parseCheck(args.slice(1));
  if ("error" in parsed) {
    io.error(`mizzen: ${parsed.error}\n\n${referencesUsage}`);
    return 2;
  }
  const text = parsed.input === "-" ? await readStandardInput() : await readFile(parsed.input, "utf8");
  const references = readReferences(text);
  if ("error" in references) {
    io.error(`mizzen: ${references.error}`);
    return 2;
  }
  const root = resolve(parsed.root);
  const { lock, diagnostics } = await readBlocksLock(root);
  for (const diagnostic of diagnostics) if (diagnostic.severity === "error") io.error(`${diagnostic.id}: ${diagnostic.message}`);
  const { site } = await buildModel(root);
  const resolutions = resolveReferences(references, { lock, pages: site.pages });
  io.write(`${JSON.stringify(resolutions, null, 2)}\n`);
  return resolutions.every((resolution) => resolution.status === "resolved") ? 0 : 1;
}
