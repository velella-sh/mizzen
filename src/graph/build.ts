/**
 * Builds one immutable knowledge-graph snapshot from the site model and the references a collector read from it.
 *
 * The builder is pure: it reads its {@link GraphInput} and no disk, clock, environment, or network. Every node and
 * edge carries the source position it came from and the unit that owns it, so a refresh can recompute one page or
 * collection and reuse the rest. Node identity is stable: a page is its source path (a URL change leaves it alone),
 * a block is its site-wide block id (a move to another page leaves it alone), and a record is its collection and id.
 * An edge whose source or target is not a node of the snapshot is rejected with `graph.edge-invalid`.
 */
import type {
  Collection,
  CollectionConfig,
  DataRecord,
  Graph,
  GraphArchive,
  GraphBuildResult,
  GraphClaimInput,
  GraphEdge,
  GraphEdgeKind,
  GraphIncludeInput,
  GraphInput,
  GraphLinkInput,
  GraphNode,
  GraphProblem,
  Page,
  RecordPos,
  SourcePos,
} from "../contracts/index.ts";
import type { TransformStepConfig } from "../contracts/config.ts";
import { sha256 } from "../data/lock.ts";
import { publicEvidenceOf } from "../data/evidence/public.ts";

/** The contract version this builder writes. */
export const GRAPH_FORMAT = 1 as const;

/** The snapshot id a build without a caller label gets: `graph:` and the first 32 hex characters of its contents. */
export function graphSnapshotId(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): string {
  return `graph:${sha256(canonical(nodes) + "\n" + canonical(edges)).slice(0, 32)}`;
}

/** Key-sorted JSON, so equal contents hash alike whatever order they were built in. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Compares strings by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Compares two optional positions, putting an absent one first. */
function comparePos(a: SourcePos | undefined, b: SourcePos | undefined): number {
  if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1;
  return (
    byCodePoint(a.file, b.file) ||
    a.line - b.line ||
    a.column - b.column ||
    a.endLine - b.endLine ||
    a.endColumn - b.endColumn
  );
}

/** Sorts nodes by id. */
function sortNodes(nodes: Iterable<GraphNode>): GraphNode[] {
  return [...nodes].sort((a, b) => byCodePoint(a.id, b.id));
}

/** Sorts edges by source, target, kind, then position, and collapses duplicates. */
function sortEdges(edges: Iterable<GraphEdge>): GraphEdge[] {
  const sorted = [...edges].sort(
    (a, b) =>
      byCodePoint(a.from, b.from) ||
      byCodePoint(a.to, b.to) ||
      byCodePoint(a.kind, b.kind) ||
      comparePos(a.pos, b.pos),
  );
  const out: GraphEdge[] = [];
  for (const edge of sorted) {
    const previous = out[out.length - 1];
    if (
      previous !== undefined &&
      previous.from === edge.from &&
      previous.to === edge.to &&
      previous.kind === edge.kind &&
      comparePos(previous.pos, edge.pos) === 0
    ) {
      continue;
    }
    out.push(edge);
  }
  return out;
}

/** The source position of a data record. */
export function recordPos(pos: RecordPos): SourcePos {
  return { file: pos.file, line: pos.startLine, column: pos.startColumn, endLine: pos.endLine, endColumn: pos.endColumn };
}

/**
 * The id of a page node: its source path, which a permalink change leaves alone. A generated page gets the identity
 * that is stable for it: a record page its collection and record, and an API operation page its operation id, so many
 * pages built from one template or one OpenAPI file stay distinct.
 */
export function pageNodeId(page: Page): string {
  if (page.record !== undefined) {
    return `page:record:${page.record.collection}/${page.record.id}${page.record.view === undefined ? "" : `#${page.record.view}`}`;
  }
  const api = apiOf(page);
  if (api !== undefined) return `page:api:${page.source.file}#${api.id}`;
  return `page:${page.source.file}`;
}

/** The id of a block node: the site-wide block id, which a move leaves alone. */
export function blockNodeId(block: string): string {
  return `block:${block}`;
}

/** The id of a heading node: its page and its anchor. */
export function headingNodeId(file: string, id: string): string {
  return `heading:${file}#${id}`;
}

/** The id of a collection node. */
export function collectionNodeId(name: string): string {
  return `collection:${name}`;
}

/** The id of a record node. */
export function recordNodeId(collection: string, id: string): string {
  return `record:${collection}/${id}`;
}

/** The id of one record field. */
export function fieldNodeId(collection: string, record: string, field: string): string {
  return `field:${collection}/${record}/${field}`;
}

/** The id of a collection-level field, named by a transform, join, or derived rule. */
export function configFieldNodeId(collection: string, field: string): string {
  return `field:${collection}/${field}`;
}

/** The id of a transform node. */
export function transformNodeId(collection: string, rule: string): string {
  return `transform:${collection}/${rule}`;
}

/** The id of a join node. */
export function joinNodeId(collection: string): string {
  return `join:${collection}`;
}

/** The id of a derived value node. */
export function derivedNodeId(collection: string, name: string): string {
  return `derived:${collection}/${name}`;
}

/** The id of a claim node. */
export function claimNodeId(collection: string, record: string, field: string): string {
  return `claim:${collection}/${record}/${field}`;
}

/** The id of a source-evidence node. */
export function evidenceNodeId(url: string): string {
  return `evidence:${url}`;
}

/** The id of a check node. */
export function checkNodeId(id: string): string {
  return `check:${id}`;
}

/** The id of a lineage node. */
export function lineageNodeId(collection: string, record: string, field: string): string {
  return `lineage:${collection}/${record}/${field}`;
}

/** The id of an include node. */
export function includeNodeId(path: string): string {
  return `include:${path}`;
}

/** The id of a symbol node. */
export function symbolNodeId(file: string, name: string): string {
  return `symbol:${file}#${name}`;
}

/** The audience a front matter value or record field names: one string, a list, or nothing. */
function audienceOf(value: unknown): readonly string[] | undefined {
  if (typeof value === "string") return value.trim() === "" ? undefined : [value.trim()];
  if (Array.isArray(value)) {
    const values = value.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim());
    return values.length === 0 ? undefined : values;
  }
  return undefined;
}

/** The `audience` property, omitted when the node is public. */
function audienceProp(audience: readonly string[] | undefined): { readonly audience?: readonly string[] } {
  return audience === undefined ? {} : { audience };
}

/** The audience at an exact node id or the node's unit, from the caller's extra map. */
function extraAudience(input: GraphInput, id: string, unit: string | undefined): readonly string[] | undefined {
  const map = input.audience;
  if (map === undefined) return undefined;
  return map[id] ?? (unit === undefined ? undefined : map[unit]);
}

/** Merges two audiences: the extra map wins, then the source's own list, then undefined. */
function audienceFor(input: GraphInput, id: string, unit: string | undefined, own: readonly string[] | undefined): readonly string[] | undefined {
  return extraAudience(input, id, unit) ?? own;
}

/** The top segment of a dot path. */
function topField(path: string): string {
  const first = path.split(".")[0]?.trim();
  return first === undefined || first === "" ? path : first;
}

/** Every field path a transform step reads, writes, or filters on. */
function stepPaths(step: TransformStepConfig): { readonly reads: readonly string[]; readonly writes: readonly string[] } {
  switch (step.op) {
    case "select":
      return { reads: [], writes: step.fields };
    case "remove":
      return { reads: step.fields, writes: [] };
    case "rename":
      return { reads: [step.from], writes: [step.to] };
    case "filter":
      return { reads: Object.keys(step.where), writes: [] };
    case "dedupe":
      return { reads: step.by, writes: [] };
    default:
      return { reads: [step.field], writes: [step.field] };
  }
}

/** One builder unit: the nodes and edges one page, collection, symbol set, or include set contributes. */
interface Unit {
  readonly nodes: GraphNode[];
  readonly edges: GraphEdge[];
  readonly diagnostics: GraphProblem[];
}

/** An empty unit, so a builder branch never returns undefined. */
function emptyUnit(): Unit {
  return { nodes: [], edges: [], diagnostics: [] };
}

/** Adds a node once per id, keeping the first writer's copy. */
function addNode(nodes: Map<string, GraphNode>, node: GraphNode): void {
  if (!nodes.has(node.id)) nodes.set(node.id, node);
}

/** Adds an edge and its source unit, so a refresh can reuse or replace it as one piece. */
function addEdge(edges: GraphEdge[], edge: GraphEdge): void {
  edges.push(edge);
}

/** The label of a page: its title, else its URL. */
function pageLabel(page: Page): string {
  return page.title.trim() === "" ? page.url : page.title;
}

/** Reads the `apiReference` front matter a reference page carries, for an API node. */
function apiOf(page: Page): { readonly id: string; readonly label: string } | undefined {
  const raw = page.frontMatter.apiReference;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (record.kind !== "operation") return undefined;
  const operation = record.operation;
  const id = typeof operation === "object" && operation !== null
    ? (operation as Record<string, unknown>).operationId
    : undefined;
  return {
    id: typeof id === "string" && id !== "" ? id : page.source.file,
    label: pageLabel(page),
  };
}

/** The block whose span holds a position, when one does. */
function blockAt(page: Page, pos: SourcePos): string | undefined {
  const blocks = page.blocks ?? [];
  for (const block of blocks) {
    if (comparePos(block.pos, pos) <= 0 && comparePos({ ...pos, line: pos.endLine, column: pos.endColumn }, { ...block.pos, line: block.pos.endLine, column: block.pos.endColumn }) >= 0) {
      return block.id;
    }
  }
  return undefined;
}

/** One page's nodes and edges, without the collections that record pages render. */
function pageUnit(input: GraphInput, page: Page, index: { links: number; codeRefs: number; includes: number; api: number }): Unit {
  const unit = `page:${page.source.file}`;
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const diagnostics: GraphProblem[] = [];
  const pageAudience = audienceOf(page.frontMatter.audience);
  const pageId = pageNodeId(page);
  nodes.push({
    id: pageId,
    kind: "page",
    label: pageLabel(page),
    pos: page.source,
    url: page.url,
    data: { source: page.source.file, lang: page.lang, dir: page.dir, kind: page.kind },
    ...audienceProp(audienceFor(input, pageId, unit, pageAudience)),
    unit,
  });

  for (const block of page.blocks ?? []) {
    const blockId = blockNodeId(block.id);
    nodes.push({
      id: blockId,
      kind: "block",
      label: block.id,
      pos: block.pos,
      ...(block.fingerprint === undefined ? {} : { data: { fingerprint: block.fingerprint } }),
      ...audienceProp(audienceFor(input, blockId, unit, pageAudience)),
      unit,
    });
    addEdge(edges, { from: pageId, to: blockId, kind: "contains", pos: block.pos, unit });
  }

  for (const heading of page.headings) {
    const headingId = headingNodeId(page.source.file, heading.id);
    nodes.push({
      id: headingId,
      kind: "heading",
      label: heading.text,
      pos: heading.pos,
      data: { depth: heading.depth, anchor: heading.id },
      ...audienceProp(audienceFor(input, headingId, unit, pageAudience)),
      unit,
    });
    addEdge(edges, { from: pageId, to: headingId, kind: "contains", pos: heading.pos, unit });
  }

  const api = apiOf(page);
  if (api !== undefined) {
    const apiId = `api:${page.source.file}#${api.id}`;
    nodes.push({
      id: apiId,
      kind: "api",
      label: api.label,
      pos: page.source,
      url: page.url,
      data: { operation: api.id },
      ...audienceProp(audienceFor(input, apiId, unit, pageAudience)),
      unit,
    });
    addEdge(edges, { from: pageId, to: apiId, kind: "documents", pos: page.source, unit });
  }

  if (page.record !== undefined) {
    const collection = input.site.collections[page.record.collection];
    const record = collection?.records.find((candidate) => candidate.id === page.record!.id);
    if (record !== undefined) {
      const recordId = recordNodeId(page.record.collection, page.record.id);
      addEdge(edges, { from: pageId, to: recordId, kind: "renders", pos: page.source, unit });
      for (const field of Object.keys(record.fields)) {
        if (field === input.site.config.collections[page.record.collection]?.evidence) continue;
        addEdge(edges, { from: pageId, to: claimNodeId(page.record.collection, page.record.id, field), kind: "asserts", pos: record.fieldPositions[field] === undefined ? recordPos(record.position) : recordPos(record.fieldPositions[field]!), unit });
      }
    }
  }

  const links = (input.links ?? []).filter((link) => link.page === page.source.file);
  for (const [position, link] of links.entries()) {
    const linkId = `link:${page.source.file}#${index.links + position + 1}`;
    const owner = link.block === undefined ? pageId : blockNodeId(link.block);
    nodes.push({
      id: linkId,
      kind: "link",
      label: link.text ?? link.href,
      pos: link.pos,
      url: link.href,
      data: { href: link.href, ...(link.internal === false ? { internal: false } : {}) },
      ...audienceProp(audienceFor(input, linkId, unit, pageAudience)),
      unit,
    });
    addEdge(edges, { from: owner, to: linkId, kind: "links", pos: link.pos, unit });
    const target = link.target;
    if (target !== undefined) {
      addEdge(edges, { from: linkId, to: `page:${target}`, kind: "targets", pos: link.pos, unit });
    } else if (link.internal === true) {
      diagnostics.push({
        code: "graph.link-unresolved",
        severity: "warning",
        message: `The link "${link.href}" on "${page.source.file}" names no page in this site.`,
        pos: link.pos,
      });
    }
  }

  const includes = (input.includes ?? []).filter((include) => include.from === page.source.file);
  for (const include of includes) {
    const includeId = includeNodeId(include.path);
    nodes.push({
      id: includeId,
      kind: "include",
      label: include.path,
      pos: include.pos,
      data: { path: include.path, ...(include.missing === true ? { missing: true } : {}) },
      unit,
    });
    addEdge(edges, { from: pageId, to: includeId, kind: "includes", pos: include.pos, unit });
  }

  const refs = (input.codeRefs ?? []).filter((ref) => ref.page === page.source.file);
  const symbols = input.symbols ?? [];
  for (const [position, ref] of refs.entries()) {
    const snippetId = `snippet:${page.source.file}#${index.codeRefs + position + 1}`;
    const owner = ref.block === undefined ? pageId : blockNodeId(ref.block);
    nodes.push({
      id: snippetId,
      kind: "snippet",
      label: `${ref.path}:${ref.line}`,
      pos: ref.pos,
      data: { path: ref.path, line: ref.line, ...(ref.endLine === undefined ? {} : { endLine: ref.endLine }) },
      ...audienceProp(audienceFor(input, snippetId, unit, pageAudience)),
      unit,
    });
    addEdge(edges, { from: owner, to: snippetId, kind: "references", pos: ref.pos, unit });
    if (ref.symbol !== undefined) {
      const symbolId = symbolNodeId(ref.path, ref.symbol);
      if (symbols.some((symbol) => symbol.file === ref.path && symbol.name === ref.symbol)) {
        addEdge(edges, { from: snippetId, to: symbolId, kind: "references", pos: ref.pos, unit });
      } else {
        diagnostics.push({
          code: "graph.symbol-missing",
          severity: "error",
          message: `"${ref.path}" does not export "${ref.symbol}", named at "${ref.pos.file}:${ref.pos.line}".`,
          pos: ref.pos,
        });
      }
    }
  }

  return { nodes, edges, diagnostics };
}

/** One collection's nodes and edges: records, fields, transforms, joins, derived rules, and claims. */
function collectionUnit(input: GraphInput, name: string, collection: Collection): Unit {
  const unit = `collection:${name}`;
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const diagnostics: GraphProblem[] = [];
  const config: CollectionConfig | undefined = input.site.config.collections[name];
  const collectionId = collectionNodeId(name);
  const sourcePos = collection.records[0] === undefined ? undefined : recordPos(collection.records[0].position);
  nodes.push({
    id: collectionId,
    kind: "collection",
    label: name,
    ...(sourcePos === undefined ? {} : { pos: sourcePos }),
    data: { source: collection.source },
    unit,
  });

  const evidenceField = config?.evidence;
  const claims: GraphClaimInput[] = [...(input.evidence ?? [])];
  const claimIds = new Map<string, string>();

  for (const record of collection.records) {
    const recordId = recordNodeId(name, record.id);
    const recordAudience = audienceOf(record.fields.audience);
    nodes.push({
      id: recordId,
      kind: "record",
      label: record.id,
      pos: recordPos(record.position),
      data: { collection: name, id: record.id },
      ...(recordAudience === undefined ? {} : { audience: recordAudience }),
      unit,
    });
    addEdge(edges, { from: collectionId, to: recordId, kind: "contains", pos: recordPos(record.position), unit });

    for (const field of Object.keys(record.fields)) {
      if (field === evidenceField) continue;
      const fieldId = fieldNodeId(name, record.id, field);
      const pos = record.fieldPositions[field] === undefined ? recordPos(record.position) : recordPos(record.fieldPositions[field]!);
      nodes.push({
        id: fieldId,
        kind: "field",
        label: field,
        pos,
        data: { collection: name, record: record.id, field },
        ...(recordAudience === undefined ? {} : { audience: recordAudience }),
        unit,
      });
      addEdge(edges, { from: recordId, to: fieldId, kind: "contains", pos, unit });
    }

    const publicClaims = publicEvidenceOf(record, evidenceField);
    for (const field of Object.keys(record.fields)) {
      if (field === evidenceField) continue;
      const claimId = claimNodeId(name, record.id, field);
      claimIds.set(`${record.id}\u0000${field}`, claimId);
      const claimPos = record.fieldPositions[field] === undefined ? recordPos(record.position) : recordPos(record.fieldPositions[field]!);
      nodes.push({
        id: claimId,
        kind: "claim",
        label: field,
        pos: claimPos,
        data: { collection: name, record: record.id, field },
        ...(recordAudience === undefined ? {} : { audience: recordAudience }),
        unit,
      });
      addEdge(edges, { from: recordId, to: claimId, kind: "asserts", pos: claimPos, unit });
      addEdge(edges, { from: claimId, to: fieldNodeId(name, record.id, field), kind: "references", pos: claimPos, unit });
      for (const claim of publicClaims?.[field] ?? []) {
        const evidenceId = evidenceNodeId(claim.url);
        nodes.push({
          id: evidenceId,
          kind: "evidence",
          label: claim.title,
          pos: claimPos,
          url: claim.url,
          data: { id: claim.id },
          ...(recordAudience === undefined ? {} : { audience: recordAudience }),
          unit,
        });
        addEdge(edges, { from: claimId, to: evidenceId, kind: "backs", pos: claimPos, unit });
      }
    }
  }

  // Config fields are added through a local map so one path gets one node.
  const configFieldNodes = new Map<string, GraphNode>();
  const fieldNode = (path: string): string => {
    const field = topField(path);
    const id = configFieldNodeId(name, field);
    if (!configFieldNodes.has(id)) {
      configFieldNodes.set(id, {
        id,
        kind: "field",
        label: field,
        ...(sourcePos === undefined ? {} : { pos: sourcePos }),
        data: { collection: name, field },
        unit,
      });
    }
    return id;
  };
  const steps = config?.transform?.steps ?? [];
  for (const [position, step] of steps.entries()) {
    const rule = step.id ?? `step-${position + 1}`;
    const id = transformNodeId(name, rule);
    nodes.push({ id, kind: "transform", label: rule, ...(sourcePos === undefined ? {} : { pos: sourcePos }), data: { collection: name, rule, op: step.op }, unit });
    addEdge(edges, { from: collectionId, to: id, kind: "contains", ...(sourcePos === undefined ? {} : { pos: sourcePos }), unit });
    const paths = stepPaths(step);
    for (const path of paths.reads) {
      addEdge(edges, { from: id, to: fieldNode(path), kind: "reads", ...(sourcePos === undefined ? {} : { pos: sourcePos }), unit });
    }
    for (const path of paths.writes) {
      addEdge(edges, { from: id, to: fieldNode(path), kind: "writes", ...(sourcePos === undefined ? {} : { pos: sourcePos }), unit });
    }
  }

  if (config?.join !== undefined) {
    const id = joinNodeId(name);
    const primaryKey = typeof config.join.key === "string" ? [config.join.key] : config.join.key;
    nodes.push({ id, kind: "join", label: `join ${name}`, ...(sourcePos === undefined ? {} : { pos: sourcePos }), data: { collection: name, type: config.join.type ?? "inner" }, unit });
    addEdge(edges, { from: collectionId, to: id, kind: "contains", ...(sourcePos === undefined ? {} : { pos: sourcePos }), unit });
    for (const key of primaryKey) {
      addEdge(edges, { from: id, to: fieldNode(key), kind: "reads", ...(sourcePos === undefined ? {} : { pos: sourcePos }), unit });
    }
    for (const source of config.join.sources) {
      addEdge(edges, { from: id, to: collectionNodeId(source.collection), kind: "joins", ...(sourcePos === undefined ? {} : { pos: sourcePos }), unit });
      for (const field of Object.keys(source.fields ?? {})) {
        addEdge(edges, { from: id, to: fieldNode(field), kind: "writes", ...(sourcePos === undefined ? {} : { pos: sourcePos }), unit });
      }
    }
  }

  for (const [derivedName, rule] of Object.entries(config?.derived ?? {})) {
    const id = derivedNodeId(name, derivedName);
    nodes.push({ id, kind: "derived", label: derivedName, ...(sourcePos === undefined ? {} : { pos: sourcePos }), data: { collection: name, rule: derivedName }, unit });
    addEdge(edges, { from: collectionId, to: id, kind: "contains", ...(sourcePos === undefined ? {} : { pos: sourcePos }), unit });
    addEdge(edges, { from: id, to: fieldNode(rule.field), kind: "reads", ...(sourcePos === undefined ? {} : { pos: sourcePos }), unit });
    addEdge(edges, { from: id, to: fieldNode(derivedName), kind: "writes", ...(sourcePos === undefined ? {} : { pos: sourcePos }), unit });
  }
  nodes.push(...configFieldNodes.values());

  for (const evidence of claims) {
    if (evidence.collection !== name) continue;
    const claimId = claimIds.get(`${evidence.record}\u0000${evidence.field}`);
    if (claimId === undefined) continue;
    if (evidence.kind === "evidence") {
      const evidenceId = evidenceNodeId(evidence.url ?? evidence.id);
      nodes.push({
        id: evidenceId,
        kind: "evidence",
        label: evidence.title,
        ...(evidence.pos === undefined ? {} : { pos: evidence.pos }),
        ...(evidence.url === undefined ? {} : { url: evidence.url }),
        data: { id: evidence.id },
        unit,
      });
      addEdge(edges, { from: claimId, to: evidenceId, kind: "backs", ...(evidence.pos === undefined ? {} : { pos: evidence.pos }), unit });
    } else if (evidence.kind === "check") {
      const id = checkNodeId(evidence.id);
      nodes.push({
        id,
        kind: "check",
        label: evidence.title,
        ...(evidence.pos === undefined ? {} : { pos: evidence.pos }),
        data: { id: evidence.id, status: evidence.status ?? "unknown" },
        unit,
      });
      addEdge(edges, { from: claimId, to: id, kind: "checks", ...(evidence.pos === undefined ? {} : { pos: evidence.pos }), unit });
    } else {
      const id = lineageNodeId(name, evidence.record, evidence.field);
      nodes.push({
        id,
        kind: "lineage",
        label: evidence.title,
        ...(evidence.pos === undefined ? {} : { pos: evidence.pos }),
        data: { collection: name, record: evidence.record, field: evidence.field, id: evidence.id },
        unit,
      });
      addEdge(edges, { from: claimId, to: id, kind: "derives", ...(evidence.pos === undefined ? {} : { pos: evidence.pos }), unit });
    }
  }

  return { nodes, edges, diagnostics };
}

/** Symbol nodes for every collected symbol, in file and line order. */
function symbolUnit(input: GraphInput): Unit {
  const nodes: GraphNode[] = [];
  for (const symbol of input.symbols ?? []) {
    const id = symbolNodeId(symbol.file, symbol.name);
    nodes.push({
      id,
      kind: "symbol",
      label: symbol.name,
      pos: { file: symbol.file, line: symbol.line, column: 1, endLine: symbol.line, endColumn: 1 },
      data: { file: symbol.file, name: symbol.name, kind: symbol.kind, line: symbol.line },
      unit: "symbols",
    });
  }
  return { nodes, edges: [], diagnostics: [] };
}

/** Include nodes for every include target, in path order. */
function includeUnit(input: GraphInput): Unit {
  const nodes: GraphNode[] = [];
  const seen = new Set<string>();
  for (const include of input.includes ?? []) {
    if (seen.has(include.path)) continue;
    seen.add(include.path);
    nodes.push({
      id: includeNodeId(include.path),
      kind: "include",
      label: include.path,
      pos: include.pos,
      data: { path: include.path },
      unit: "includes",
    });
  }
  return { nodes, edges: [], diagnostics: [] };
}

/** Merges unit nodes and edges, then rejects every edge with a missing end. */
function assemble(input: GraphInput, units: readonly Unit[], snapshotLabel: string | undefined): GraphBuildResult {
  const nodeMap = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const diagnostics: GraphProblem[] = [];
  for (const unit of units) {
    for (const node of unit.nodes) addNode(nodeMap, node);
    for (const edge of unit.edges) addEdge(edges, edge);
    diagnostics.push(...unit.diagnostics);
  }
  const nodes = sortNodes(nodeMap.values());
  const known = new Set(nodes.map((node) => node.id));
  const validEdges: GraphEdge[] = [];
  for (const edge of edges) {
    if (!known.has(edge.from) || !known.has(edge.to)) {
      diagnostics.push({
        code: "graph.edge-invalid",
        severity: "error",
        message: `The edge "${edge.from}" -[${edge.kind}]-> "${edge.to}" names a node that this snapshot does not hold.`,
        ...(edge.pos === undefined ? {} : { pos: edge.pos }),
        edge,
      });
      continue;
    }
    validEdges.push(edge);
  }
  const sortedEdges = sortEdges(validEdges);
  const id = snapshotLabel ?? graphSnapshotId(nodes, sortedEdges);
  const graph: Graph = {
    format: GRAPH_FORMAT,
    snapshot: { format: GRAPH_FORMAT, id, ...(snapshotLabel === undefined ? {} : { label: snapshotLabel }) },
    nodes,
    edges: sortedEdges,
  };
  return { graph, diagnostics: sortProblems(diagnostics) };
}

/** Sorts problems by code, file, and line. */
function sortProblems(problems: readonly GraphProblem[]): GraphProblem[] {
  return [...problems].sort(
    (a, b) => byCodePoint(a.code, b.code) || comparePos(a.pos, b.pos) || byCodePoint(a.message, b.message),
  );
}

/** Every page unit, in page order. */
function pageUnits(input: GraphInput): Map<string, Unit> {
  const units = new Map<string, Unit>();
  const pages = [...input.site.pages].sort((a, b) => byCodePoint(a.source.file, b.source.file));
  for (const page of pages) {
    units.set(`page:${page.source.file}`, pageUnit(input, page, { links: 0, codeRefs: 0, includes: 0, api: 0 }));
  }
  return units;
}

/** Every collection unit, in collection-name order. */
function collectionUnits(input: GraphInput): Map<string, Unit> {
  const units = new Map<string, Unit>();
  for (const name of Object.keys(input.site.collections).sort(byCodePoint)) {
    const collection = input.site.collections[name]!;
    units.set(`collection:${name}`, collectionUnit(input, name, collection));
  }
  return units;
}

/** Builds every unit of a full snapshot. */
function allUnits(input: GraphInput): Unit[] {
  return [
    ...pageUnits(input).values(),
    ...collectionUnits(input).values(),
    symbolUnit(input),
    includeUnit(input),
  ];
}

/** Builds a complete graph snapshot from the model and the collected references. */
export function buildGraph(input: GraphInput): GraphBuildResult {
  return assemble(input, allUnits(input), input.snapshot);
}

/** What changed since {@link refreshGraph}'s previous snapshot. */
export interface GraphChanges {
  /** Source paths of the pages that changed (their blocks, headings, links, and references are rebuilt). */
  readonly pages?: readonly string[];
  /** Names of the collections whose records changed. */
  readonly collections?: readonly string[];
}

/** Rebuilds only the changed units and reuses every other node and edge from `previous`. */
export function refreshGraph(previous: Graph, input: GraphInput, changes: GraphChanges): GraphBuildResult {
  const pageNames = new Set(changes.pages ?? []);
  const collectionNames = new Set(changes.collections ?? []);
  const pages = pageUnits(input);
  const collections = collectionUnits(input);
  const reuse = (units: Map<string, Unit>, changed: ReadonlySet<string>): Unit[] => {
    const out: Unit[] = [];
    for (const [unit, fresh] of units) {
      if (!changed.has(unit.slice(unit.indexOf(":") + 1))) {
        const oldNodes = previous.nodes.filter((node) => node.unit === unit);
        const oldEdges = previous.edges.filter((edge) => edge.unit === unit);
        if (oldNodes.length > 0 || oldEdges.length > 0) {
          out.push({ nodes: [...oldNodes], edges: [...oldEdges], diagnostics: [] });
          continue;
        }
      }
      out.push(fresh);
    }
    // A unit removed from the input disappears; old units not named by the new input are dropped.
    return out;
  };
  const units = [
    ...reuse(pages, pageNames),
    ...reuse(collections, collectionNames),
    symbolUnit(input),
    includeUnit(input),
  ];
  return assemble(input, units, input.snapshot);
}

/** Puts independent snapshots beside each other, sorted by snapshot id. */
export function archiveGraphs(graphs: readonly Graph[]): GraphArchive {
  const snapshots = [...graphs].sort((a, b) => byCodePoint(a.snapshot.id, b.snapshot.id));
  return { format: GRAPH_FORMAT, snapshots };
}
