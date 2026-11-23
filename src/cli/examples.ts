import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { EXAMPLES_LOCK_FILE, validRunCommit, validRunDate } from "../examples/pinned.ts";
import { buildModel } from "../model/build.ts";
import { recordExamples } from "../outputs/examples-report.ts";
import { loadCodeConfig, runModelHooks } from "../plugins/hooks.ts";
import { formatText } from "../pipeline/diagnostics.ts";
import { applyVersionRouting } from "../versions/apply.ts";

/** Run examples explicitly and replace the lock in one rename. No theme is loaded. */
export async function runExamplesRecord(
  args: readonly string[],
  io: { readonly log: (message: string) => void; readonly error: (message: string) => void },
): Promise<number> {
  if (args[0] !== "record") throw new Error("Usage: mizzen examples record [dir] --date YYYY-MM-DD --commit <full SHA>");
  const { positionals, values: { date, commit } } = parseArgs({
    args: args.slice(1),
    allowPositionals: true,
    options: { date: { type: "string" }, commit: { type: "string" } },
  });
  if (positionals.length > 1) throw new Error("examples record takes one site directory.");
  if (date === undefined || !validRunDate(date)) throw new Error("examples record needs --date YYYY-MM-DD.");
  if (commit === undefined || !validRunCommit(commit)) throw new Error("examples record needs --commit with a full lowercase Git commit ID.");

  const root = resolve(positionals[0] ?? ".");
  const code = await loadCodeConfig(root);
  const model = await buildModel(root, { plugins: code.plugins });
  if (model.site.config.examples?.pinned !== true) throw new Error("Set examples.pinned to true in mizzen.yml before recording.");
  const hooked = await runModelHooks(code.plugins, model.site);
  const { pages, diagnostics: routing } = applyVersionRouting(hooked.value.pages, hooked.value.data.versions, hooked.value.config.base);
  const diagnostics = [...code.diagnostics, ...model.diagnostics, ...hooked.diagnostics, ...routing];
  if (diagnostics.some(({ severity }) => severity === "error")) {
    io.error(formatText(diagnostics).trimEnd());
    return 1;
  }
  const lock = await recordExamples({ ...hooked.value, pages }, { date, commit }, (finding) => diagnostics.push(finding));
  const staging = await mkdtemp(join(root, ".mizzen-examples-"));
  try {
    const file = join(staging, EXAMPLES_LOCK_FILE);
    await writeFile(file, `${JSON.stringify(lock, null, 2)}\n`);
    await rename(file, join(root, EXAMPLES_LOCK_FILE));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }

  if (diagnostics.length > 0) io.error(formatText(diagnostics).trimEnd());
  const results = Object.values(lock.examples).flatMap((entries) => Object.values(entries));
  const unavailable = results.some(({ status }) => status === "sandbox-unavailable");
  if (unavailable) io.error("Examples were skipped because the host has no OS sandbox. Record on macOS with sandbox-exec or Linux with bwrap.");
  io.log(`Recorded ${results.length} example result(s) in ${EXAMPLES_LOCK_FILE}.`);
  return unavailable || results.some(({ status }) => status === "failed") ? 1 : 0;
}
