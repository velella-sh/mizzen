import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Diagnostic } from "../contracts/diagnostic.ts";
import {
  checkEnvironment,
  canonicalEnvironment,
  EXAMPLES_ENV_FILE,
  exampleUnlocked,
  environmentHash,
  readExamplesEnvironment,
  type EnvironmentCheck,
} from "../examples/environment.ts";
import { buildHostEnvironment } from "../examples/host-environment.ts";
import { EXAMPLES_LOCK_FILE, validRunCommit, validRunDate } from "../examples/pinned.ts";
import { buildModel } from "../model/build.ts";
import { recordExecutableExamples, recordExamples } from "../outputs/examples-report.ts";
import { exampleCache, exampleCacheDirOf } from "../pipeline/examples/cache.ts";
import { loadCodeConfig, runModelHooks } from "../plugins/hooks.ts";
import { formatText } from "../pipeline/diagnostics.ts";
import { applyVersionRouting } from "../versions/apply.ts";

/** The usage line the command prints for an unknown subcommand. */
const USAGE = [
  "Usage:",
  "  mizzen examples lock [dir]                                  Record .mizzen-env.json (runtime, packages, fixtures, limits)",
  "  mizzen examples record [dir] --date YYYY-MM-DD --commit <sha> [--no-lock]",
].join("\n");

/** The limits a run uses: the config's, over the defaults. */
function limitsOf(examples: { readonly timeoutMs?: number; readonly memoryMb?: number; readonly network?: "deny" | "allow" } | undefined) {
  return {
    timeoutMs: examples?.timeoutMs ?? 10_000,
    memoryMb: examples?.memoryMb ?? 0,
    network: examples?.network ?? "deny",
  };
}

/** Writes a file at the site root atomically: one staging folder, then one rename. */
async function writeAtomic(root: string, name: string, contents: string): Promise<void> {
  const staging = await mkdtemp(join(root, `.mizzen-write-`));
  try {
    const file = join(staging, name);
    await writeFile(file, contents);
    await rename(file, join(root, name));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** `mizzen examples lock [dir]`: record the host environment, or fail when the existing lock does not match. */
async function runExamplesLock(
  args: readonly string[],
  io: { readonly log: (message: string) => void; readonly error: (message: string) => void },
): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      check: { type: "boolean", default: false },
      network: { type: "string" },
      "timeout-ms": { type: "string" },
      "memory-mb": { type: "string" },
    },
  });
  if (positionals.length > 1) throw new Error("examples lock takes one site directory.");
  const root = resolve(positionals[0] ?? ".");
  const model = await buildModel(root);
  if (model.diagnostics.some(({ severity }) => severity === "error")) {
    io.error(formatText(model.diagnostics).trimEnd());
    return 1;
  }
  const settings = model.site.config.examples;
  const limits = limitsOf(settings);
  const host = await buildHostEnvironment({
    root,
    sourceDir: resolve(root, model.site.config.source),
    limits: {
      timeoutMs: values["timeout-ms"] === undefined ? limits.timeoutMs : Number(values["timeout-ms"]),
      memoryMb: values["memory-mb"] === undefined ? limits.memoryMb : Number(values["memory-mb"]),
      network: values.network === "allow" ? "allow" : limits.network,
      shell: "bash",
    },
  });

  if (values.check) {
    const check = await checkEnvironment(root, host);
    if (check.state === "locked") {
      io.log(`The example environment matches ${EXAMPLES_ENV_FILE}.`);
      return 0;
    }
    io.error(formatText([exampleUnlocked(check)]).trimEnd());
    return 1;
  }

  const existing = await readExamplesEnvironment(root).catch(() => undefined);
  const hash = environmentHash(host);
  await writeAtomic(root, EXAMPLES_ENV_FILE, canonicalEnvironment(host));
  io.log(`${existing === undefined ? "Wrote" : "Updated"} ${EXAMPLES_ENV_FILE} (${hash.slice(0, 12)}): ${host.packages.length} package(s), ${host.fixtures.length} fixture(s).`);
  return 0;
}

/** `mizzen examples record [dir] --date ... --commit ...`: run the fences and write `.mizzen-examples.json`. */
async function runExamplesRecordCommand(
  args: readonly string[],
  io: { readonly log: (message: string) => void; readonly error: (message: string) => void },
): Promise<number> {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    options: {
      date: { type: "string" },
      commit: { type: "string" },
      "no-lock": { type: "boolean", default: false },
    },
  });
  const positionals = parsed.positionals;
  const { date, commit } = parsed.values;
  if (positionals.length > 1) throw new Error("examples record takes one site directory.");
  if (date === undefined || !validRunDate(date)) throw new Error("examples record needs --date YYYY-MM-DD.");
  if (commit === undefined || !validRunCommit(commit)) throw new Error("examples record needs --commit with a full lowercase Git commit ID.");

  const root = resolve(positionals[0] ?? ".");
  const code = await loadCodeConfig(root);
  const model = await buildModel(root, { plugins: code.plugins });
  const pinned = model.site.config.examples?.pinned === true;
  const execute = model.site.config.examples?.execute === true;
  if (!pinned && !execute) throw new Error("Set examples.pinned or examples.execute to true in mizzen.yml before recording.");
  const noLock = parsed.values["no-lock"] === true;
  const hooked = await runModelHooks(code.plugins, model.site);
  const { pages, diagnostics: routing } = applyVersionRouting(hooked.value.pages, hooked.value.data.versions, hooked.value.config.base);
  const diagnostics: Diagnostic[] = [...code.diagnostics, ...model.diagnostics, ...hooked.diagnostics, ...routing];
  if (diagnostics.some(({ severity }) => severity === "error")) {
    io.error(formatText(diagnostics).trimEnd());
    return 1;
  }
  const site = { ...hooked.value, pages };

  const limits = limitsOf(site.config.examples);
  // The lock is enforced by default only for the opt-in executable path (`execute`); a legacy pinned recording keeps
  // working without one. `examples.lock` may still turn it on or off explicitly.
  const enforceLock = site.config.examples?.lock ?? execute;
  let environment: string | undefined;
  if (!noLock && enforceLock) {
    const host = await buildHostEnvironment({ root, sourceDir: resolve(root, site.config.source), limits: { ...limits, shell: "bash" } });
    const check: EnvironmentCheck = await checkEnvironment(root, host);
    if (check.state !== "locked") {
      io.error(formatText([exampleUnlocked(check)]).trimEnd());
      return 1;
    }
    environment = environmentHash(check.environment!);
  } else {
    const locked = await readExamplesEnvironment(root).catch(() => undefined);
    if (locked !== undefined) environment = environmentHash(locked);
  }

  const allowlist = site.config.examples?.allowlist ?? [];
  const cacheValue = process.env.MIZZEN_EXAMPLES_CACHE;
  const cache = cacheValue === undefined || cacheValue.trim() === ""
    ? undefined
    : exampleCache({ dir: cacheValue === "1" || cacheValue.toLowerCase() === "true" ? exampleCacheDirOf(root) : cacheValue });
  const report = (finding: Diagnostic): void => {
    diagnostics.push(finding);
  };

  const lock = pinned && !execute
    ? await recordExamples(site, { date, commit }, report)
    : await recordExecutableExamples({
        site,
        root,
        sourceDir: resolve(root, site.config.source),
        provenance: { date, commit },
        ...(environment === undefined ? {} : { environment }),
        limits,
        allowlist,
        ...(cache === undefined ? {} : { cache }),
        failOnFailure: site.config.examples?.failOnFailure === true,
        report,
      });

  await writeAtomic(root, EXAMPLES_LOCK_FILE, `${JSON.stringify(lock, null, 2)}\n`);

  if (diagnostics.length > 0) io.error(formatText(diagnostics).trimEnd());
  const results = Object.values(lock.examples).flatMap((entries) => Object.values(entries));
  const unavailable = results.some(({ status }) => status === "sandbox-unavailable");
  if (unavailable) io.error("Examples were skipped because the host has no OS sandbox. Record on macOS with sandbox-exec or Linux with bwrap.");
  io.log(`Recorded ${results.length} example result(s) in ${EXAMPLES_LOCK_FILE}.`);
  return unavailable || results.some(({ status }) => status === "failed") ? 1 : 0;
}

/** Dispatch the `examples` subcommands. No theme is loaded. */
export async function runExamples(
  args: readonly string[],
  io: { readonly log: (message: string) => void; readonly error: (message: string) => void },
): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "lock") return runExamplesLock(rest, io);
  if (subcommand === "record") return runExamplesRecordCommand(rest, io);
  throw new Error(USAGE);
}

/** Run examples explicitly and replace the lock in one rename. Kept for callers that pass the subcommand first. */
export async function runExamplesRecord(
  args: readonly string[],
  io: { readonly log: (message: string) => void; readonly error: (message: string) => void },
): Promise<number> {
  return runExamples(args, io);
}
