/**
 * Builds the versioned behavior report: every authored behavior, its public surface links, the tests that prove it,
 * the evidence that supports it, and the verdict the evidence policy reaches. Missing surface items, test files,
 * evidence pins, or a test whose expected outcome is not `passed` make a behavior `unverified`, never `verified`.
 *
 * The report is deterministic: behaviors sort by id, links sort by their stable keys, and no clock, network, or
 * environment is read. Private behaviors and private evidence values are removed before they reach the report.
 */
import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import type { Page, Site } from "../contracts/content.ts";
import type { Diagnostic } from "../contracts/diagnostic.ts";
import type {
  BehaviorComparison,
  BehaviorCoverage,
  BehaviorDeclaration,
  BehaviorDrift,
  BehaviorEvidenceLink,
  BehaviorEvidencePolicy,
  BehaviorFinding,
  BehaviorLookupResult,
  BehaviorQuery,
  BehaviorRecord,
  BehaviorReference,
  BehaviorReport,
  BehaviorStatusCounts,
  BehaviorSupportStatus,
  BehaviorSurfaceLink,
  BehaviorTestLink,
  BehaviorUnverifiedReason,
  BehaviorVerificationState,
} from "../contracts/behavior.ts";
import type { SurfaceItem } from "../contracts/surface.ts";
import { canonicalJson, sha256 } from "../data/lock.ts";
import { readEvidenceLock } from "../evidence/format.ts";
import { formatSpan } from "../source/spans.ts";
import type { SourcePos } from "../contracts/source.ts";
import { duplicateBehaviorIds, duplicateLocationText, sortBehaviorDiagnostics } from "./parse.ts";
import { environmentCovers, statusAtVersion } from "./version.ts";

/** The one evidence policy: what each support status must prove before the report calls it verified. */
export const BEHAVIOR_EVIDENCE_POLICY: BehaviorEvidencePolicy = {
  supported: { tests: 1, evidence: 1, kinds: ["test", "ci", "benchmark"] },
  experimental: { tests: 1, evidence: 0, kinds: ["test", "ci", "benchmark"] },
  deprecated: { tests: 0, evidence: 1, kinds: ["test", "ci", "benchmark", "document"] },
  removed: { tests: 0, evidence: 0, kinds: [] },
};

/** The fixed order of verification reasons. */
const REASON_ORDER: readonly BehaviorUnverifiedReason[] = [
  "missing-surface",
  "missing-test",
  "nonpassing-test",
  "missing-evidence",
  "unresolved-evidence",
  "invalid-replacement",
];

/** The fixed order of drift kinds. */
const DRIFT_ORDER: readonly BehaviorDrift["kinds"][number][] = [
  "signature",
  "surface-added",
  "surface-removed",
  "test",
  "evidence",
  "contract",
];

/** What a report needs. */
export interface BehaviorReportOptions {
  /** The built site model, which holds every authored behavior. */
  readonly site: Site;
  /** Site root used to read tests and the evidence lock; absent leaves them unresolved. */
  readonly root?: string;
  /** The product version the surface inventory and query use, when one is named. */
  readonly version?: string;
}

/** One declaration with the page that declared it. */
interface CollectedBehavior {
  readonly declaration: BehaviorDeclaration;
  readonly page: Page;
}

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** True for a doc page an author wrote: not a record page, not a generated API reference page. */
function isAuthoredPage(page: Page): boolean {
  if (page.kind !== "doc") return false;
  if (page.record !== undefined) return false;
  const api = page.frontMatter.apiReference;
  return !(typeof api === "object" && api !== null && !Array.isArray(api));
}

/** Every authored behavior of the site, in declaration order. */
function collectedBehaviors(site: Site): CollectedBehavior[] {
  const out: CollectedBehavior[] = [];
  for (const page of site.pages) {
    if (!isAuthoredPage(page)) continue;
    for (const declaration of page.behaviors ?? []) out.push({ declaration, page });
  }
  return out;
}

/** The status counts of a list of behaviors. */
function statusCounts(behaviors: readonly BehaviorRecord[]): BehaviorStatusCounts {
  const counts: { -readonly [K in BehaviorSupportStatus]: number } = {
    supported: 0,
    experimental: 0,
    deprecated: 0,
    removed: 0,
  };
  for (const behavior of behaviors) counts[behavior.status] += 1;
  return counts;
}

/** The coverage of one list of behaviors and a count of private ones. */
export function behaviorCoverageOf(behaviors: readonly BehaviorRecord[], privateCount: number): BehaviorCoverage {
  let verified = 0;
  let linked = 0;
  let missing = 0;
  for (const behavior of behaviors) {
    if (behavior.verification.status === "verified") verified += 1;
    for (const surface of behavior.surface) {
      if (surface.state === "linked") linked += 1;
      else missing += 1;
    }
  }
  return {
    total: behaviors.length,
    verified,
    unverified: behaviors.length - verified,
    private: privateCount,
    byStatus: statusCounts(behaviors),
    surface: { linked, missing },
  };
}

/** One finding as a diagnostic, so `mizzen check` gates on the same rules the report shows. */
function diagnosticOf(finding: BehaviorFinding): Diagnostic {
  return {
    id: finding.code,
    severity: finding.severity,
    message: finding.message,
    ...(finding.pos === undefined ? {} : { pos: finding.pos }),
  };
}

/** True when the finding's position sorts before another. */
function compareFindings(a: BehaviorFinding, b: BehaviorFinding): number {
  const pa = a.pos;
  const pb = b.pos;
  const byPos =
    pa === undefined || pb === undefined
      ? pa === pb
        ? 0
        : pa === undefined
          ? 1
          : -1
      : pa.file < pb.file
        ? -1
        : pa.file > pb.file
          ? 1
          : pa.line - pb.line || pa.column - pb.column || pa.endLine - pb.endLine || pa.endColumn - pb.endColumn;
  return byCodePoint(a.code, b.code) || byPos || byCodePoint(a.message, b.message);
}

/** True for a repository-relative test path that cannot escape the root. */
function safeTestPath(file: string): boolean {
  const normalized = posix.normalize(file.replace(/\\/g, "/"));
  return normalized !== ".." && !normalized.startsWith("../") && !posix.isAbsolute(normalized) && normalized !== ".";
}

/** Reads a test file once per report; `undefined` means it is missing or unreadable. */
function testReader(root: string | undefined): (file: string) => Promise<string | undefined> {
  const cache = new Map<string, Promise<string | undefined>>();
  return (file) => {
    if (root === undefined || !safeTestPath(file)) return Promise.resolve(undefined);
    const key = posix.normalize(file.replace(/\\/g, "/"));
    let read = cache.get(key);
    if (read === undefined) {
      read = readFile(join(root, key), "utf8").catch(() => undefined);
      cache.set(key, read);
    }
    return read;
  };
}

/** Resolves every declared test against the repository. */
async function resolveTests(
  declarations: readonly BehaviorDeclaration[],
  root: string | undefined,
): Promise<BehaviorTestLink[][]> {
  const read = testReader(root);
  const out: BehaviorTestLink[][] = [];
  for (const declaration of declarations) {
    const list: BehaviorTestLink[] = [];
    for (const test of declaration.tests) {
      const text = await read(test.file);
      const nameVisible = test.name !== undefined && test.public !== false;
      if (text === undefined) {
        list.push({
          file: test.file,
          outcome: test.outcome,
          state: "missing",
          ...(nameVisible ? { name: test.name! } : {}),
          ...(test.name !== undefined && test.public === false ? { redacted: true } : {}),
        });
        continue;
      }
      const named = test.name === undefined ? true : text.includes(test.name);
      list.push({
        file: test.file,
        ...(nameVisible ? { name: test.name! } : {}),
        ...(test.name !== undefined && test.public === false ? { redacted: true } : {}),
        outcome: test.outcome,
        state: named ? "found" : "missing",
        digest: sha256(text),
      });
    }
    out.push(list);
  }
  return out;
}

/** One pinned evidence id, its expected envelope digest, and the behavior ids its claims name. */
interface EvidencePin {
  readonly sha256: string;
  readonly behaviors: Set<string>;
}

/** The pinned evidence ids, their expected envelope digests, and their behavior claims. */
async function evidencePinsOf(root: string | undefined): Promise<Map<string, EvidencePin>> {
  if (root === undefined) return new Map();
  try {
    const raw = JSON.parse(await readFile(join(root, ".mizzen", "evidence.lock.json"), "utf8")) as unknown;
    const lock = readEvidenceLock(raw);
    const pins = new Map<string, EvidencePin>();
    for (const [id, pin] of Object.entries(lock.pins)) {
      pins.set(id, { sha256: pin.sha256, behaviors: new Set<string>() });
    }
    for (const claim of lock.claims) {
      if (claim.subject.kind !== "behavior") continue;
      for (const evidence of claim.evidence) {
        const pin = pins.get(evidence);
        if (pin !== undefined) pin.behaviors.add(claim.subject.id);
      }
    }
    return pins;
  } catch {
    return new Map();
  }
}

/** Resolves every declared evidence entry against public URLs and the evidence lock. */
function resolveEvidence(
  declarations: readonly BehaviorDeclaration[],
  pins: ReadonlyMap<string, EvidencePin>,
): BehaviorEvidenceLink[][] {
  return declarations.map((declaration) =>
    declaration.evidence.map((entry) => {
      const kind = entry.kind ?? (entry.url === undefined ? "test" : "document");
      const pin = entry.id === undefined ? undefined : pins.get(entry.id);
      const resolved =
        entry.url !== undefined
          ? { state: "resolved" as const, digest: sha256(`${kind}\0${entry.url}\0${entry.title ?? ""}`) }
          : pin !== undefined && pin.behaviors.has(declaration.id)
            ? { state: "resolved" as const, digest: pin.sha256 }
            : { state: "unresolved" as const };
      if (entry.public === false) return { kind, state: resolved.state, redacted: true };
      return {
        kind,
        state: resolved.state,
        ...(entry.id === undefined ? {} : { id: entry.id }),
        ...(entry.url === undefined ? {} : { url: entry.url }),
        ...(entry.title === undefined ? {} : { title: entry.title }),
        ...("digest" in resolved ? { digest: resolved.digest } : {}),
      };
    }),
  );
}

/** The surface items the report resolves against; empty when the root or the surface is unavailable. */
async function surfaceItemsOf(
  root: string | undefined,
  site: Site,
  version: string | undefined,
): Promise<Map<string, SurfaceItem>> {
  if (root === undefined) return new Map();
  try {
    const { surfaceReportOf } = await import("../surface/report.ts");
    const { report } = await surfaceReportOf({ root, site, ...(version === undefined ? {} : { version }) });
    return new Map(report.items.map((item) => [item.id, item]));
  } catch {
    return new Map();
  }
}

/** One surface link, resolved against the inventory. */
function surfaceLinkOf(id: string, items: ReadonlyMap<string, SurfaceItem>): BehaviorSurfaceLink {
  const item = items.get(id);
  if (item === undefined) return { item: id, state: "missing" };
  return {
    item: id,
    state: "linked",
    area: item.area,
    kind: item.kind,
    name: item.name,
    stability: item.stability,
    ...(item.signature === undefined ? {} : { signature: item.signature }),
    source: item.source,
  };
}

/** The verification verdict, in the fixed reason order. */
function verificationOf(
  surface: readonly BehaviorSurfaceLink[],
  tests: readonly BehaviorTestLink[],
  evidence: readonly BehaviorEvidenceLink[],
  status: BehaviorSupportStatus,
  invalidReplacement: boolean,
): BehaviorVerificationState {
  const required = BEHAVIOR_EVIDENCE_POLICY[status];
  const reasons = new Set<BehaviorUnverifiedReason>();
  if (surface.length === 0 || surface.some((link) => link.state === "missing")) reasons.add("missing-surface");
  const passing = tests.filter((test) => test.state === "found" && test.outcome === "passed").length;
  if (tests.some((test) => test.state === "missing") || (required.tests > 0 && passing < required.tests)) {
    reasons.add("missing-test");
  }
  if (tests.some((test) => test.state === "found" && test.outcome !== "passed")) reasons.add("nonpassing-test");
  const qualifying = evidence.filter((link) => link.state === "resolved" && required.kinds.includes(link.kind)).length;
  if (qualifying < required.evidence) reasons.add("missing-evidence");
  if (evidence.some((link) => link.state === "unresolved")) reasons.add("unresolved-evidence");
  if (invalidReplacement) reasons.add("invalid-replacement");
  const ordered = REASON_ORDER.filter((reason) => reasons.has(reason));
  return { status: ordered.length === 0 ? "verified" : "unverified", reasons: ordered, required };
}

/** The public surface links, sorted by item id. */
function publicSurface(links: readonly BehaviorSurfaceLink[]): BehaviorSurfaceLink[] {
  return [...links].sort((a, b) => byCodePoint(a.item, b.item));
}

/** Collects duplicate-id and replacement findings, and returns the ids a report must leave out. */
function structuralFindings(
  collected: readonly CollectedBehavior[],
): { readonly findings: BehaviorFinding[]; readonly duplicateIds: ReadonlySet<string>; readonly invalidReplacement: ReadonlySet<string> } {
  const findings: BehaviorFinding[] = [];
  const declarations = collected.map((entry) => entry.declaration);
  const duplicates = duplicateBehaviorIds(declarations);
  const duplicateIds = new Set(duplicates.map((entry) => entry.id));
  for (const duplicate of duplicates) {
    findings.push({
      code: "behavior.duplicate-id",
      severity: "error",
      message: `Behavior id "${duplicate.id}" is declared more than once, at ${duplicateLocationText(duplicate)}.`,
      pos: duplicate.declarations[duplicate.declarations.length - 1]!.source,
      locations: duplicate.declarations.map((declaration) => declaration.source),
    });
  }

  const unique = collected.filter((entry) => !duplicateIds.has(entry.declaration.id));
  const byId = new Map(unique.map((entry) => [entry.declaration.id, entry]));
  const validReplacement = new Map<string, string>();
  const invalidReplacement = new Set<string>();

  for (const entry of unique) {
    const { declaration } = entry;
    if (declaration.replacement === undefined) continue;
    const target = byId.get(declaration.replacement);
    if (declaration.replacement === declaration.id) {
      invalidReplacement.add(declaration.id);
      findings.push({
        code: "behavior.invalid-replacement",
        severity: "error",
        message: `Behavior "${declaration.id}" names itself as its replacement.`,
        pos: declaration.source,
      });
      continue;
    }
    if (target === undefined) {
      invalidReplacement.add(declaration.id);
      findings.push({
        code: "behavior.unknown-replacement",
        severity: "error",
        message: `Behavior "${declaration.id}" names replacement "${declaration.replacement}", which is not declared.`,
        pos: declaration.source,
      });
      continue;
    }
    if (target.declaration.status === "removed") {
      invalidReplacement.add(declaration.id);
      findings.push({
        code: "behavior.invalid-replacement",
        severity: "error",
        message: `Behavior "${declaration.id}" names replacement "${declaration.replacement}", which is itself removed.`,
        pos: declaration.source,
        locations: [declaration.source, target.declaration.source],
      });
      continue;
    }
    validReplacement.set(declaration.id, declaration.replacement);
  }

  const cycleReported = new Set<string>();
  for (const id of [...validReplacement.keys()].sort(byCodePoint)) {
    const path: string[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined = id;
    while (cursor !== undefined && !seen.has(cursor)) {
      seen.add(cursor);
      path.push(cursor);
      cursor = validReplacement.get(cursor);
    }
    if (cursor === undefined || !seen.has(cursor)) continue;
    const cycle = path.slice(path.indexOf(cursor));
    const locations = cycle
      .map((member) => byId.get(member)?.declaration.source)
      .filter((span): span is SourcePos => span !== undefined);
    for (const member of cycle) {
      invalidReplacement.add(member);
      if (cycleReported.has(member)) continue;
      cycleReported.add(member);
      findings.push({
        code: "behavior.replacement-cycle",
        severity: "error",
        message: `Replacement links form a cycle: ${[...cycle, cycle[0]].join(" -> ")}.`,
        ...(byId.get(member) === undefined ? {} : { pos: byId.get(member)!.declaration.source }),
        locations,
      });
    }
  }

  return { findings, duplicateIds, invalidReplacement };
}

/** The report source: the product version, when one was named. */
function sourceOf(version: string | undefined): { readonly version?: string } {
  return version === undefined ? {} : { version };
}

/**
 * Builds the report from a site model. A duplicate id is rejected and both locations are named; an invalid replacement
 * link is named and the behavior is unverified. Every other behavior is resolved against the surface, the tests, and
 * the evidence lock, then projected to public data.
 */
export async function behaviorReportOf(
  options: BehaviorReportOptions,
): Promise<{ readonly report: BehaviorReport; readonly diagnostics: readonly Diagnostic[] }> {
  const { site, root, version } = options;
  const collected = collectedBehaviors(site);
  const structural = structuralFindings(collected);
  const unique = collected
    .filter((entry) => !structural.duplicateIds.has(entry.declaration.id))
    .sort(
      (a, b) =>
        byCodePoint(a.declaration.id, b.declaration.id) ||
        byCodePoint(a.declaration.source.file, b.declaration.source.file) ||
        a.declaration.source.line - b.declaration.source.line,
    );

  const tests = await resolveTests(unique.map((entry) => entry.declaration), root);
  const pins = await evidencePinsOf(root);
  const evidence = resolveEvidence(unique.map((entry) => entry.declaration), pins);
  const items = unique.some((entry) => entry.declaration.surface.length > 0)
    ? await surfaceItemsOf(root, site, version)
    : new Map<string, SurfaceItem>();

  const behaviors: BehaviorRecord[] = [];
  let privateCount = 0;
  unique.forEach((entry, index) => {
    const { declaration, page } = entry;
    if (declaration.public === false) {
      privateCount += 1;
      return;
    }
    const surface = publicSurface(declaration.surface.map((id) => surfaceLinkOf(id, items)));
    const testLinks = tests[index]!;
    const evidenceLinks = evidence[index]!;
    const replacementInvalid =
      declaration.replacement !== undefined && structural.invalidReplacement.has(declaration.id);
    const verification = verificationOf(surface, testLinks, evidenceLinks, declaration.status, replacementInvalid);
    behaviors.push({
      id: declaration.id,
      title: declaration.title,
      normative: declaration.normative,
      source: declaration.source,
      page: { url: page.url, source: page.source.file },
      status: declaration.status,
      versions: declaration.versions,
      ...(declaration.replacement === undefined || replacementInvalid ? {} : { replacement: declaration.replacement }),
      environments: declaration.environments,
      surface,
      tests: testLinks,
      evidence: evidenceLinks,
      verification,
    });
  });

  const findings = [...structural.findings].sort(compareFindings);
  const report: BehaviorReport = {
    version: 1,
    source: sourceOf(version),
    policy: BEHAVIOR_EVIDENCE_POLICY,
    behaviors,
    coverage: behaviorCoverageOf(behaviors, privateCount),
    findings,
  };
  return {
    report,
    diagnostics: sortBehaviorDiagnostics(findings.map(diagnosticOf)),
  };
}

/** The diagnostics a report's findings stand for, so `mizzen check` and the CLI report the same problems. */
export function behaviorDiagnosticsOf(report: BehaviorReport): Diagnostic[] {
  return sortBehaviorDiagnostics(report.findings.map(diagnosticOf));
}

/** A stable reference to one behavior, for another feature to store and resolve later. */
export function behaviorReferenceOf(record: BehaviorRecord, version?: string): BehaviorReference {
  return { kind: "behavior", id: record.id, ...(version === undefined ? {} : { version }) };
}

/**
 * The versioned lookup: the contracts at `query.version`, optionally only one support status and one environment.
 * A behavior introduced after the version is absent; a removed behavior is returned as `removed` from its removal
 * version on. Each record carries `statusAtVersion` when the query names a version.
 */
export function queryBehaviors(report: BehaviorReport, query: BehaviorQuery = {}): BehaviorLookupResult {
  const behaviors: BehaviorRecord[] = [];
  for (const record of report.behaviors) {
    let status: BehaviorSupportStatus = record.status;
    if (query.version !== undefined) {
      const atVersion = statusAtVersion(record, query.version);
      if (atVersion === undefined) continue;
      status = atVersion;
    }
    if (query.status !== undefined && status !== query.status) continue;
    if (!environmentCovers(record.environments, query.environment)) continue;
    behaviors.push(
      query.version === undefined ? record : { ...record, statusAtVersion: status },
    );
  }
  return { version: 1, query, behaviors };
}

/** One behavior by stable reference, at the reference's version when it names one. */
export function lookupBehavior(report: BehaviorReport, reference: BehaviorReference): BehaviorRecord | undefined {
  if (reference.kind !== "behavior") return undefined;
  return queryBehaviors(report, reference.version === undefined ? {} : { version: reference.version }).behaviors.find(
    (behavior) => behavior.id === reference.id,
  );
}

/** The report with a filtered behavior list and coverage recomputed for exactly those behaviors. */
export function behaviorReportWith(report: BehaviorReport, behaviors: readonly BehaviorRecord[]): BehaviorReport {
  return { ...report, behaviors, coverage: behaviorCoverageOf(behaviors, report.coverage.private) };
}

/** The versions a behavior passed through, in the report's own order. */
export function versionHistoryText(record: Pick<BehaviorRecord, "versions">): string {
  const parts = [`introduced ${record.versions.introduced}`];
  if (record.versions.changed !== undefined) parts.push(`changed ${record.versions.changed.join(", ")}`);
  if (record.versions.deprecated !== undefined) parts.push(`deprecated ${record.versions.deprecated}`);
  if (record.versions.removed !== undefined) parts.push(`removed ${record.versions.removed}`);
  return parts.join("; ");
}

/** True when two version histories, statuses, titles, statements, or environments differ. */
function contractChanged(before: BehaviorRecord, after: BehaviorRecord): boolean {
  return (
    before.title !== after.title ||
    before.normative !== after.normative ||
    before.status !== after.status ||
    before.replacement !== after.replacement ||
    canonicalJson(before.versions) !== canonicalJson(after.versions) ||
    canonicalJson(before.environments) !== canonicalJson(after.environments) ||
    before.page.source !== after.page.source
  );
}

/** The signature and surface changes between two behavior records. */
function surfaceDrift(before: readonly BehaviorSurfaceLink[], after: readonly BehaviorSurfaceLink[]): BehaviorDrift["kinds"][number][] {
  const kinds = new Set<BehaviorDrift["kinds"][number]>();
  const left = new Map(before.map((link) => [link.item, link]));
  const right = new Map(after.map((link) => [link.item, link]));
  for (const [item, link] of right) {
    const earlier = left.get(item);
    if (earlier === undefined) {
      kinds.add("surface-added");
      continue;
    }
    if (earlier.state !== link.state || earlier.signature !== link.signature) kinds.add("signature");
  }
  for (const item of left.keys()) if (!right.has(item)) kinds.add("surface-removed");
  return [...kinds];
}

/** True when the linked tests or their file digests differ. */
function testsChanged(before: readonly BehaviorTestLink[], after: readonly BehaviorTestLink[]): boolean {
  return canonicalJson(before) !== canonicalJson(after);
}

/** True when the evidence links or their digests differ. */
function evidenceChanged(before: readonly BehaviorEvidenceLink[], after: readonly BehaviorEvidenceLink[]): boolean {
  return canonicalJson(before) !== canonicalJson(after);
}

/**
 * Compares two reports by behavior id. A change to a linked signature, the tests, or the evidence flags that behavior
 * for review; the drift entry carries the documentation and the tests together, so a reviewer sees both sides. A file
 * rename with the same resolved state is not drift.
 */
export function compareBehaviorReports(baseline: BehaviorReport, current: BehaviorReport): BehaviorComparison {
  const before = new Map(baseline.behaviors.map((behavior) => [behavior.id, behavior]));
  const after = new Map(current.behaviors.map((behavior) => [behavior.id, behavior]));
  const added: string[] = [];
  const removed: string[] = [];
  const drift: BehaviorDrift[] = [];
  let unchanged = 0;

  for (const [id, behavior] of after) {
    const earlier = before.get(id);
    if (earlier === undefined) {
      added.push(id);
      continue;
    }
    const kinds = new Set<BehaviorDrift["kinds"][number]>(surfaceDrift(earlier.surface, behavior.surface));
    if (testsChanged(earlier.tests, behavior.tests)) kinds.add("test");
    if (evidenceChanged(earlier.evidence, behavior.evidence)) kinds.add("evidence");
    if (contractChanged(earlier, behavior)) kinds.add("contract");
    if (kinds.size === 0) {
      unchanged += 1;
      continue;
    }
    drift.push({
      behavior: id,
      kinds: DRIFT_ORDER.filter((kind) => kinds.has(kind)),
      documentation: {
        title: behavior.title,
        normative: behavior.normative,
        source: behavior.source,
        page: behavior.page,
      },
      surface: { before: earlier.surface, after: behavior.surface },
      tests: { before: earlier.tests, after: behavior.tests },
      evidence: { before: earlier.evidence, after: behavior.evidence },
    });
  }
  for (const id of before.keys()) if (!after.has(id)) removed.push(id);

  return {
    version: 1,
    ...(baseline.source.version === undefined ? {} : { baseline: baseline.source.version }),
    ...(current.source.version === undefined ? {} : { current: current.source.version }),
    added: added.sort(byCodePoint),
    removed: removed.sort(byCodePoint),
    drift: drift.sort((a, b) => byCodePoint(a.behavior, b.behavior)),
    unchanged,
  };
}
