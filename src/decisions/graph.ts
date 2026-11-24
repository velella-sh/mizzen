/**
 * Projects each decision record into the graph: one node per decision, carrying what public output may hold and never
 * the rationale, context, decision text, or a private source value. A link is carried with whether the loader resolved
 * it, so the graph draws an edge only to a node the snapshot really holds; a supersession edge is kept only between
 * two decisions this snapshot knows.
 */
import type { GraphDecisionInput } from "../contracts/graph.ts";
import type { DecisionRecord } from "../contracts/decisions.ts";

/** Whether a record's audience makes it visible to a caller with `allow`. */
function visible(record: DecisionRecord, allow: readonly string[] | undefined): boolean {
  if (record.audience.length === 0) return true;
  if (allow === undefined) return false;
  return record.audience.every((audience) => allow.includes(audience));
}

/**
 * The graph input of every decision. A record whose audience the caller may not read is left out entirely, so its id
 * never reaches a node. A private record still contributes its structure — status, links, supersession — because that
 * is what makes a "why" query answerable without publishing the text.
 */
export function decisionsAsGraph(records: readonly DecisionRecord[], allow?: readonly string[]): readonly GraphDecisionInput[] {
  return records
    .filter((record) => visible(record, allow))
    .map((record): GraphDecisionInput => ({
      id: record.id,
      title: record.title,
      status: record.status,
      date: record.date,
      links: record.links.map((link) => ({
        kind: link.kind,
        id: link.id,
        raw: link.raw,
        resolved: link.resolved !== false,
      })),
      supersedes: record.supersedes,
      alternatives: record.alternatives.length,
      pos: record.span,
      ...(record.audience.length === 0 ? {} : { audience: record.audience }),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
