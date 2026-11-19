/**
 * The runner seam: the engine scores an agent result, and an adapter outside the engine produces it.
 *
 * Nothing in this interface names a provider, a model SDK, an API key, a network call, or a clock.
 * A live adapter lives outside `src/` (`examples/evals/`), reads its own credentials, and returns
 * the same {@link EvalAgentOutput}; the deterministic reference adapter in `reference.ts` runs the
 * suite in CI without either.
 */
import type { EvalAgentOutput, EvalCase, EvalToolPin } from "../contracts/evals.ts";

/** What one adapter receives. The fixture is read-only; a write case works on a temporary copy. */
export interface EvalRunnerInput {
  readonly case: EvalCase;
  /** The absolute fixture folder, inside the suite's tree. */
  readonly fixtureRoot: string;
  /** The absolute folder holding `suite.json`. */
  readonly suiteRoot: string;
}

/** One adapter that turns a case into an agent result. */
export interface EvalRunner {
  /** Stable adapter id, such as `reference` or `live-openai`. */
  readonly id: string;
  /** The adapter version; a suite can pin it and an old result stays comparable only with it. */
  readonly version: string;
  /** The model the adapter used, when it used one. */
  readonly model?: string;
  /** The tool versions the adapter provides, checked against the suite's pins. */
  readonly tools: readonly EvalToolPin[];
  run(input: EvalRunnerInput): Promise<EvalAgentOutput>;
}
