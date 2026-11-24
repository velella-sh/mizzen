/**
 * Compiles one context pack across several projects under a single shared budget.
 *
 * Candidates come from each visible project's own bundle: its behavior contracts (with the surface item each one
 * describes), the evidence claims its public data supports, and the source spans a reference names. Ranking is
 * deterministic and project-independent, so the order never depends on which bundle arrived first.
 *
 * The budget is shared: an equal-turn pass lets each project add its next fragment while the whole Markdown still fits,
 * so no project takes another's share. Every fragment is admitted whole or not at all, and a fragment that would
 * overflow is reported as a `budget` omission that names its project. A project the caller may not read is never named
 * in the items or the omissions, and a missing bundle is reported as a `missing` omission only when its project id is
 * already in the site's own configuration, so its name never discloses a project the caller may not know exists.
 */
import type {
  FederatedCitation,
  FederatedPack,
  FederatedPackItem,
  FederatedPackOmission,
  FederatedPackRequest,
  KnowledgeBundle,
  LoadedFederation,
} from "../contracts/federation.ts";
import { estimateTokens, type TokenEstimate } from "../packs/tokens.ts";
import { byCodePoint, federatedId } from "./contract.ts";
import { readable, visibleBundles } from "./compose.ts";

/** A fragment before it is admitted, with the project and citation it came from. */
interface Candidate {
  readonly project: string;
  readonly citation: FederatedCitation;
  readonly content: string;
  readonly reason: string;
  /** A priority band: lower is kept first, and the band never depends on the budget. */
  readonly band: number;
}

/** The pack's title line. */
function titleOf(goal: string): string {
  return `# Federated context: ${goal.replace(/\s+/g, " ").trim() || "topic"}`;
}

/** One fragment's section: its provenance header and its content. */
function sectionOf(candidate: Candidate, includeBody: boolean): string {
  const lines = [
    `## ${candidate.citation.label.replace(/\s+/g, " ").trim() || candidate.citation.id}`,
    "",
    `- Project: ${candidate.citation.project}`,
    `- Snapshot: ${candidate.citation.snapshot}`,
    `- Citation: \`${candidate.citation.id}\``,
    `- Why: ${candidate.reason}`,
  ];
  const header = lines.join("\n");
  return includeBody && candidate.content !== "" ? `${header}\n\n${candidate.content}` : header;
}

/** The whole Markdown, with or without bodies. */
function render(goal: string, candidates: readonly Candidate[], includeBody = true): string {
  const parts = [titleOf(goal)];
  for (const candidate of candidates) parts.push(sectionOf(candidate, includeBody));
  return `${parts.join("\n\n")}\n`;
}

/** The exact Markdown's estimate, split into its parts. */
function estimateOf(goal: string, candidates: readonly Candidate[]): { readonly body: TokenEstimate; readonly template: TokenEstimate } {
  return {
    body: estimateTokens(render(goal, candidates)),
    template: estimateTokens(render(goal, candidates, false)),
  };
}

/** One citation for a local id of a bundle. */
function citationOf(bundle: KnowledgeBundle, local: string, kind: FederatedCitation["kind"], label: string): FederatedCitation {
  return {
    id: federatedId(bundle.project, bundle.snapshot.id, local),
    project: bundle.project,
    namespace: bundle.namespace,
    snapshot: bundle.snapshot.id,
    local,
    kind,
    label,
  };
}

/** The lower-cased words of a query. */
function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** How many of the query's words a text contains, so a relevant fragment outranks an unrelated one. */
function matchScore(text: string, query: readonly string[]): number {
  if (query.length === 0) return 0;
  const haystack = new Set(words(text));
  return query.filter((word) => haystack.has(word)).length;
}

/**
 * Every candidate the visible bundles can contribute, in a stable order: a behavior that links a surface item, then
 * the evidence a claim resolves, then a graph node that a reference names.
 */
export function candidatesOf(loaded: LoadedFederation, request: FederatedPackRequest): Candidate[] {
  const visible = visibleBundles(loaded, request.allow);
  const query = words(request.goal);
  const starts = request.from.map((entry) => entry.trim()).filter((entry) => entry !== "");
  const candidates: Candidate[] = [];
  for (const bundle of [...visible.values()].sort((a, b) => byCodePoint(a.project, b.project))) {
    for (const behavior of bundle.behaviors) {
      const text = `${behavior.title}\n\n${behavior.normative}`;
      candidates.push({
        project: bundle.project,
        citation: citationOf(bundle, `behavior:${behavior.id}`, "behavior", behavior.title),
        content: `${behavior.normative}\n\n- Status: ${behavior.status}\n- Source: \`${behavior.page.source}\``,
        reason: `behavior.${behavior.status}`,
        band: matchScore(text, query) > 0 ? 0 : 2,
      });
    }
    for (const claim of bundle.evidence.claims) {
      const text = `${claim.subject}\n\n${claim.id}`;
      candidates.push({
        project: bundle.project,
        citation: citationOf(bundle, `evidence:${claim.id}`, "evidence", claim.subject),
        content: `- Claim: \`${claim.id}\`\n- Evidence: ${claim.evidence.map((id) => `\`${id}\``).join(", ")}`,
        reason: "evidence.claims",
        band: matchScore(text, query) > 0 ? 1 : 3,
      });
    }
    for (const node of bundle.graph.nodes) {
      // A start citation pins the node it names. Without one, no bare graph node is a candidate: a pack never becomes a
      // dump of every page, and a reader asks for what it needs.
      if (!starts.some((entry) => entry === node.id || entry === federatedId(bundle.project, bundle.snapshot.id, node.id))) {
        continue;
      }
      candidates.push({
        project: bundle.project,
        citation: citationOf(bundle, node.id, "page", node.label),
        content: node.url === undefined ? "" : `- URL: ${node.url}`,
        reason: "scope.start",
        band: 0,
      });
    }
  }
  // The order is the ranking: relevance band, then project, then the citation id, so it never depends on arrival order.
  return candidates.sort(
    (a, b) => a.band - b.band || byCodePoint(a.project, b.project) || byCodePoint(a.citation.id, b.citation.id),
  );
}

/** True when an admission's exact Markdown's upper bound still fits the budget. */
function fits(goal: string, admitted: readonly Candidate[], budget: number): boolean {
  const estimate = estimateOf(goal, admitted);
  const used = estimate.body.tokens + estimate.template.tokens;
  return Math.ceil(used * (1 + estimate.body.margin)) <= budget;
}

/** The token count of one candidate's own content, for the accounting. */
function contentTokens(candidate: Candidate): number {
  return estimateTokens(candidate.content).tokens;
}

/**
 * Compiles a pack. The equal-turn pass visits projects in a stable order and lets each add its next candidate while
 * the exact Markdown still fits, so one project cannot take another's whole share. A refused candidate is a `budget`
 * omission that names its project.
 */
export function compileFederationPack(loaded: LoadedFederation, request: FederatedPackRequest): FederatedPack {
  const budget = Math.max(0, request.budget);
  const all = candidatesOf(loaded, request);
  const perProject = request.perProject === undefined ? Number.POSITIVE_INFINITY : Math.max(0, request.perProject);

  // Group by project, keeping the ranking inside each group.
  const groups = new Map<string, Candidate[]>();
  for (const candidate of all) groups.set(candidate.project, [...(groups.get(candidate.project) ?? []), candidate]);
  const order = [...groups.keys()].sort(byCodePoint);
  const admitted: Candidate[] = [];
  const omitted: FederatedPackOmission[] = [];
  const taken = new Map<string, number>();

  let progress = true;
  while (progress) {
    progress = false;
    for (const project of order) {
      const group = groups.get(project)!;
      const index = taken.get(project) ?? 0;
      if (index >= group.length) continue;
      const mine = taken.get(project) ?? 0;
      if (mine >= perProject) continue;
      const candidate = group[index]!;
      taken.set(project, index + 1);
      if (fits(request.goal, [...admitted, candidate], budget)) {
        admitted.push(candidate);
        progress = true;
      } else {
        const estimate = estimateOf(request.goal, [...admitted, candidate]);
        const used = estimate.body.tokens + estimate.template.tokens;
        omitted.push({
          project,
          ref: candidate.citation.id,
          reason: "budget",
          detail: `\`${candidate.citation.label}\` needs ${contentTokens(candidate)} tokens; admitting it would bring the pack to ${used}, ${used - budget} over the ${budget}-token budget.`,
        });
        progress = true;
      }
    }
  }

  // Keep the admitted order as the ranking order, so the Markdown is stable.
  const order_ = new Map(all.map((candidate, index) => [candidate.citation.id, index] as const));
  admitted.sort((a, b) => (order_.get(a.citation.id) ?? 0) - (order_.get(b.citation.id) ?? 0));

  const markdown = render(request.goal, admitted);
  const body = estimateTokens(markdown);
  const template = estimateTokens(render(request.goal, admitted, false));
  const fragments = admitted.reduce((sum, candidate) => sum + contentTokens(candidate), 0);
  const safety = Math.max(0, body.tokens - fragments - template.tokens);
  const items: FederatedPackItem[] = admitted.map((candidate) => ({
    project: candidate.project,
    citation: candidate.citation,
    content: candidate.content,
    tokens: contentTokens(candidate),
    reason: candidate.reason,
  }));

  // A project the caller may read whose bundle is absent is a `missing` omission; a required one also makes the pack
  // partial. A project that is not readable is never named.
  const visible = visibleBundles(loaded, request.allow);
  const missingOmissions: FederatedPackOmission[] = loaded.missing
    .filter((entry) => visible.has(entry.project) || !loaded.bundles.has(entry.project))
    .map((entry) => ({
      project: entry.project,
      ref: `project:${entry.project}`,
      reason: "missing",
      detail: `the snapshot of "${entry.project}" is missing: ${entry.reason}`,
    }));

  const omissions = [...omitted, ...missingOmissions].sort(
    (a, b) => byCodePoint(a.project ?? "", b.project ?? "") || byCodePoint(a.ref, b.ref),
  );

  return {
    version: 1,
    goal: request.goal,
    budget,
    markdown,
    items,
    accounting: {
      requested: budget,
      fragments,
      template: template.tokens,
      safety,
      used: body.tokens,
      remaining: budget - body.tokens,
      upper: body.upper,
      margin: body.margin,
    },
    omissions,
    missing: loaded.missing,
    partial: loaded.partial || omissions.length > 0,
  };
}
