/**
 * Reproduce a recorded build from the task snapshot (#1182).
 *
 * The task snapshot names the four input hashes the task was planned against. The expected
 * report is the build record the producer kept; the actual report is the one a fresh build
 * wrote. Comparing them through the existing build-report comparison gives the explanation:
 * input, config, tool, and environment differences are `explained`, while outputs that differ
 * with every declared input equal are `unexplained` and are reported separately. A reproduction
 * is not a match unless the whole-output hash and the tool version both match.
 *
 * This module computes evidence; it never builds. The caller runs `build` and
 * `buildReportOf` and hands the two reports in, so a proof can be verified without trusting
 * the process that produced it.
 */
import type { TaskSnapshot } from "../contracts/task.ts";
import type { VerificationDifference, VerificationOutputs } from "../contracts/verification.ts";
import { canonicalJson, sha256 } from "../data/lock.ts";
import { compareBuildReports, type BuildReport } from "../reproduce/manifest.ts";

/** What {@link reproductionEvidence} needs. */
export interface ReproductionInput {
  /** The task snapshot the build was planned against. */
  readonly snapshot: TaskSnapshot;
  /** The report recorded with the task. */
  readonly expected: BuildReport;
  /** The report a fresh build produced. */
  readonly actual: BuildReport;
}

/** SHA-256 of the four input hashes, stable across machines. */
export function inputHashOf(snapshot: TaskSnapshot): string {
  return sha256(
    `mizzen-verification-input\0${canonicalJson({
      content: snapshot.content,
      data: snapshot.data,
      config: snapshot.config,
      tooling: snapshot.tooling,
    })}`,
  );
}

/** Every explained difference, flattened from the report comparison. */
function explainedDifferences(
  comparison: ReturnType<typeof compareBuildReports>,
): readonly VerificationDifference[] {
  const differences: VerificationDifference[] = [];
  for (const category of ["inputs", "config", "tools", "environment"] as const) {
    for (const difference of comparison.differences[category]) {
      differences.push({ category, ...difference });
    }
  }
  return differences;
}

/** The output differences, whether or not an input explains them. */
function outputDifferences(
  comparison: ReturnType<typeof compareBuildReports>,
): readonly VerificationDifference[] {
  return comparison.differences.outputs.map((difference) => ({ category: "outputs", ...difference }));
}

/**
 * Compares the recorded and reproduced reports. `unexplained` holds output differences with no
 * input, config, tool, or environment difference to account for them; `explained` holds the
 * differences that do explain a changed output.
 */
export function reproductionEvidence(input: ReproductionInput): VerificationOutputs {
  const comparison = compareBuildReports(input.expected, input.actual);
  const expectedHash = input.expected.outputs.hash;
  const actualHash = input.actual.outputs.hash;
  const expectedTool = input.expected.tools.mizzen;
  const actualTool = input.actual.tools.mizzen;
  const outputs = outputDifferences(comparison);
  return {
    inputHash: inputHashOf(input.snapshot),
    tool: { expected: expectedTool, actual: actualTool },
    expectedHash,
    actualHash,
    match: expectedHash === actualHash && expectedTool === actualTool,
    explained: explainedDifferences(comparison),
    unexplained: comparison.unexplained ? outputs : [],
  };
}
