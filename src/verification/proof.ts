/**
 * Build, format, and parse the versioned verification proof (#1189, #1190).
 *
 * The proof is one canonical record: task and planned criteria, the input snapshot, the
 * transaction that changed files, every bounded check with its output hash, the reproduced
 * output hashes, the human-review state, and the claims that tie each criterion to evidence.
 * The top-level verdict is derived from those claims; a failed check, a missing run, absent
 * evidence, or a human criterion without approval can never be overwritten with `proved`
 * (#1188).
 *
 * `proofHash` is the SHA-256 of the canonical record without that field. Nothing in the
 * comparable content is a clock, a process id, or a local path: files are relative, checks
 * keep hashes instead of output, and durations are not stored. Two runs over the same evidence
 * therefore produce the same bytes and the same hash.
 *
 * Version 1 is the edit proof in `../edits/proof.ts`. `proofVersionOf` lets the CLI send that
 * shape to its existing verifier, so adding version 2 did not break a consumer of version 1.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { ErrorObject } from "ajv";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import type { TaskDocument } from "../contracts/task.ts";
import {
  VERIFICATION_PROOF_VERSION,
  type VerificationChange,
  type VerificationCheck,
  type VerificationHumanReview,
  type VerificationOutputs,
  type VerificationPackage,
  type VerificationPlan,
  type VerificationProof,
  type VerificationReferences,
} from "../contracts/verification.ts";
import { canonicalJson, sha256 } from "../data/lock.ts";
import { bindClaims, verificationVerdict } from "./evidence.ts";
import { scopeProof } from "./scope.ts";

/** The most this module's parser reads from a proof file. */
export const MAX_PROOF_BYTES = 8 * 1024 * 1024;

/** A proof that cannot be built or read. */
export class VerificationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "VerificationError";
    this.code = code;
  }
}

/** Everything a caller supplies to build one proof. */
export interface VerificationProofInput {
  readonly task: TaskDocument;
  readonly plan: VerificationPlan;
  readonly commit: string;
  readonly base: string;
  readonly files: readonly VerificationChange[];
  readonly allowed: readonly string[];
  readonly expected: readonly string[];
  readonly checks: readonly VerificationCheck[];
  readonly outputs: VerificationOutputs;
  readonly references: VerificationReferences;
  readonly humanReview: VerificationHumanReview;
  readonly package?: VerificationPackage;
}

/** SHA-256 as the engine writes it. */
const HASH = /^[0-9a-f]{64}$/u;

/** Throws unless `value` is a lowercase SHA-256. */
function assertHash(value: string, what: string): void {
  if (!HASH.test(value)) throw new VerificationError("verification.hash", `${what} is not a lowercase SHA-256.`);
}

/** Throws unless `value` is a non-empty string. */
function assertText(value: string, what: string): void {
  if (value.trim() === "") throw new VerificationError("verification.empty", `${what} cannot be empty.`);
}

/** Sorts by code point. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The transaction id: the task, snapshot, commits, and every changed file. */
export function transactionIdOf(input: {
  readonly task: string;
  readonly snapshot: string;
  readonly commit: string;
  readonly base: string;
  readonly files: readonly VerificationChange[];
}): string {
  return sha256(`mizzen-verification-transaction\0${canonicalJson(input)}`);
}

/** The proof hash: the canonical record without its `proofHash` field. */
export function proofHashOf(proof: Omit<VerificationProof, "proofHash"> | VerificationProof): string {
  const { proofHash: _ignored, ...content } = proof as VerificationProof;
  return sha256(`mizzen-verification-proof\0${canonicalJson(content)}`);
}

/** Adds an explicit `unrun` record for every planned check that produced none. */
function checksOf(input: VerificationProofInput): readonly VerificationCheck[] {
  const checks = [...input.checks].sort((a, b) => byCodePoint(a.id, b.id));
  const seen = new Set<string>();
  for (const check of checks) {
    if (seen.has(check.id)) {
      throw new VerificationError("verification.check-duplicate", `Check "${check.id}" is recorded more than once.`);
    }
    seen.add(check.id);
    if (check.task !== input.task.id) {
      throw new VerificationError("verification.check-task", `Check "${check.id}" is for another task.`);
    }
    if (check.snapshot !== input.task.snapshot.id) {
      throw new VerificationError("verification.check-snapshot", `Check "${check.id}" ran against another snapshot.`);
    }
    if (check.commit !== input.commit) {
      throw new VerificationError("verification.check-commit", `Check "${check.id}" ran at another commit.`);
    }
    assertHash(check.outputHash, `Check "${check.id}" output hash`);
    if (check.expectedHash !== undefined) assertHash(check.expectedHash, `Check "${check.id}" expected hash`);
  }

  for (const entry of input.plan.entries) {
    if (entry.mode !== "check" || entry.check === undefined || seen.has(entry.check)) continue;
    checks.push({
      id: entry.check,
      criterion: entry.criterion,
      task: input.task.id,
      snapshot: input.task.snapshot.id,
      commit: input.commit,
      status: "unrun",
      command: [],
      outputHash: sha256(""),
      limits: { timeoutMs: 0, memoryMb: 0, network: "deny", paths: "sandbox" },
      detail: "The check did not run.",
    });
    seen.add(entry.check);
  }
  return checks.sort((a, b) => byCodePoint(a.id, b.id));
}

/** Files in path order, without duplicates, with valid hashes. */
function filesOf(files: readonly VerificationChange[]): readonly VerificationChange[] {
  const seen = new Set<string>();
  const sorted = [...files].sort((a, b) => byCodePoint(a.path, b.path));
  for (const file of sorted) {
    assertText(file.path, "A changed file path");
    if (file.path.includes("\\") || file.path.startsWith("/") || file.path.split("/").some((part) => part === "..")) {
      throw new VerificationError("verification.path", `"${file.path}" is not a relative path with forward slashes.`);
    }
    if (seen.has(file.path)) {
      throw new VerificationError("verification.file-duplicate", `File "${file.path}" is recorded more than once.`);
    }
    seen.add(file.path);
    if (file.before !== null) assertHash(file.before, `File "${file.path}" before hash`);
    if (file.after !== null) assertHash(file.after, `File "${file.path}" after hash`);
  }
  return sorted;
}

/**
 * Builds the proof and its hash. The plan must be complete and belong to the task; an
 * incomplete plan is refused before any record exists, because a plan with a missing fixture
 * or a mismatched check cannot prove the task it names.
 */
export function createVerificationProof(input: VerificationProofInput): VerificationProof {
  if (input.plan.problems.length > 0) {
    throw new VerificationError(
      "verification.plan-incomplete",
      `The verification plan has ${input.plan.problems.length} problem(s): ${input.plan.problems.map((problem) => problem.message).join(" ")}`,
    );
  }
  if (input.plan.task !== input.task.id || input.plan.snapshot !== input.task.snapshot.id) {
    throw new VerificationError("verification.plan-task", "The verification plan belongs to another task or snapshot.");
  }
  assertText(input.commit, "The commit");
  assertText(input.base, "The base commit");
  for (const [name, hash] of Object.entries(input.task.snapshot)) assertHash(hash, `Snapshot ${name}`);

  const files = filesOf(input.files);
  const checks = checksOf(input);
  const humanReview: VerificationHumanReview = {
    ...input.humanReview,
    criteria: [...new Set(input.humanReview.criteria)].sort(byCodePoint),
  };
  const fileHashes: Record<string, string | null> = {};
  for (const file of files) fileHashes[file.path] = file.after;
  const claims = bindClaims(input.plan, { checks, humanReview, files: fileHashes });
  const scope = scopeProof({ allowed: input.allowed, expected: input.expected, changes: files });
  const verdict = verificationVerdict({
    criteriaCount: input.task.acceptance.length,
    checks,
    claims,
    outputs: input.outputs,
    scope,
    references: input.references,
    humanReview,
    ...(input.package === undefined ? {} : { package: input.package }),
  });

  const content: Omit<VerificationProof, "proofHash"> = {
    version: VERIFICATION_PROOF_VERSION,
    task: {
      id: input.task.id,
      goal: input.task.goal,
      criteria: input.plan.entries,
    },
    snapshot: input.task.snapshot,
    transaction: {
      id: transactionIdOf({
        task: input.task.id,
        snapshot: input.task.snapshot.id,
        commit: input.commit,
        base: input.base,
        files,
      }),
      commit: input.commit,
      base: input.base,
      files,
    },
    checks,
    outputs: input.outputs,
    humanReview,
    claims,
    scope,
    references: input.references,
    ...(input.package === undefined ? {} : { package: input.package }),
    verdict,
  };
  return { ...content, proofHash: proofHashOf(content) };
}

/** The proof as bytes: two-space JSON, fixed key order, one trailing line feed. */
export function formatVerificationProof(proof: VerificationProof): string {
  return `${JSON.stringify(proof, null, 2)}\n`;
}

// ajv is CommonJS: its default export is the class at run time, but its types name it.
const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;
const schema = JSON.parse(
  readFileSync(new URL("../../schema/verification-proof.schema.json", import.meta.url), "utf8"),
) as object;
const validateShape = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

/** The version a proof text declares, or `undefined` when it is not a proof object. */
export function proofVersionOf(text: string): 1 | 2 | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const version = (parsed as { version?: unknown }).version;
  return version === 1 || version === 2 ? version : undefined;
}

/** The shape problem from ajv, as one readable sentence. */
function shapeProblem(errors: readonly ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .slice(0, 3)
    .map((error) => `${error.instancePath === "" ? "the proof" : error.instancePath} ${error.message ?? "is invalid"}`)
    .join("; ");
}

/**
 * Reads a version 2 proof and checks its shape. The hash is not recomputed here: an independent
 * verifier must do that, so a producer cannot make a changed record match by rewriting only the
 * hash check.
 */
export function parseVerificationProof(text: string): VerificationProof {
  if (Buffer.byteLength(text, "utf8") > MAX_PROOF_BYTES) {
    throw new VerificationError("verification.proof-size", `The proof is larger than ${MAX_PROOF_BYTES} bytes.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new VerificationError("verification.proof-json", "The proof is not valid JSON.");
  }
  if (proofVersionOf(text) === 1) {
    throw new VerificationError(
      "verification.proof-version",
      "This is a version 1 edit proof; `mizzen edit verify` reads it with the edit proof verifier.",
    );
  }
  if (!validateShape(parsed)) {
    throw new VerificationError("verification.proof-shape", `The proof does not match the schema: ${shapeProblem(validateShape.errors)}.`);
  }
  return parsed as VerificationProof;
}

/** True when a parsed proof's recorded hash matches its content. */
export function proofHashMatches(proof: VerificationProof): boolean {
  return proofHashOf(proof) === proof.proofHash;
}
