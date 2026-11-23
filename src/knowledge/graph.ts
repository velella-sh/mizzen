/**
 * Projects each site subject's declaration into the graph: one {@link GraphKnowledgeInput} per page or record node,
 * carrying only what public output may hold. A citation is included only when it is public; a private rationale is
 * never carried, so a graph query cannot leak it.
 */
import type { Page, Site } from "../contracts/content.ts";
import type { GraphKnowledgeInput } from "../contracts/graph.ts";
import type { KnowledgeDeclaration } from "../contracts/knowledge.ts";
import { claimNodeId, pageNodeId, recordNodeId } from "../graph/build.ts";

/** The node id a subject's knowledge attaches to, or `undefined` when the subject has no node. */
function nodeOfPage(page: Page): string | undefined {
  if (page.kind !== "doc") return undefined;
  return pageNodeId(page);
}

/** The public graph knowledge of one declaration. */
function knowledgeInput(
  node: string,
  declaration: KnowledgeDeclaration,
): GraphKnowledgeInput {
  const citations = declaration.citation !== undefined && declaration.citation.public === true
    ? [declaration.citation.value]
    : undefined;
  return {
    node,
    status: declaration.status,
    scope: declaration.scope.map((limit) => ({ kind: limit.kind, value: limit.value })),
    ...(citations === undefined ? {} : { citations }),
    pos: declaration.span,
  };
}

/** Every knowledge declaration a graph should carry, by node id, including record nodes and their claims. */
export function collectGraphKnowledge(site: Site): readonly GraphKnowledgeInput[] {
  const out: GraphKnowledgeInput[] = [];
  for (const page of site.pages) {
    if (page.knowledge === undefined) continue;
    const node = nodeOfPage(page);
    if (node === undefined) continue;
    out.push(knowledgeInput(node, page.knowledge));
  }
  for (const name of Object.keys(site.collections).sort()) {
    const collection = site.collections[name]!;
    for (const record of collection.records) {
      if (record.knowledge === undefined) continue;
      out.push(knowledgeInput(recordNodeId(name, record.id), record.knowledge));
      // A field claim is what a query reaches from a record; the record's status limits every claim under it too.
      for (const field of Object.keys(record.fields)) {
        out.push(knowledgeInput(claimNodeId(name, record.id, field), record.knowledge));
      }
    }
  }
  return out.sort((a, b) => (a.node < b.node ? -1 : a.node > b.node ? 1 : 0));
}
