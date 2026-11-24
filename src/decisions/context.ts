/**
 * Decision memory inside an editing context.
 *
 * The compiler includes the decisions in effect for the pages and collections a task edits, and the constraints each
 * decision states, as active rules. Only a decision that is in effect at the task's version or snapshot is a rule: a
 * superseded, rejected, or deprecated decision is never active, so an agent does not follow a rule that was replaced.
 * A record the caller may not read, or whose citation the access policy refuses, is left out entirely.
 *
 * The rules carry a citation (the decision id and its source span), so the pack can prove where a rule came from. A
 * private rationale is replaced with the placeholder, and a private citation disappears, under the same policy the rest
 * of the pack applies.
 */
import type { DecisionQuery, DecisionRecord } from "../contracts/decisions.ts";
import type { AccessPolicy } from "../contracts/permissions.ts";
import type { Site } from "../contracts/index.ts";
import type { TaskContract } from "../contracts/task.ts";
import { decisionReadable, publishedCitation } from "./access.ts";
import { appliesAt } from "./lifecycle.ts";

/** One active rule a decision contributes to a pack. */
export interface ContextRule {
  /** The decision id the rule comes from. */
  readonly decision: string;
  readonly title: string;
  readonly status: DecisionRecord["status"];
  /** The decision's `Decision` text, when it is public; a private one is the withheld placeholder. */
  readonly rule: string;
  /** The rationale, when the record publishes it; absent otherwise. */
  readonly rationale?: string;
  /** One line per rejected alternative, when the record publishes them. */
  readonly alternatives: readonly { readonly name: string; readonly rejectedBecause?: string }[];
  /** The citation a reader follows: `decision:<id>` at the record's span, or the withheld placeholder when private. */
  readonly citation: string;
  /** The record's span, so a caller can point at the file. */
  readonly span: string;
}

/** What a pack's decisions section carries. */
export interface ContextDecisions {
  /** The rules in effect for the task, sorted by decision id. */
  readonly rules: readonly ContextRule[];
  /** The decisions that would apply but are not in effect, so a reader sees the history without following it. */
  readonly history: readonly { readonly decision: string; readonly title: string; readonly status: DecisionRecord["status"] }[];
  /** The ids the pack left out for a permission reason, so a gap is named rather than silently empty. */
  readonly withheld: readonly string[];
}

/** The version and snapshot a task's context is compiled for. A task has no version, so the query is by snapshot. */
export function queryOf(site: Site, task: TaskContract): DecisionQuery {
  void site;
  return { snapshot: task.snapshot.id };
}

/** Whether a record's links name a page or collection the task edits, by URL, source path, or stable id. */
function affects(record: DecisionRecord, task: TaskContract, site: Site): boolean {
  const pages = new Set<string>();
  for (const ref of [...task.scope.pages, ...task.scope.files]) {
    const cleaned = ref.trim().replace(/^\/+|\/+$/g, "");
    pages.add(cleaned);
    pages.add(`${cleaned}.md`);
    const page = site.pages.find((candidate) => candidate.url.replace(/^\/+|\/+$/g, "") === cleaned || candidate.source.file === cleaned);
    if (page !== undefined) {
      pages.add(page.source.file);
      pages.add(page.url.replace(/^\/+|\/+$/g, ""));
    }
  }
  for (const link of record.links) {
    if (link.kind === "page") {
      const cleaned = link.id.trim().replace(/^\/+|\/+$/g, "");
      if (pages.has(cleaned) || pages.has(`${cleaned}.md`)) return true;
    }
    if (link.kind === "collection" && task.scope.collections.includes(link.id)) return true;
    if (link.kind === "behavior" && task.scope.blocks.some((block) => block === link.id)) return true;
  }
  return false;
}

/**
 * The decisions a task's context must carry: those in effect at the task's version or snapshot and affecting the pages
 * or collections it edits. A record the caller may not read is withheld and named; a superseded record is history, not
 * an active rule.
 */
export function contextDecisionsOf(
  site: Site,
  task: TaskContract,
  options: { readonly access?: AccessPolicy; readonly allow?: readonly string[] },
): ContextDecisions {
  const records = site.decisions ?? [];
  const query = queryOf(site, task);
  const ruleIds = new Set<string>();
  const withheld: string[] = [];
  const rules: ContextRule[] = [];
  const history: { decision: string; title: string; status: DecisionRecord["status"] }[] = [];

  for (const record of records) {
    if (!affects(record, task, site)) continue;
    if (!decisionReadable(record, options.allow, options.access)) {
      withheld.push(record.id);
      continue;
    }
    if (!appliesAt(record, query)) continue;
    if (record.status !== "accepted" && record.status !== "proposed") {
      history.push({ decision: record.id, title: record.title, status: record.status });
      continue;
    }
    if (ruleIds.has(record.id)) continue;
    ruleIds.add(record.id);
    const published = record.public;
    rules.push({
      decision: record.id,
      title: record.title,
      status: record.status,
      rule: record.decision === undefined ? "" : published ? record.decision.text : "[text withheld]",
      ...(record.rationale === undefined ? {} : { rationale: published ? record.rationale.text : "[text withheld]" }),
      alternatives: record.alternatives.map((alternative) => ({
        name: alternative.name,
        ...(alternative.rejectedBecause === undefined
          ? {}
          : { rejectedBecause: published ? alternative.rejectedBecause.text : "[reason withheld]" }),
      })),
      citation: published ? `decision:${record.id}` : publishedCitation(record, options.access, published),
      span: spanText(record),
    });
  }

  // A record in effect at the query but superseded by a newer one in effect is not an active rule: remove it.
  const superseded = new Set<string>();
  for (const record of records) {
    if (!appliesAt(record, query) || (record.status !== "accepted" && record.status !== "proposed")) continue;
    for (const target of record.supersedes) superseded.add(target);
  }
  const active = rules.filter((rule) => !superseded.has(rule.decision) || rule.status === "proposed");

  return {
    rules: [...active].sort((a, b) => (a.decision < b.decision ? -1 : a.decision > b.decision ? 1 : 0)),
    history: history.sort((a, b) => (a.decision < b.decision ? -1 : a.decision > b.decision ? 1 : 0)),
    withheld: [...new Set(withheld)].sort(),
  };
}

/** The record's span as `path:line:column-endLine:endColumn`, without importing the formatter for one line. */
function spanText(record: DecisionRecord): string {
  const span = record.span;
  return `${span.file.replace(/\\/g, "/")}:${span.line}:${span.column}-${span.endLine}:${span.endColumn}`;
}
