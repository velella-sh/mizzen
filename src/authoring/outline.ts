/**
 * Build an evidence-first outline: behavior, prerequisites, an example, limitations, and references (#1409).
 *
 * Each section names the evidence it already has and whether it still needs more. A section is never filled with a
 * plausible sentence: without a behavior contract the behavior section says what to establish, and without a test or
 * example the example section asks for one. The draft must cover every section, so an evidence gap cannot disappear
 * between the task and the preview.
 */
import type { BehaviorRecord, SourcePos } from "../contracts/index.ts";
import type {
  AuthoringEvidenceRef,
  AuthoringOutlineSection,
  AuthoringPageType,
  AuthoringQuestion,
  AuthoringSurfaceItem,
  AuthoringUnknown,
} from "../contracts/authoring.ts";
import { formatSpan } from "../source/spans.ts";

/** What an outline needs. */
export interface AuthoringOutlineInput {
  readonly item: AuthoringSurfaceItem;
  readonly pageType: AuthoringPageType;
  /** The behavior contracts that link this surface item, if any. */
  readonly behaviors: readonly BehaviorRecord[];
  readonly requiredEvidence: readonly AuthoringEvidenceRef[];
  readonly unknowns: readonly AuthoringUnknown[];
  readonly questions: readonly AuthoringQuestion[];
}

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** True for the evidence kinds a runnable example can use. */
function isExampleEvidence(entry: AuthoringEvidenceRef): boolean {
  return entry.kind === "test" || entry.kind === "example";
}

/** Every limitation the item already states. */
export function limitationsOf(
  item: AuthoringSurfaceItem,
  behaviors: readonly BehaviorRecord[],
  unknowns: readonly AuthoringUnknown[],
): string[] {
  const out: string[] = [];
  if (item.stability !== "stable") out.push(`The surface item is ${item.stability}.`);
  for (const behavior of behaviors) {
    if (behavior.status !== "supported") out.push(`Behavior \`${behavior.id}\` is ${behavior.status}.`);
    if (behavior.status === "deprecated" || behavior.status === "removed") {
      out.push(behavior.replacement === undefined
        ? `Behavior \`${behavior.id}\` has no declared replacement.`
        : `Behavior \`${behavior.id}\` is replaced by \`${behavior.replacement}\`.`);
    }
  }
  for (const unknown of unknowns) out.push(unknown.statement);
  return [...new Set(out)];
}

/** The prerequisite sentence for one surface kind. */
function prerequisiteOf(item: AuthoringSurfaceItem): string {
  switch (item.kind) {
    case "command":
    case "flag":
    case "argument":
      return "The CLI is installed, and the command runs from the site root.";
    case "symbol":
      return `The package is installed and \`${item.name}\` is imported from \`${item.source.file}\`.`;
    case "operation":
    case "parameter":
    case "response":
      return "The API is reachable at its documented base URL, and the request is authenticated if it needs to be.";
    case "config-key":
      return "The site has a `mizzen.yml` that uses this key.";
    case "collection":
    case "field":
      return "The collection is configured, and the field is allowed by its public policy.";
    case "version":
      return "The site publishes version folders and selects a default version.";
    default:
      return "The documented product surface is available at the version this page targets.";
  }
}

/** The point each prerequisites section makes. */
function prerequisitesSection(item: AuthoringSurfaceItem, requiredEvidence: readonly AuthoringEvidenceRef[]): AuthoringOutlineSection {
  return {
    kind: "prerequisites",
    heading: "Prerequisites",
    points: [prerequisiteOf(item)],
    evidence: requiredEvidence.filter((entry) => entry.kind === "source").slice(0, 1),
    needsEvidence: false,
  };
}

/** The behavior section: the normative statements, or the fact that none exists yet. */
function behaviorSection(item: AuthoringSurfaceItem, behaviors: readonly BehaviorRecord[]): AuthoringOutlineSection {
  if (behaviors.length === 0) {
    return {
      kind: "behavior",
      heading: "Behavior",
      points: [`State what \`${item.name}\` does, and when a reader should use it.`],
      evidence: [],
      needsEvidence: true,
      needsEvidenceReason: `No behavior contract links \`${item.id}\`, so its supported behavior is not established.`,
    };
  }
  const unverified = behaviors.filter((behavior) => behavior.verification.status !== "verified");
  return {
    kind: "behavior",
    heading: "Behavior",
    points: behaviors.map((behavior) => behavior.normative),
    evidence: behaviors.map((behavior) => ({ kind: "behavior" as const, ref: behavior.id, detail: `Behavior contract for ${item.id}.` })),
    needsEvidence: unverified.length > 0,
    ...(unverified.length === 0
      ? {}
      : {
          needsEvidenceReason: unverified
            .map((behavior) => `\`${behavior.id}\` is unverified: ${behavior.verification.reasons.join(", ")}.`)
            .join(" "),
        }),
  };
}

/** The example section: a runnable test or example, or a request for one. */
function exampleSection(requiredEvidence: readonly AuthoringEvidenceRef[]): AuthoringOutlineSection {
  const examples = requiredEvidence.filter(isExampleEvidence).sort((a, b) => byCodePoint(a.ref, b.ref));
  if (examples.length === 0) {
    return {
      kind: "example",
      heading: "Example",
      points: ["Add a runnable example that proves the behavior and shows its expected output."],
      evidence: [],
      needsEvidence: true,
      needsEvidenceReason: "No test or example is linked to this item yet.",
    };
  }
  return {
    kind: "example",
    heading: "Example",
    points: examples.map((entry) => `Run \`${entry.ref}\` and state the output it must print.`),
    evidence: examples,
    needsEvidence: false,
  };
}

/** The limitations section: the item's own limitations and explicit unknowns. */
function limitationsSection(
  item: AuthoringSurfaceItem,
  behaviors: readonly BehaviorRecord[],
  unknowns: readonly AuthoringUnknown[],
  limitations: readonly string[],
): AuthoringOutlineSection {
  const stated = limitations.length === 0 ? ["No limitation is known from the present evidence."] : [...limitations];
  const evidence: AuthoringEvidenceRef[] = [];
  for (const behavior of behaviors) {
    if (behavior.status === "experimental") {
      evidence.push({ kind: "behavior", ref: behavior.id, detail: `The behavior is experimental.` });
    }
  }
  for (const unknown of unknowns) {
    if (unknown.evidence !== undefined) evidence.push({ kind: "evidence", ref: unknown.evidence, detail: unknown.statement });
  }
  return {
    kind: "limitations",
    heading: "Limitations",
    points: stated,
    evidence,
    needsEvidence: unknowns.length > 0,
    ...(unknowns.length === 0 ? {} : { needsEvidenceReason: `${unknowns.length} explicit unknown(s) must be settled or stated as limits.` }),
  };
}

/** The references section: the declaration, behavior, tests, and evidence. */
function referencesSection(
  item: AuthoringSurfaceItem,
  behaviors: readonly BehaviorRecord[],
  requiredEvidence: readonly AuthoringEvidenceRef[],
  source: SourcePos,
): AuthoringOutlineSection {
  const points = [`\`${item.id}\` is declared at \`${formatSpan(source)}\`.`];
  const evidence: AuthoringEvidenceRef[] = [{ kind: "surface", ref: item.id, detail: "The public surface declaration." }];
  for (const behavior of behaviors) {
    points.push(`Behavior \`${behavior.id}\` is declared at \`${formatSpan(behavior.source)}\`.`);
    for (const test of behavior.tests) {
      points.push(`Test \`${test.file}\` is expected to ${test.outcome}.`);
    }
    for (const link of behavior.evidence) {
      if (link.state === "resolved") points.push(`Evidence: \`${link.url ?? link.id ?? behavior.id}\`.`);
    }
  }
  for (const entry of requiredEvidence) {
    if (entry.kind === "surface" || entry.kind === "behavior") continue;
    evidence.push(entry);
  }
  return { kind: "references", heading: "References", points, evidence, needsEvidence: false };
}

/** Builds the five sections in their fixed order. */
export function outlineOf(input: AuthoringOutlineInput): readonly AuthoringOutlineSection[] {
  const limitations = limitationsOf(input.item, input.behaviors, input.unknowns);
  return [
    behaviorSection(input.item, input.behaviors),
    prerequisitesSection(input.item, input.requiredEvidence),
    exampleSection(input.requiredEvidence),
    limitationsSection(input.item, input.behaviors, input.unknowns, limitations),
    referencesSection(input.item, input.behaviors, input.requiredEvidence, input.item.source),
  ];
}

/** Every section that still needs evidence, in outline order. */
export function sectionsNeedingEvidence(sections: readonly AuthoringOutlineSection[]): readonly AuthoringOutlineSection[] {
  return sections.filter((section) => section.needsEvidence);
}

/** The limitations a draft must carry, in a stable order. */
export function requiredLimitations(input: AuthoringOutlineInput): readonly string[] {
  return limitationsOf(input.item, input.behaviors, input.unknowns);
}
