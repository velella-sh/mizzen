import { canonicalJson } from "../data/lock.ts";
import { checkAsOf } from "../dates/as-of.ts";
import type { Envelope, EvidenceLock } from "./format.ts";
import type { LockedEvidence } from "./store.ts";
import { testFindings } from "./tests.ts";

type Claim = EvidenceLock["claims"][number];
type Status = "verified" | "stale" | "unverified";
const DAY = 86_400_000;
export const EVIDENCE_REPORT_PATH = ".mizzen/evidence.json";

function incompatibility(envelope: Envelope, lock: EvidenceLock): string | undefined {
  if (envelope.snapshot !== lock.snapshot.id) return "snapshot-mismatch";
  if (envelope.kind === "ci") {
    const run = envelope.payload;
    if (run.commit !== lock.snapshot.commit) return "commit-mismatch";
    if (run.configSha256 !== lock.snapshot.configSha256) return "configuration-mismatch";
    if (run.artifactSha256 !== lock.pins[envelope.id]?.artifactSha256) return "artifact-mismatch";
  }
  return undefined;
}

export function evidenceReport(input: LockedEvidence, pageUrls: ReadonlySet<string>, asOf: string | undefined): string {
  if (asOf === undefined || checkAsOf(asOf) !== undefined) {
    throw new Error("evidence.lock.json requires an explicit as-of date (YYYY-MM-DD).");
  }
  const { lock, entries } = input;
  const surfaces = new Set(lock.surfaces);
  const tests = new Map([...entries].flatMap(([id, envelope]) =>
    envelope.kind === "test" ? [[id, testFindings(envelope.payload)] as const] : [],
  ));
  const claims = lock.claims.map((claim) => {
    const invalidSubject = claim.subject.kind === "page"
      ? !pageUrls.has(claim.subject.id)
      : claim.subject.id !== claim.behavior;
    const evidence = claim.evidence.map((id) => {
      const rejected = (reason: string, status: Status = "unverified") => ({ id, reason, status });
      if (invalidSubject) return rejected("invalid-subject");
      if (!surfaces.has(claim.surface)) return rejected("unknown-surface");
      const envelope = entries.get(id);
      if (envelope === undefined) return rejected("missing-evidence");
      const incompatible = incompatibility(envelope, lock);
      if (incompatible !== undefined) return rejected(incompatible);

      const matches = (target: Pick<Claim, "surface" | "behavior">) =>
        target.surface === claim.surface && target.behavior === claim.behavior;
      if (envelope.kind === "test") {
        const matched = tests.get(id)!.filter((test) =>
          test.surface !== undefined && test.behavior !== undefined && matches({ surface: test.surface, behavior: test.behavior }),
        );
        if (matched.length === 0) return rejected("unrelated-evidence");
        if (matched.some((test) => test.outcome !== "passed")) return rejected("nonpassing-tests");
      } else {
        if (!envelope.payload.targets.some(matches)) return rejected("unrelated-evidence");
        if (envelope.kind === "ci" && envelope.payload.outcome !== "passed") return rejected("nonpassing-ci");
      }

      const age = (Date.parse(asOf) - Date.parse(envelope.executedAt.slice(0, 10))) / DAY;
      if (age < 0) return rejected("future-evidence");
      if (age > lock.maxAgeDays) return rejected("expired-evidence", "stale");
      return { id, status: "verified" as const };
    });
    const status: Status = evidence.some((entry) => entry.status === "verified")
      ? "verified"
      : evidence.some((entry) => entry.status === "stale") ? "stale" : "unverified";
    return { ...claim, evidence, status };
  });
  const verified = new Set(claims.flatMap((claim) =>
    claim.evidence.filter((entry) => entry.status === "verified").map((entry) => entry.id),
  ));
  const evidence = [...entries].map(([id, envelope]) => {
    const base = { id, kind: envelope.kind, sha256: lock.pins[id]!.sha256, executedAt: envelope.executedAt };
    if (envelope.kind === "test") return { ...base, tests: tests.get(id) };
    if (envelope.kind === "ci") {
      const { runId, commit, workflow, configSha256, artifactSha256, outcome } = envelope.payload;
      return { ...base, runId, commit, workflow, configSha256, artifactSha256, outcome };
    }
    if (!verified.has(id)) return base;
    const { metric, unit, value, run } = envelope.payload;
    return { ...base, measurement: { metric, unit, value, run } };
  });
  return `${canonicalJson({ version: 1, snapshot: lock.snapshot.id, asOf, claims, evidence })}\n`;
}
