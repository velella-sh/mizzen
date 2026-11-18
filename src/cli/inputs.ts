/**
 * `mizzen inputs export|inspect|verify|import`: carries a site's locked data inputs between environments.
 *
 * - `export [dir] [--collections <a,b>] [--out <file>]` writes one deterministic package of the selected collection
 *   sources and the lock entries they need.
 * - `inspect <file> [--json]` reports the format, package hash, and each input's source, size, and hash.
 * - `verify <file>` checks every hash and that no undeclared bytes follow, without writing.
 * - `import <file> [dir] [--accept <ids|all>]` installs the inputs and merges the lock; a conflict changes nothing until
 *   its inputs are accepted by name.
 *
 * Arguments are parsed here, not in `index.ts`. The command never opens a network connection.
 */
import { resolve } from "node:path";
import { loadConfig } from "../config/load.ts";
import type { Diagnostic } from "../contracts/index.ts";
import { exportInputs } from "../inputs/export.ts";
import { importInputs } from "../inputs/install.ts";
import { inspectPackage, inspectionText } from "../inputs/inspect.ts";
import { verifyPackage } from "../inputs/verify.ts";

/** Where the command prints. */
export interface InputsIo {
  readonly log: (message: string) => void;
  readonly error: (message: string) => void;
}

export const inputsUsage = `Usage: mizzen inputs export [dir] [--collections <a,b>] [--out <file>]
       mizzen inputs inspect <file> [--json]
       mizzen inputs verify <file>
       mizzen inputs import <file> [dir] [--accept <ids|all>]

  export   Write the selected collection sources and their lock entries to one package
  inspect  Print a package's format, inputs, sizes, and hashes; changes nothing
  verify   Check a package's hashes and size; changes nothing
  import   Install a package into a site's files and mizzen.lock.json

Options:
  --collections <a,b>  Collections to carry; their references targets are added (default: every collection)
  --out <file>         Package to write (default: inputs.mizzenpack, from the current folder)
  --accept <ids|all>   Inputs whose differing destination files or lock entries may be replaced
  --json               For inspect: print the report as JSON
  -h, --help           Show this help
`;

function report(diagnostics: readonly Diagnostic[], error: (message: string) => void): void {
  for (const diagnostic of diagnostics) {
    error(`${diagnostic.id}: ${diagnostic.message}`);
    if (diagnostic.help !== undefined) error(`  ${diagnostic.help}`);
  }
}

function fail(message: string, error: (message: string) => void): number {
  error(`mizzen: ${message}`);
  error(inputsUsage);
  return 2;
}

/** Splits a comma-separated option, trimming and dropping empty parts. */
function listOf(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

async function runExport(args: readonly string[], io: InputsIo): Promise<number> {
  let root: string | undefined;
  let out = "inputs.mizzenpack";
  const collections: string[] = [];
  let sawCollections = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "-h" || arg === "--help") {
      io.log(inputsUsage);
      return 0;
    }
    if (arg === "--collections" || arg === "--out") {
      const value = args[++index];
      if (value === undefined || value.startsWith("-") || value.trim() === "") {
        return fail(`${arg} needs a value`, io.error);
      }
      if (arg === "--out") out = value;
      else {
        sawCollections = true;
        for (const name of listOf(value)) if (!collections.includes(name)) collections.push(name);
      }
    } else if (arg.startsWith("-")) {
      return fail(`unknown option for inputs export: ${arg}`, io.error);
    } else if (root === undefined) {
      root = arg;
    } else {
      return fail(`unexpected argument: ${arg}`, io.error);
    }
  }
  if (sawCollections && collections.length === 0) {
    return fail("--collections needs at least one collection name", io.error);
  }

  const target = resolve(root ?? ".");
  const loaded = loadConfig(target);
  const configErrors = loaded.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (configErrors.length > 0) {
    report(configErrors, io.error);
    return 1;
  }
  const result = await exportInputs({
    root: target,
    config: loaded.config,
    ...(collections.length === 0 ? {} : { collections }),
    out: resolve(out),
  });
  for (const message of result.messages) io.log(message);
  report(result.diagnostics, io.error);
  return result.code;
}

async function runInspect(args: readonly string[], io: InputsIo): Promise<number> {
  let file: string | undefined;
  let json = false;
  for (const arg of args) {
    if (arg === "-h" || arg === "--help") {
      io.log(inputsUsage);
      return 0;
    }
    if (arg === "--json") json = true;
    else if (arg.startsWith("-")) return fail(`unknown option for inputs inspect: ${arg}`, io.error);
    else if (file === undefined) file = arg;
    else return fail(`unexpected argument: ${arg}`, io.error);
  }
  if (file === undefined) return fail("inputs inspect needs a package file", io.error);
  const result = await inspectPackage({ file: resolve(file) });
  if (result.inspection === undefined) {
    report(result.diagnostics, io.error);
    return result.code;
  }
  io.log(
    json
      ? JSON.stringify(result.inspection, null, 2)
      : inspectionText(result.inspection),
  );
  return result.code;
}

async function runVerify(args: readonly string[], io: InputsIo): Promise<number> {
  let file: string | undefined;
  for (const arg of args) {
    if (arg === "-h" || arg === "--help") {
      io.log(inputsUsage);
      return 0;
    }
    if (arg.startsWith("-")) return fail(`unknown option for inputs verify: ${arg}`, io.error);
    else if (file === undefined) file = arg;
    else return fail(`unexpected argument: ${arg}`, io.error);
  }
  if (file === undefined) return fail("inputs verify needs a package file", io.error);
  const result = await verifyPackage({ file: resolve(file) });
  if (result.code !== 0) {
    report(result.diagnostics, io.error);
    return result.code;
  }
  io.log(`ok: ${file} holds ${result.inputs?.length ?? 0} inputs, sha256 ${result.sha256 ?? ""}`);
  return 0;
}

async function runImport(args: readonly string[], io: InputsIo): Promise<number> {
  let file: string | undefined;
  let root: string | undefined;
  let accept: string[] | "all" | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "-h" || arg === "--help") {
      io.log(inputsUsage);
      return 0;
    }
    if (arg === "--accept") {
      const value = args[++index];
      if (value === undefined || value.startsWith("-") || value.trim() === "") {
        return fail("--accept needs input ids or all", io.error);
      }
      accept = value === "all" ? "all" : listOf(value);
      if (accept !== "all" && accept.length === 0) return fail("--accept needs input ids or all", io.error);
    } else if (arg.startsWith("-")) {
      return fail(`unknown option for inputs import: ${arg}`, io.error);
    } else if (file === undefined) file = arg;
    else if (root === undefined) root = arg;
    else return fail(`unexpected argument: ${arg}`, io.error);
  }
  if (file === undefined) return fail("inputs import needs a package file", io.error);
  const result = await importInputs({
    root: resolve(root ?? "."),
    file: resolve(file),
    ...(accept === undefined ? {} : { accept }),
  });
  for (const message of result.messages) io.log(message);
  report(result.diagnostics, io.error);
  return result.code;
}

/** Runs `mizzen inputs`; returns the exit code. */
export async function runInputs(args: readonly string[], io: InputsIo): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === undefined) return fail("inputs needs a subcommand: export, inspect, verify, or import", io.error);
  if (subcommand === "-h" || subcommand === "--help" || subcommand === "help") {
    io.log(inputsUsage);
    return 0;
  }
  if (subcommand === "export") return runExport(rest, io);
  if (subcommand === "inspect") return runInspect(rest, io);
  if (subcommand === "verify") return runVerify(rest, io);
  if (subcommand === "import") return runImport(rest, io);
  return fail(`unknown inputs subcommand: ${subcommand}`, io.error);
}
