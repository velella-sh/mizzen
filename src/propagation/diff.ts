/**
 * `diffSnapshots(baseline, current)`: the versioned semantic changes between two locked snapshots of one project.
 *
 * Only the public contract is diffed — the surface, behavior contracts, public decisions, and published evidence — so
 * a change to a page body, a graph label, or a private rationale emits nothing. Every event names the exact source span
 * it was read from and a hash of the changed record. The output is sorted, so the same two snapshots give byte-identical
 * events whatever order their lists arrived in.
 */
import type { BehaviorRecord } from "../contracts/behavior.ts";
import type { DecisionRecord } from "../contracts/decisions.ts";
import type { FederationEvidenceBundle } from "../contracts/federation.ts";
import type { SemanticChange, SnapshotView } from "../contracts/propagation.ts";
import type { SurfaceItem } from "../contracts/surface.ts";
import { byCodePoint, compareChanges, stableHash } from "./contract.ts";

/** One event before the snapshot's project is added. */
type LocalChange = Omit<SemanticChange, "project">;

/** True when two values serialize to the same canonical bytes. */
function same(a: unknown, b: unknown): boolean {
  return stableHash(a) === stableHash(b);
}

/** A value as a stable string: a string unchanged, anything else by its hash. */
function describe(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : stableHash(value);
}

/** Builds one event. */
function event(input: {
  readonly subject: SemanticChange["subject"];
  readonly kind: SemanticChange["kind"];
  readonly ref: string;
  readonly record: string;
  readonly hash: string;
  readonly source?: SemanticChange["source"] | undefined;
  readonly before?: string | undefined;
  readonly after?: string | undefined;
  readonly pages?: readonly string[] | undefined;
  readonly files?: readonly string[] | undefined;
}): LocalChange {
  return {
    version: 1,
    subject: input.subject,
    kind: input.kind,
    ref: input.ref,
    record: input.record,
    ...(input.source === undefined ? {} : { source: input.source }),
    hash: input.hash,
    ...(input.before === undefined ? {} : { before: input.before }),
    ...(input.after === undefined ? {} : { after: input.after }),
    ...(input.pages === undefined ? {} : { pages: input.pages }),
    ...(input.files === undefined ? {} : { files: input.files }),
    external: true,
  };
}

/** The surface item changes. */
function surfaceChanges(baseline: readonly SurfaceItem[], current: readonly SurfaceItem[]): LocalChange[] {
  const before = new Map(baseline.map((item) => [item.id, item]));
  const after = new Map(current.map((item) => [item.id, item]));
  const changes: LocalChange[] = [];
  for (const [id, item] of after) {
    const earlier = before.get(id);
    const hash = stableHash(item);
    const files = [item.source.file];
    if (earlier === undefined) {
      changes.push(event({ subject: "surface", kind: "added", ref: id, record: id, hash, source: item.source, after: describe(item), files }));
      continue;
    }
    if (earlier.name !== item.name || !same(earlier.signature, item.signature)) {
      changes.push(
        event({
          subject: "surface",
          kind: "signature",
          ref: id,
          record: id,
          hash,
          source: item.source,
          before: describe(earlier.signature ?? earlier.name),
          after: describe(item.signature ?? item.name),
          files,
        }),
      );
    }
    if (earlier.stability !== item.stability || !same(earlier.version, item.version)) {
      changes.push(
        event({
          subject: "surface",
          kind: "status",
          ref: id,
          record: id,
          hash,
          source: item.source,
          before: describe({ stability: earlier.stability, version: earlier.version }),
          after: describe({ stability: item.stability, version: item.version }),
          files,
        }),
      );
    }
    if (earlier.area !== item.area || earlier.kind !== item.kind) {
      changes.push(
        event({
          subject: "surface",
          kind: "scope",
          ref: id,
          record: id,
          hash,
          source: item.source,
          before: `${earlier.area}:${earlier.kind}`,
          after: `${item.area}:${item.kind}`,
          files,
        }),
      );
    }
    if (earlier.parent !== item.parent) {
      changes.push(
        event({
          subject: "surface",
          kind: "link",
          ref: id,
          record: id,
          hash,
          source: item.source,
          ...(earlier.parent === undefined ? {} : { before: earlier.parent }),
          ...(item.parent === undefined ? {} : { after: item.parent }),
          files,
        }),
      );
    }
  }
  for (const [id, item] of before) {
    if (after.has(id)) continue;
    changes.push(
      event({
        subject: "surface",
        kind: "removed",
        ref: id,
        record: id,
        hash: stableHash(item),
        source: item.source,
        before: describe(item),
        files: [item.source.file],
      }),
    );
  }
  return changes;
}

/** A behavior as public output can see it: private test names and evidence values are left out of the hash. */
function behaviorShape(behavior: BehaviorRecord): unknown {
  return {
    id: behavior.id,
    title: behavior.title,
    normative: behavior.normative,
    status: behavior.status,
    versions: behavior.versions,
    replacement: behavior.replacement,
    environments: behavior.environments,
    surface: behavior.surface,
    tests: behavior.tests.map((test) => ({
      file: test.file,
      ...(test.redacted === true ? {} : { name: test.name }),
      outcome: test.outcome,
      state: test.state,
      digest: test.digest,
    })),
    evidence: behavior.evidence.map((entry) => ({
      kind: entry.kind,
      state: entry.state,
      ...(entry.redacted === true ? {} : { id: entry.id, url: entry.url, title: entry.title }),
      digest: entry.digest,
    })),
    page: behavior.page,
    verification: behavior.verification,
  };
}

/** The behavior contract changes. */
function behaviorChanges(baseline: readonly BehaviorRecord[], current: readonly BehaviorRecord[]): LocalChange[] {
  const before = new Map(baseline.map((record) => [record.id, record]));
  const after = new Map(current.map((record) => [record.id, record]));
  const changes: LocalChange[] = [];
  for (const [id, record] of after) {
    const earlier = before.get(id);
    const hash = stableHash(behaviorShape(record));
    const ref = `behavior:${id}`;
    const pages = [record.page.url, record.page.source];
    if (earlier === undefined) {
      changes.push(event({ subject: "behavior", kind: "added", ref, record: id, hash, source: record.source, after: describe(record.normative), pages }));
      continue;
    }
    if (earlier.title !== record.title || earlier.normative !== record.normative) {
      changes.push(
        event({
          subject: "behavior",
          kind: "signature",
          ref,
          record: id,
          hash,
          source: record.source,
          before: describe(earlier.normative),
          after: describe(record.normative),
          pages,
        }),
      );
    }
    if (earlier.status !== record.status || !same(earlier.versions, record.versions)) {
      changes.push(
        event({
          subject: "behavior",
          kind: "status",
          ref,
          record: id,
          hash,
          source: record.source,
          before: describe({ status: earlier.status, versions: earlier.versions }),
          after: describe({ status: record.status, versions: record.versions }),
          pages,
        }),
      );
    }
    if (earlier.replacement !== record.replacement || !same(earlier.surface, record.surface) || !same(earlier.page, record.page)) {
      changes.push(
        event({
          subject: "behavior",
          kind: "link",
          ref,
          record: id,
          hash,
          source: record.source,
          before: describe({ replacement: earlier.replacement, surface: earlier.surface, page: earlier.page }),
          after: describe({ replacement: record.replacement, surface: record.surface, page: record.page }),
          pages,
        }),
      );
    }
    if (!same(earlier.tests, record.tests) || !same(earlier.evidence, record.evidence) || !same(earlier.verification, record.verification)) {
      changes.push(
        event({
          subject: "behavior",
          kind: "digest",
          ref,
          record: id,
          hash,
          source: record.source,
          before: describe({ tests: earlier.tests, evidence: earlier.evidence }),
          after: describe({ tests: record.tests, evidence: record.evidence }),
          pages,
        }),
      );
    }
    if (!same(earlier.environments, record.environments)) {
      changes.push(
        event({
          subject: "behavior",
          kind: "scope",
          ref,
          record: id,
          hash,
          source: record.source,
          before: describe(earlier.environments),
          after: describe(record.environments),
          pages,
        }),
      );
    }
  }
  for (const [id, record] of before) {
    if (after.has(id)) continue;
    changes.push(
      event({
        subject: "behavior",
        kind: "removed",
        ref: `behavior:${id}`,
        record: id,
        hash: stableHash(behaviorShape(record)),
        source: record.source,
        before: describe(record.normative),
        pages: [record.page.url, record.page.source],
      }),
    );
  }
  return changes;
}

/** A decision as public output can see it: a private rationale and source never reach the hash or an event. */
function decisionShape(record: DecisionRecord): unknown {
  return {
    id: record.id,
    title: record.title,
    status: record.status,
    date: record.date,
    supersedes: record.supersedes,
    supersededBy: record.supersededBy,
    validity: record.validity,
    links: record.links,
    evidence: record.evidence,
    context: record.context?.text,
    decision: record.decision?.text,
    rationale: record.public ? record.rationale?.text : undefined,
    alternatives: record.alternatives.map((alternative) => ({
      name: alternative.name,
      rejectedBecause: alternative.rejectedBecause?.text,
    })),
    audience: record.audience,
    public: record.public,
  };
}

/** The decision changes. */
function decisionChanges(baseline: readonly DecisionRecord[], current: readonly DecisionRecord[]): LocalChange[] {
  const before = new Map(baseline.map((record) => [record.id, record]));
  const after = new Map(current.map((record) => [record.id, record]));
  const changes: LocalChange[] = [];
  for (const [id, record] of after) {
    const earlier = before.get(id);
    const hash = stableHash(decisionShape(record));
    const ref = `decision:${id}`;
    const pages = record.links.filter((link) => link.kind === "page").map((link) => link.id);
    if (earlier === undefined) {
      changes.push(event({ subject: "decision", kind: "added", ref, record: id, hash, source: record.span, after: record.title, ...(pages.length === 0 ? {} : { pages }) }));
      continue;
    }
    if (earlier.status !== record.status) {
      changes.push(event({ subject: "decision", kind: "status", ref, record: id, hash, source: record.span, before: earlier.status, after: record.status, ...(pages.length === 0 ? {} : { pages }) }));
    }
    if (earlier.title !== record.title || earlier.decision?.text !== record.decision?.text || earlier.context?.text !== record.context?.text || earlier.public !== record.public || (!same(earlier.rationale?.text, record.rationale?.text) && (record.public || earlier.public))) {
      changes.push(
        event({
          subject: "decision",
          kind: "signature",
          ref,
          record: id,
          hash,
          source: record.span,
          before: describe({ title: earlier.title, decision: earlier.decision?.text, context: earlier.context?.text }),
          after: describe({ title: record.title, decision: record.decision?.text, context: record.context?.text }),
          ...(pages.length === 0 ? {} : { pages }),
        }),
      );
    }
    if (!same(earlier.links, record.links) || !same(earlier.supersedes, record.supersedes) || !same(earlier.supersededBy, record.supersededBy)) {
      changes.push(
        event({
          subject: "decision",
          kind: "link",
          ref,
          record: id,
          hash,
          source: record.span,
          before: describe({ links: earlier.links, supersedes: earlier.supersedes, supersededBy: earlier.supersededBy }),
          after: describe({ links: record.links, supersedes: record.supersedes, supersededBy: record.supersededBy }),
          ...(pages.length === 0 ? {} : { pages }),
        }),
      );
    }
    if (!same(earlier.evidence, record.evidence)) {
      changes.push(
        event({
          subject: "decision",
          kind: "digest",
          ref,
          record: id,
          hash,
          source: record.span,
          before: describe(earlier.evidence),
          after: describe(record.evidence),
          ...(pages.length === 0 ? {} : { pages }),
        }),
      );
    }
    if (!same(earlier.validity, record.validity) || !same(earlier.audience, record.audience)) {
      changes.push(
        event({
          subject: "decision",
          kind: "scope",
          ref,
          record: id,
          hash,
          source: record.span,
          before: describe({ validity: earlier.validity, audience: earlier.audience }),
          after: describe({ validity: record.validity, audience: record.audience }),
          ...(pages.length === 0 ? {} : { pages }),
        }),
      );
    }
  }
  for (const [id, record] of before) {
    if (after.has(id)) continue;
    const pages = record.links.filter((link) => link.kind === "page").map((link) => link.id);
    changes.push(
      event({
        subject: "decision",
        kind: "removed",
        ref: `decision:${id}`,
        record: id,
        hash: stableHash(decisionShape(record)),
        source: record.span,
        before: record.title,
        ...(pages.length === 0 ? {} : { pages }),
      }),
    );
  }
  return changes;
}

/** The evidence changes. */
function evidenceChanges(
  baseline: FederationEvidenceBundle | undefined,
  current: FederationEvidenceBundle | undefined,
): LocalChange[] {
  const empty: FederationEvidenceBundle = { version: 1, claims: [], links: [] };
  const before = baseline ?? empty;
  const after = current ?? empty;
  const changes: LocalChange[] = [];
  const claimKey = (claim: FederationEvidenceBundle["claims"][number]): string => claim.id;
  const claimsBefore = new Map(before.claims.map((claim) => [claimKey(claim), claim]));
  const claimsAfter = new Map(after.claims.map((claim) => [claimKey(claim), claim]));
  for (const [id, claim] of claimsAfter) {
    const earlier = claimsBefore.get(id);
    const hash = stableHash(claim);
    if (earlier === undefined) {
      changes.push(event({ subject: "evidence", kind: "added", ref: `evidence:${id}`, record: id, hash, after: describe(claim) }));
      continue;
    }
    if (earlier.subject !== claim.subject || !same(earlier.evidence, claim.evidence)) {
      changes.push(
        event({
          subject: "evidence",
          kind: "link",
          ref: `evidence:${id}`,
          record: id,
          hash,
          before: describe(earlier),
          after: describe(claim),
        }),
      );
    }
  }
  for (const [id, claim] of claimsBefore) {
    if (claimsAfter.has(id)) continue;
    changes.push(event({ subject: "evidence", kind: "removed", ref: `evidence:${id}`, record: id, hash: stableHash(claim), before: describe(claim) }));
  }

  const linkKey = (link: FederationEvidenceBundle["links"][number]): string => `${link.from}\u0000${link.to}\u0000${link.kind}`;
  const linksBefore = new Map(before.links.map((link) => [linkKey(link), link]));
  const linksAfter = new Map(after.links.map((link) => [linkKey(link), link]));
  for (const [key, link] of linksAfter) {
    const earlier = linksBefore.get(key);
    const record = `${link.from}->${link.to}`;
    const hash = stableHash(link);
    if (earlier === undefined) {
      changes.push(event({ subject: "evidence", kind: "added", ref: `evidence:${record}`, record, hash, after: describe(link) }));
      continue;
    }
    if (earlier.digest !== link.digest) {
      changes.push(
        event({
          subject: "evidence",
          kind: "digest",
          ref: `evidence:${record}`,
          record,
          hash,
          before: earlier.digest,
          after: link.digest,
        }),
      );
    }
  }
  for (const [key, link] of linksBefore) {
    if (linksAfter.has(key)) continue;
    changes.push(
      event({
        subject: "evidence",
        kind: "removed",
        ref: `evidence:${link.from}->${link.to}`,
        record: `${link.from}->${link.to}`,
        hash: stableHash(link),
        before: describe(link),
      }),
    );
  }
  return changes;
}

/**
 * Diffs two snapshots of one project. The result is every semantic change to the public contract, sorted, and never a
 * change to page text, a graph label, or a private value. Diffing two different projects is refused.
 */
export function diffSnapshots(baseline: SnapshotView, current: SnapshotView): SemanticChange[] {
  if (baseline.project !== current.project) {
    throw new Error(`Cannot diff ${baseline.project} against ${current.project}: a change event is about one project.`);
  }
  return [
    ...surfaceChanges(baseline.surface, current.surface),
    ...behaviorChanges(baseline.behaviors, current.behaviors),
    ...decisionChanges(baseline.decisions ?? [], current.decisions ?? []),
    ...evidenceChanges(baseline.evidence, current.evidence),
  ]
    .map((change): SemanticChange => ({ ...change, project: current.project }))
    .sort(compareChanges);
}

/** The events that name one ref, sorted. */
export function changesOf(events: readonly SemanticChange[], ref: string): SemanticChange[] {
  return events.filter((event) => event.ref === ref).sort(compareChanges);
}

/** The distinct refs a change set names, sorted by code point. */
export function refsOf(events: readonly SemanticChange[]): string[] {
  return [...new Set(events.map((event) => event.ref))].sort(byCodePoint);
}
