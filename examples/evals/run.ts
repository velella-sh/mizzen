/**
 * Runs one suite with the live adapter and writes the report.
 *
 * `node examples/evals/run.ts fixtures/evals live-report.json` with `MIZZEN_EVAL_AGENT` set to a
 * program that reads the request on stdin and writes an `EvalAgentOutput` on stdout. Without that
 * variable the run exits 2 and writes nothing; the default test suite and CI never call this file.
 */
import { writeFile } from "node:fs/promises";
import { runEvalSuite } from "../../src/evals/index.ts";
import { liveRunner } from "./live-runner.ts";

const suite = process.argv[2] ?? "fixtures/evals";
const out = process.argv[3] ?? "evals-report.json";

try {
  const model = process.env["MIZZEN_EVAL_MODEL"];
  const { report } = await runEvalSuite({ suite }, liveRunner(model === undefined ? {} : { model }));
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stderr.write(
    `${report.totals.passed} passed, ${report.totals.failed} failed, ${report.totals.invalid} invalid, ${report.totals.unavailable} unavailable; ${out}\n`,
  );
  process.exitCode = report.gate.passed ? 0 : 1;
} catch (error) {
  process.stderr.write(`mizzen live evals: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
