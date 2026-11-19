/**
 * The deterministic reference adapter: the runner CI uses when no model may be called.
 *
 * It is not a model. For discovery, answer, edit, and permission cases it replays the recorded agent
 * output beside the suite; for context, transaction, verification, and handoff cases it drives the
 * engine's own compiler, transaction writer, independent verifier, and handoff reader on the case
 * fixture. Every path is local, every estimate is derived from bytes, and nothing reads a clock or
 * the network, so two runs against the same pins give the same report.
 *
 * A live model adapter implements the same {@link EvalRunner} interface outside `src/` (see
 * `examples/evals/`) and never enters the default test suite.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  EvalAccessAttempt,
  EvalAgentOutput,
  EvalCase,
  EvalVerificationOutput,
} from "../contracts/evals.ts";
import type { InteractionSession } from "../contracts/interaction.ts";
import { caseFacts, casePath } from "./pins.ts";
import { applyEditTransaction, parseEditTransaction, EditTransactionError } from "../edits/edit-transaction.ts";
import { resumeHandoff, applyInteractionEdit } from "../interaction/index.ts";
import { independentlyVerify } from "../verification/verify.ts";
import { parseVerificationProof } from "../verification/proof.ts";
import type { EvalRunner, EvalRunnerInput } from "./runner.ts";

/** The tool version every engine-backed reference capability reports. */
const TOOL_VERSION = "1";

/** A deterministic token estimate for text the engine produced. */
function estimate(text: string): number {
  return Math.ceil(text.length / 4);
}

/** One tool call. */
function call(name: string, ok = true): { name: string; version: string; ok: boolean } {
  return { name, version: TOOL_VERSION, ok };
}

/** The output shape a generated capability starts from. */
function emptyOutput(inputTokens: number, outputTokens: number): EvalAgentOutput {
  return {
    pages: [],
    symbols: [],
    toolCalls: [],
    usage: { inputTokens, outputTokens },
    trace: { toolCalls: 0, inputTokens, outputTokens },
  };
}

/** Reads a recorded agent output and checks the fields every capability shares. */
async function recorded(file: string): Promise<EvalAgentOutput> {
  const value = JSON.parse(await readFile(file, "utf8")) as EvalAgentOutput;
  if (
    !Array.isArray(value.pages) ||
    !Array.isArray(value.symbols) ||
    !Array.isArray(value.toolCalls) ||
    value.usage === undefined
  ) {
    throw new Error(`${file}: the recorded agent output needs pages, symbols, toolCalls, and usage.`);
  }
  return value;
}

/** The files a transaction changed, by comparing its patches' target hashes with the temp copy. */
async function changedFiles(root: string, files: readonly string[], before: ReadonlyMap<string, string>): Promise<string[]> {
  const changed: string[] = [];
  const { createHash } = await import("node:crypto");
  for (const file of files) {
    try {
      const hash = createHash("sha256").update(await readFile(join(root, file))).digest("hex");
      if (before.get(file) !== hash) changed.push(file);
    } catch {
      changed.push(file);
    }
  }
  return changed;
}

/** Runs one transaction case on a temporary copy, so the fixture is never written. */
async function transactionOutput(input: EvalRunnerInput): Promise<EvalAgentOutput> {
  const source = await readFile(casePath(input.suiteRoot, input.case.inputs?.transaction ?? ""), "utf8");
  const parsed = parseEditTransaction(JSON.parse(source) as unknown);
  if (parsed.transaction === undefined) {
    throw new Error(parsed.problems.map((problem) => problem.message).join(" "));
  }
  const transaction = parsed.transaction;
  const attempted = transaction.patches.map((entry) => entry.file);
  const before = new Map(transaction.snapshot.files ? Object.entries(transaction.snapshot.files) : []);
  const work = await mkdtemp(join(tmpdir(), "mizzen-eval-transaction-"));
  try {
    const { cp } = await import("node:fs/promises");
    await cp(input.fixtureRoot, work, { recursive: true });
    let status: "applied" | "rejected" = "applied";
    let invariant: string | undefined;
    let checks: { id: string; status: string }[] = [];
    try {
      const result = await applyEditTransaction({
        siteRoot: work,
        transaction,
        receipt: ".mizzen/eval-receipt.json",
        proof: ".mizzen/eval-proof.json",
      });
      checks = result.checks.map((check) => ({ id: check.id, status: check.status }));
    } catch (error) {
      if (!(error instanceof EditTransactionError)) throw error;
      status = "rejected";
      checks = error.checks.map((check) => ({ id: check.id, status: check.status }));
      invariant = error.checks.find((check) => check.status === "failed")?.id;
    }
    const changed = await changedFiles(work, attempted, before);
    const output = emptyOutput(estimate(source), estimate(JSON.stringify(changed)));
    return {
      ...output,
      transaction: {
        status,
        attempted,
        changed: status === "applied" ? changed : [],
        unchanged: attempted.filter((file) => !changed.includes(file)),
        ...(invariant === undefined ? {} : { invariant }),
        partial: status === "rejected" && changed.length > 0,
        checks,
      },
      toolCalls: [call("transaction", status === "applied")],
      trace: { toolCalls: 1, inputTokens: output.usage.inputTokens, outputTokens: output.usage.outputTokens },
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Runs one verification case through the independent verifier. */
async function verificationOutput(input: EvalRunnerInput): Promise<EvalAgentOutput> {
  const proofFile = casePath(input.suiteRoot, input.case.inputs?.proof ?? "");
  const publicFile = casePath(input.suiteRoot, input.case.inputs?.input ?? "");
  const proofText = await readFile(proofFile, "utf8");
  const proof = parseVerificationProof(proofText);
  const publicInput = JSON.parse(await readFile(publicFile, "utf8")) as Record<string, unknown>;
  const report = await independentlyVerify(proof, { input: publicInput });
  const verification: EvalVerificationOutput = {
    ok: report.ok,
    verdict: report.verdict,
    producerVerdict: report.producerVerdict,
    agrees: report.agrees,
    proofHash: report.proofHash,
    checked: report.checked,
    failures: report.failures.map((failure) => ({ code: failure.code, message: failure.message })),
  };
  const output = emptyOutput(estimate(proofText), estimate(JSON.stringify(verification)));
  return {
    ...output,
    verification,
    toolCalls: [call("verification", report.ok)],
    trace: { toolCalls: 1, inputTokens: output.usage.inputTokens, outputTokens: output.usage.outputTokens },
  };
}

/** Resumes a recorded public handoff and checks that the applied edit is never repeated. */
async function handoffOutput(input: EvalRunnerInput): Promise<EvalAgentOutput> {
  const file = casePath(input.suiteRoot, input.case.inputs?.handoff ?? "");
  const document = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  const resumed = resumeHandoff(document, {
    snapshot: String(document["snapshot"]),
    policy: String(document["policy"]),
    consumer: "agent-2",
  });
  if (resumed.session === undefined) {
    throw new Error(resumed.problems.map((problem) => problem.message).join(" "));
  }
  const session: InteractionSession = resumed.session;
  const applied: readonly string[] = session.applied;
  const repeated =
    applied.length === 0
      ? undefined
      : applyInteractionEdit(session, {
          id: applied[0]!,
          files: ["guide/install.md"],
          approvalId: "resume-approval",
        });
  const remaining = session.question === null ? [] : [session.question.field];
  const output = emptyOutput(estimate(JSON.stringify(document)), estimate(JSON.stringify(remaining)));
  return {
    ...output,
    handoff: {
      nextAction: String(document["nextAction"]),
      applied,
      remaining,
      duplicateRefused:
        repeated !== undefined &&
        repeated.problems.some((problem) => problem.code === "interaction.edit-repeated"),
    },
    toolCalls: [call("interaction", true)],
    trace: { toolCalls: 1, inputTokens: output.usage.inputTokens, outputTokens: output.usage.outputTokens },
  };
}

/** Compiles the case context and reports the evidence the pack selected. */
async function contextOutput(input: EvalRunnerInput): Promise<EvalAgentOutput> {
  const facts = await caseFacts(input.case, input.suiteRoot);
  if (facts.compiled === undefined) {
    throw new Error(facts.problems.map((problem) => problem.message).join(" "));
  }
  const compiled = facts.compiled;
  const refs: string[] = [];
  const pages: string[] = [];
  for (const fragment of compiled.fragments) {
    const ref = fragment.source.block ?? fragment.source.file ?? fragment.id;
    if (!refs.includes(ref)) refs.push(ref);
    if (fragment.source.file !== undefined && !pages.includes(fragment.source.file)) pages.push(fragment.source.file);
  }
  const output = emptyOutput(compiled.accounting.used, 0);
  return {
    ...output,
    pages,
    context: { refs, pages, fragments: compiled.fragments.length, tokens: compiled.accounting.used },
    readFiles: pages,
    toolCalls: [call("context", true)],
    trace: { toolCalls: 1, inputTokens: output.usage.inputTokens, outputTokens: 0 },
  };
}

/** Replays one recorded permission attempt set. */
async function permissionOutput(input: EvalRunnerInput): Promise<EvalAgentOutput> {
  const output = await recorded(casePath(input.suiteRoot, input.case.inputs?.agent ?? ""));
  return { ...output, permission: output.permission ?? { attempts: [] as EvalAccessAttempt[] } };
}

/** The reference adapter. */
export const referenceRunner: EvalRunner = {
  id: "reference",
  version: "1",
  tools: [
    { name: "context", version: TOOL_VERSION },
    { name: "edit", version: TOOL_VERSION },
    { name: "transaction", version: TOOL_VERSION },
    { name: "verification", version: TOOL_VERSION },
    { name: "interaction", version: TOOL_VERSION },
    { name: "permission", version: TOOL_VERSION },
  ],
  async run(input) {
    switch (input.case.capability) {
      case "context":
        return contextOutput(input);
      case "transaction":
        return transactionOutput(input);
      case "verification":
        return verificationOutput(input);
      case "handoff":
        return handoffOutput(input);
      case "permission":
        return permissionOutput(input);
      case "conflict":
        throw new Error("a conflict case is unavailable without a coordination module");
      default:
        return recorded(casePath(input.suiteRoot, input.case.inputs?.agent ?? ""));
    }
  },
};

/** True when a value is a case whose recorded output the reference adapter replays. */
export function isRecorded(value: EvalCase): boolean {
  return value.inputs?.agent !== undefined && !["context", "transaction", "verification", "handoff", "conflict"].includes(value.capability);
}
