/**
 * Verify a result without trusting the agent that produced it (#1186).
 *
 * The verifier starts from the proof and a public input: the files before and after, the check
 * results a separate run produced, the output hashes, the human decision, and the release
 * package binding. It recomputes the proof hash, every file hash, every claim, the scope
 * derivation, and the verdict. It never reads the producer's claim of success as evidence; a
 * proof whose own verdict is `proved` but whose evidence supports anything else fails with
 * `verification.verdict`.
 *
 * A missing public input is an explicit failure, not a pass. That is deliberate: a verifier
 * that silently trusts the proof would only repeat the producer's assertion.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  IndependentVerification,
  VerificationCheck,
  VerificationClaim,
  VerificationFailure,
  VerificationHumanReview,
  VerificationProof,
  VerificationPublicInput,
  VerificationVerdict,
} from "../contracts/verification.ts";
import { canonicalJson, sha256 } from "../data/lock.ts";
import { buildHashOf } from "../outputs/build-hash.ts";
import { bindClaims, verificationVerdict } from "./evidence.ts";
import { proofHashMatches } from "./proof.ts";
import { scopeProof } from "./scope.ts";

/** What an independent verifier may use besides the proof. */
export interface IndependentVerifyOptions {
  /** A checkout of the result. Its files are hashed when no `files` input is supplied. */
  readonly siteRoot?: string;
  readonly input?: VerificationPublicInput;
}

/** The failure code for a missing public input. */
const INPUT_MISSING = "verification.input-missing";

/** True for a relative path with forward slashes and no escape segment. */
function relativePath(path: string): boolean {
  return (
    path !== "" &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.split("/").some((segment) => segment === ".." || segment === "" || segment === ".")
  );
}

/** Reads one file's hash, or `null` when it is absent. */
async function fileHash(root: string, path: string): Promise<string | null | "escape"> {
  if (!relativePath(path)) return "escape";
  try {
    return sha256(await readFile(join(root, path)));
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? null : "escape";
  }
}

/** Compares two string lists after sorting. */
function sameList(a: readonly string[], b: readonly string[]): boolean {
  const left = [...a].sort();
  const right = [...b].sort();
  return canonicalJson(left) === canonicalJson(right);
}

/** The claims recomputed from the proof's evidence, never from its `claims` field. */
function recomputedClaims(
  proof: VerificationProof,
  humanReview: VerificationHumanReview,
): readonly VerificationClaim[] {
  const files: Record<string, string | null> = {};
  for (const change of proof.transaction.files) files[change.path] = change.after;
  return bindClaims(
    {
      version: 1,
      task: proof.task.id,
      snapshot: proof.snapshot.id,
      entries: proof.task.criteria,
      problems: [],
    },
    { checks: proof.checks, humanReview, files },
  );
}

/** The scope derived from the transaction, not from the producer's `scope` field. */
function recomputedScope(proof: VerificationProof) {
  return scopeProof({
    allowed: proof.scope.allowed,
    expected: proof.scope.expected,
    changes: proof.transaction.files,
  });
}

/** The reference summary derived from the issues, not from the producer's summary fields. */
function referenceConsistent(proof: VerificationProof): boolean {
  const removed = proof.references.issues.filter((issue) => issue.code === "verification.reference-removed").map((issue) => `${issue.kind}:${issue.ref}`);
  const changed = proof.references.issues.filter((issue) => issue.code === "verification.reference-changed").map((issue) => `${issue.kind}:${issue.ref}`);
  const invalid = proof.references.issues.filter((issue) => issue.code === "verification.reference-invalid").map((issue) => `${issue.kind}:${issue.ref}`);
  return (
    proof.references.ok === (proof.references.issues.length === 0) &&
    sameList(removed, proof.references.removed) &&
    sameList(changed, proof.references.changed) &&
    sameList(invalid, proof.references.invalid)
  );
}

/** The check record for one id, or `undefined`. */
function checkById(checks: readonly VerificationCheck[], id: string): VerificationCheck | undefined {
  return checks.find((check) => check.id === id);
}

/**
 * Rechecks a proof against the public input. Every mismatch is a failure with a stable code,
 * and the returned verdict is the one the recomputed evidence supports.
 */
export async function independentlyVerify(
  proof: VerificationProof,
  options: IndependentVerifyOptions = {},
): Promise<IndependentVerification> {
  const input = options.input ?? {};
  const failures: VerificationFailure[] = [];
  const fail = (code: string, message: string, path?: string): void => {
    failures.push({ code, message, ...(path === undefined ? {} : { path }) });
  };

  const hashMatches = proofHashMatches(proof);
  if (!hashMatches) {
    fail("verification.proof-hash", "The proof hash does not match the proof content; the record changed after it was written.");
  }

  let filesChecked = 0;
  const transactionPaths = proof.transaction.files.map((change) => change.path);
  if (input.files !== undefined) {
    const supplied = Object.keys(input.files).sort();
    if (!sameList(supplied, transactionPaths)) {
      const missing = transactionPaths.filter((path) => !(path in input.files!));
      const extra = supplied.filter((path) => !transactionPaths.includes(path));
      fail(
        "verification.file",
        `The public file set does not match the transaction${missing.length === 0 ? "" : `; missing: ${missing.join(", ")}`}${extra.length === 0 ? "" : `; extra: ${extra.join(", ")}`}.`,
      );
    }
    for (const change of proof.transaction.files) {
      const actual = input.files[change.path];
      if (actual === undefined) continue;
      filesChecked++;
      if (actual !== change.after) {
        fail("verification.file", `File "${change.path}" does not match the recorded hash after the task.`, change.path);
      }
      const before = input.before?.[change.path];
      if (input.before !== undefined && before !== change.before) {
        fail("verification.file", `File "${change.path}" does not match the recorded hash before the task.`, change.path);
      }
    }
  } else if (options.siteRoot !== undefined) {
    for (const change of proof.transaction.files) {
      const actual = await fileHash(options.siteRoot, change.path);
      filesChecked++;
      if (actual === "escape") {
        fail("verification.path", `File "${change.path}" is not a safe relative path.`, change.path);
      } else if (actual !== change.after) {
        fail("verification.file", `File "${change.path}" does not match the recorded hash after the task.`, change.path);
      }
    }
  } else {
    fail(INPUT_MISSING, "No public file evidence was supplied; the transaction cannot be checked.");
  }

  let checksChecked = 0;
  if (input.checks !== undefined) {
    for (const check of proof.checks) {
      const supplied = input.checks[check.id];
      if (supplied === undefined) {
        fail("verification.check", `Check "${check.id}" has no public result.`, check.id);
        continue;
      }
      checksChecked++;
      if (supplied.status !== check.status || supplied.outputHash !== check.outputHash) {
        fail("verification.check", `Check "${check.id}" does not match the public result.`, check.id);
      }
    }
    for (const id of Object.keys(input.checks)) {
      if (checkById(proof.checks, id) === undefined) {
        fail("verification.check", `The public result names check "${id}", which the proof does not record.`, id);
      }
    }
  } else {
    fail(INPUT_MISSING, "No public check results were supplied; the checks cannot be rechecked.");
  }

  let outputsChecked = false;
  if (input.outputHash !== undefined) {
    outputsChecked = true;
    if (input.outputHash !== proof.outputs.actualHash) {
      fail("verification.output", "The public output hash does not match the proof's reproduced output.");
    }
  } else if (input.outputs !== undefined) {
    outputsChecked = true;
    const actual = buildHashOf(input.outputs);
    if (actual !== proof.outputs.actualHash) {
      fail("verification.output", "The public output files do not produce the proof's reproduced output hash.");
    }
  } else {
    fail(INPUT_MISSING, "No public output hash was supplied; the build output cannot be checked.");
  }
  if (proof.outputs.match !== (proof.outputs.expectedHash === proof.outputs.actualHash && proof.outputs.tool.expected === proof.outputs.tool.actual)) {
    fail("verification.output", "The proof's output match flag does not agree with its hashes and tool versions.");
  }
  if (proof.outputs.match && proof.outputs.unexplained.length > 0) {
    fail("verification.output", "The proof reports unexplained output differences and a matching output.");
  }

  const humanCriteria = proof.task.criteria.filter((entry) => entry.mode === "human").map((entry) => entry.criterion);
  let humanChecked = true;
  let humanReview: VerificationHumanReview = proof.humanReview;
  if (humanCriteria.length > 0) {
    humanChecked = input.humanReview !== undefined;
    if (input.humanReview === undefined) {
      fail(INPUT_MISSING, "The proof needs human review evidence, and no public decision was supplied.");
    } else {
      if (input.humanReview.status !== proof.humanReview.status) {
        fail("verification.human-review", "The public human review status does not match the proof.");
      }
      if (input.humanReview.reviewer !== proof.humanReview.reviewer) {
        fail("verification.human-review", "The public reviewer does not match the proof.");
      }
      humanReview = {
        status: input.humanReview.status,
        criteria: proof.humanReview.criteria,
        ...(input.humanReview.reviewer === undefined ? {} : { reviewer: input.humanReview.reviewer }),
      };
    }
  }

  const claims = recomputedClaims(proof, humanReview);
  if (claims.length !== proof.claims.length) {
    fail("verification.claim", "The proof does not have one claim per acceptance criterion.");
  }
  for (const claim of claims) {
    const recorded = proof.claims.find((candidate) => candidate.id === claim.id);
    if (recorded === undefined) {
      fail("verification.claim", `Claim "${claim.id}" is missing from the proof.`, claim.id);
      continue;
    }
    if (recorded.status !== claim.status || canonicalJson(recorded.missing) !== canonicalJson(claim.missing)) {
      fail("verification.claim", `Claim "${claim.id}" is ${recorded.status}, but the evidence supports ${claim.status}.`, claim.id);
    }
  }
  for (const recorded of proof.claims) {
    if (!claims.some((claim) => claim.id === recorded.id)) {
      fail("verification.claim", `Claim "${recorded.id}" does not name a planned criterion.`, recorded.id);
    }
  }

  const scope = recomputedScope(proof);
  if (canonicalJson(scope) !== canonicalJson(proof.scope)) {
    fail("verification.scope", "The scope fields do not follow from the transaction's before-and-after files.");
  }
  if (!referenceConsistent(proof)) {
    fail("verification.references", "The reference summary does not follow from its issues.");
  }

  let packageChecked = false;
  if (proof.package !== undefined) {
    packageChecked = true;
    if (input.commit === undefined || input.tarballSha256 === undefined || input.ci === undefined) {
      fail(INPUT_MISSING, "The proof is bound to a release package, and the public commit, tarball hash, and CI result were not supplied.");
    } else {
      if (input.commit !== proof.package.commit || input.commit !== proof.transaction.commit) {
        fail("verification.package", "The public commit does not match the proof's commit.");
      }
      if (input.tarballSha256 !== proof.package.tarballSha256) {
        fail("verification.package", "The public tarball SHA-256 does not match the proof's package.");
      }
      if (input.ci !== "passed") {
        fail("verification.package", `The public CI result is "${input.ci}", not "passed".`);
      }
    }
  }

  const verdict: VerificationVerdict = verificationVerdict({
    criteriaCount: proof.task.criteria.length,
    checks: proof.checks,
    claims,
    outputs: proof.outputs,
    scope,
    references: proof.references,
    humanReview,
    ...(proof.package === undefined ? {} : { package: proof.package }),
  });
  const agrees = verdict === proof.verdict;
  if (!agrees) {
    fail("verification.verdict", `The evidence supports "${verdict}", but the proof says "${proof.verdict}".`);
  }
  if (verdict !== "proved") {
    fail("verification.not-proved", `The evidence supports "${verdict}", so the result is not proved.`);
  }

  return {
    ok: failures.length === 0 && verdict === "proved" && agrees,
    verdict,
    producerVerdict: proof.verdict,
    agrees,
    proofHash: hashMatches ? "matched" : "mismatched",
    checked: {
      files: filesChecked,
      checks: checksChecked,
      outputs: outputsChecked,
      humanReview: humanChecked,
      package: packageChecked,
    },
    failures,
  };
}
