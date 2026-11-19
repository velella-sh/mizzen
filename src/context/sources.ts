/**
 * Sourced fragments: the exact text, span, block or record id, and build snapshot of every selected
 * node, plus the field lineage and stored-reference answers a task can ask for.
 *
 * A page is split at its top-level sections by the same trimmer the pack pipeline uses, so a
 * fragment's text is the build's own Markdown and its span is the heading's source position. A
 * record is projected through the collection's 0.2.5 `public` policy before it becomes text: a
 * blocked field reaches no fragment, omission, metadata, or lineage. Lineage is requested in its
 * public form, so the effective rule and source are published while values and secrets stay in.
 */
import type { BlockReference, Collection, Page, Site, SourcePos, TaskContract } from "../contracts/index.ts";
import { blockIdOf, formatSpan } from "../source/spans.ts";
import { blockReference } from "../blocks/reference.ts";
import { explain } from "../data/lineage.ts";
import { isPublicReference, publicFields } from "../data/public.ts";
import type { BlocksLock } from "../blocks/lock.ts";
import { trimPages, type TrimSection } from "../packs/trim.ts";
import { estimateTokens } from "../packs/tokens.ts";
import { pageNodeId } from "../graph/build.ts";
import type { ContextSelection } from "./select.ts";
import { resolveRef } from "./select.ts";
import type { ContextEntry, ContextFragment, ContextReference, ContextSourceMeta } from "./types.ts";

/** A budget high enough that the trimmer keeps every section, so splitting is not a selection. */
const SPLIT_LIMIT = 10_000_000;

/** One fragment before its content is estimated. */
interface Draft {
  readonly id: string;
  readonly kind: ContextFragment["kind"];
  readonly title: string;
  readonly content: string;
  readonly source: ContextSourceMeta;
  readonly reason: string;
  readonly via: readonly string[];
  readonly refs: readonly string[];
}

/** The source path with forward slashes. */
function sourceOf(page: Page): string {
  return page.source.file.replace(/\\/g, "/");
}

/** A span with forward slashes and the page's own path. */
function spanOf(pos: SourcePos, file: string): string {
  return formatSpan({ ...pos, file });
}

/** A block id at a heading position, when the page's block list has one there. */
function blockAt(page: Page, section: TrimSection): string | undefined {
  const block = page.blocks?.find((candidate) => candidate.pos.line === section.pos.line && candidate.pos.column === section.pos.column);
  return block?.id;
}

/** The span from the page's start to the line before its first section. */
function leadPos(page: Page, first: TrimSection | undefined): SourcePos {
  if (first === undefined) return page.source;
  return {
    file: page.source.file,
    line: page.source.line,
    column: page.source.column,
    endLine: Math.max(page.source.line, first.pos.line - 1),
    endColumn: 1,
  };
}

/** The stable refs a fragment answers: its page, its block, and any task references the caller adds. */
function pageRefs(page: Page, extra: readonly string[]): readonly string[] {
  const source = sourceOf(page);
  return [...new Set([page.url, source, ...extra])].sort();
}

/** One fragment for each page section, plus the lead when it has text. */
function pageDrafts(
  page: Page,
  trimmed: { readonly markdown: string; readonly keptSections: readonly TrimSection[] },
  build: string,
  refs: readonly string[],
  reason: string,
  via: readonly string[],
): Draft[] {
  const source = sourceOf(page);
  const drafts: Draft[] = [];
  const sections = trimmed.keptSections;

  if (sections.length === 0) {
    return [{
      id: `page:${source}`,
      kind: "page",
      title: page.title,
      content: trimmed.markdown,
      source: { file: source, span: formatSpan({ ...page.source, file: source }), snapshot: build },
      reason,
      via,
      refs,
    }];
  }

  const firstIndex = trimmed.markdown.indexOf(sections[0]!.markdown);
  const lead = firstIndex > 0 ? trimmed.markdown.slice(0, firstIndex).replace(/\n+$/, "") : "";
  if (lead.trim() !== "") {
    const block = page.blocks?.find((candidate) => candidate.pos.line === page.source.line && candidate.pos.column === page.source.column);
    const pos = leadPos(page, sections[0]);
    drafts.push({
      id: `page:${source}`,
      kind: "page",
      title: page.title,
      content: lead,
      source: {
        file: source,
        span: spanOf(pos, source),
        ...(block === undefined ? {} : { block: block.id }),
        snapshot: build,
      },
      reason,
      via,
      refs,
    });
  }

  for (const section of sections) {
    const block = blockAt(page, section);
    drafts.push({
      id: block === undefined ? `block:${blockIdOf({ ...section.pos, file: source })}` : `block:${block}`,
      kind: "block",
      title: section.text,
      content: section.markdown,
      source: {
        file: source,
        span: spanOf(section.pos, source),
        block: block ?? blockIdOf({ ...section.pos, file: source }),
        snapshot: build,
      },
      reason,
      via,
      refs,
    });
  }
  return drafts;
}

/** A field value as one deterministic line, for public record fragments. */
function valueText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : JSON.stringify(value) ?? "null";
}

/** The public fields of one record, sorted by name, as Markdown lines. */
function recordContent(collection: Collection, record: Collection["records"][number], policy: readonly string[] | undefined): string {
  const fields = publicFields(record.fields, policy);
  const names = Object.keys(fields).sort();
  const lines = [`- Collection: ${collection.name}`, `- Record: ${record.id}`];
  for (const name of names) {
    lines.push(`- ${name}: ${valueText(fields[name])}`);
  }
  return lines.join("\n");
}

/** The collection a graph record id names, and the record, when both exist. */
function recordOf(site: Site, entry: ContextEntry): { readonly collection: Collection; readonly record: Collection["records"][number] } | undefined {
  const value = entry.id.startsWith("record:") ? entry.id.slice("record:".length) : entry.label;
  const slash = value.indexOf("/");
  const collectionName = slash === -1 ? entry.label.split("/")[0] : value.slice(0, slash);
  const recordId = slash === -1 ? entry.label : value.slice(slash + 1);
  const collection = site.collections[collectionName ?? ""];
  const record = collection?.records.find((candidate) => candidate.id === recordId);
  return collection === undefined || record === undefined ? undefined : { collection, record };
}

/** The lineage fragment for one generated field, or `undefined` when the field is private or plain. */
async function lineageDraft(
  site: Site,
  collection: Collection,
  record: Collection["records"][number],
  field: string,
  build: string,
): Promise<Draft | undefined> {
  const policy = site.config.collections[collection.name]?.public;
  if (!isPublicReference(policy, field)) return undefined;
  const result = await explain(collection, record.id, field, {
    config: site.config,
    collections: site.collections,
    public: true,
  });
  if (!result.ok || !result.report.generated) return undefined;

  const rule = result.report.chain.find((event) => event.rule !== undefined)?.rule;
  const sources = [
    ...new Set(
      result.report.chain
        .filter((event) => event.source !== undefined)
        .map((event) => `${event.source}:${event.field}`),
    ),
  ];
  const lines = [`- Collection: ${collection.name}`, `- Record: ${record.id}`, `- Field: ${field}`];
  if (rule !== undefined) lines.push(`- Rule: ${rule}`);
  for (const source of sources.slice(0, 8)) lines.push(`- Source: ${source}`);
  const pos = record.fieldPositions[field] ?? record.position;
  return {
    id: `lineage:${collection.name}/${record.id}/${field}`,
    kind: "lineage",
    title: `${field} lineage`,
    content: lines.join("\n"),
    source: {
      file: pos.file,
      span: formatSpan({ file: pos.file, line: pos.startLine, column: pos.startColumn, endLine: pos.endLine, endColumn: pos.endColumn }),
      record: record.id,
      snapshot: build,
    },
    reason: "lineage.rule",
    via: [],
    refs: [field],
  };
}

/** The entries and dependencies that lead to one entry, for the fragment's `via`. */
function viaOf(selection: ContextSelection, entry: ContextEntry): readonly string[] {
  const reasons = selection.dependencies.filter((edge) => edge.to === entry.id).map((edge) => edge.reason);
  return [...new Set([entry.reason, ...reasons])];
}

/** The task references that resolve to this entry, so an answer can prove a criterion by id. */
function refsForEntry(site: Site, task: TaskContract, selection: ContextSelection, entry: ContextEntry): readonly string[] {
  const kinds: readonly (readonly [string, readonly string[]])[] = [
    ["pages", task.scope.pages],
    ["blocks", task.scope.blocks],
    ["collections", task.scope.collections],
    ["symbols", task.scope.symbols],
    ["files", task.scope.files],
  ];
  const refs: string[] = [];
  for (const [kind, values] of kinds) {
    for (const value of values) {
      if (resolveRef(selection.graph, site, value, kind)?.id === entry.id) refs.push(value);
    }
  }
  return [...new Set(refs)].sort();
}

/** The page a page-kind entry names, when the selection holds it. */
function pageOfEntry(site: Site, entry: ContextEntry): Page | undefined {
  return site.pages.find((page) => pageNodeId(page) === entry.id);
}

/**
 * Turns a selection into sourced fragments, in selection order.
 *
 * A page entry becomes its lead and one fragment per section, each carrying the section's block id.
 * A record entry becomes its public fields; a generated public field adds a lineage fragment. A
 * symbol, API, include, check, collection, or evidence entry becomes a small metadata fragment,
 * because its body is not part of the site model — the source position says where to read it.
 */
export async function fragmentsOf(
  site: Site,
  selection: ContextSelection,
  task: TaskContract,
  build: string,
): Promise<readonly ContextFragment[]> {
  const pages = selection.entries.map((entry) => pageOfEntry(site, entry)).filter((page): page is Page => page !== undefined);
  const trimmed = new Map<string, { readonly markdown: string; readonly keptSections: readonly TrimSection[] }>();
  if (pages.length > 0) {
    const probe = await trimPages(pages, SPLIT_LIMIT);
    for (const page of probe.pages) trimmed.set(page.url, { markdown: page.markdown, keptSections: page.keptSections });
  }

  const byId = new Map<string, Draft>();
  const merge = (draft: Draft): void => {
    const existing = byId.get(draft.id);
    if (existing === undefined) {
      byId.set(draft.id, draft);
      return;
    }
    byId.set(draft.id, {
      ...existing,
      refs: [...new Set([...existing.refs, ...draft.refs])].sort(),
      via: [...new Set([...existing.via, ...draft.via])].sort(),
    });
  };

  for (const entry of selection.entries) {
    const via = viaOf(selection, entry);
    const entryRefs = refsForEntry(site, task, selection, entry);
    const page = pageOfEntry(site, entry);
    if (page !== undefined) {
      const split = trimmed.get(page.url);
      if (split !== undefined) {
        const refs = pageRefs(page, entryRefs);
        for (const draft of pageDrafts(page, split, build, refs, entry.reason, via)) merge(draft);
      }
      continue;
    }

    if (entry.kind === "block") {
      const id = entry.id.startsWith("block:") ? entry.id.slice("block:".length) : entry.label;
      const holder = site.pages.find((candidate) => candidate.blocks?.some((block) => block.id === id));
      if (holder !== undefined) {
        const split = trimmed.get(holder.url);
        if (split !== undefined) {
          for (const draft of pageDrafts(holder, split, build, pageRefs(holder, [id, ...entryRefs]), entry.reason, via)) {
            if (draft.source.block === id) merge({ ...draft, refs: [...new Set([...draft.refs, id])].sort() });
          }
        }
      }
      continue;
    }

    if (entry.kind === "record") {
      const found = recordOf(site, entry);
      if (found === undefined) continue;
      const policy = site.config.collections[found.collection.name]?.public;
      const record = found.record;
      const pos = record.position;
      merge({
        id: `record:${found.collection.name}/${record.id}`,
        kind: "record",
        title: `${found.collection.name}/${record.id}`,
        content: recordContent(found.collection, record, policy),
        source: {
          file: pos.file,
          span: formatSpan({ file: pos.file, line: pos.startLine, column: pos.startColumn, endLine: pos.endLine, endColumn: pos.endColumn }),
          record: record.id,
          snapshot: build,
        },
        reason: entry.reason,
        via,
        refs: [`${found.collection.name}/${record.id}`, record.id, entry.id],
      });
      for (const field of Object.keys(record.derived ?? {}).sort()) {
        const draft = await lineageDraft(site, found.collection, record, field, build);
        if (draft !== undefined) merge(draft);
      }
      continue;
    }

    if (entry.kind === "collection") {
      const name = entry.id.startsWith("collection:") ? entry.id.slice("collection:".length) : entry.label;
      const collection = site.collections[name];
      if (collection === undefined) continue;
      const first = collection.records[0];
      const pos = first?.position;
      merge({
        id: `collection:${name}`,
        kind: "collection",
        title: name,
        content: [`- Collection: ${name}`, `- Records: ${collection.records.length}`, `- Source: ${collection.source}`].join("\n"),
        source: {
          file: pos?.file ?? collection.source,
          span: pos === undefined
            ? `${collection.source}:1:1-1:1`
            : formatSpan({ file: pos.file, line: pos.startLine, column: pos.startColumn, endLine: pos.endLine, endColumn: pos.endColumn }),
          snapshot: build,
        },
        reason: entry.reason,
        via,
        refs: [name],
      });
      continue;
    }

    // Symbol, API, include, check, evidence, field: the site model carries the position but not the
    // body, so the fragment names where the build read it instead of inventing text.
    const pos = entry.pos;
    merge({
      id: entry.id,
      kind: entry.kind,
      title: entry.label,
      content: [`- ${entry.kind}: ${entry.label}`, ...(pos === undefined ? [] : [`- Source: \`${spanOf(pos, pos.file)}\``])].join("\n"),
      source: {
        file: pos?.file ?? "",
        span: pos === undefined ? "::1:1-1:1" : spanOf(pos, pos.file),
        snapshot: build,
      },
      reason: entry.reason,
      via,
      refs: [entry.label, entry.id],
    });
  }

  return [...byId.values()].map((draft) => ({
    ...draft,
    tokens: estimateTokens(draft.content).tokens,
  }));
}

/**
 * Resolves the task's block references against this build. A block the model holds resolves at its
 * current page, a block the lock recorded but the build dropped is `removed`, and one neither knows
 * is `unknown`; the removed ids are also returned separately so a caller cannot miss them.
 */
export function taskReferences(
  site: Site,
  task: TaskContract,
  lock: BlocksLock,
): { readonly references: readonly ContextReference[]; readonly removed: readonly string[] } {
  const references: ContextReference[] = [];
  for (const block of task.scope.blocks) {
    const holder = site.pages.find((page) => page.blocks?.some((candidate) => candidate.id === block));
    const recordedPage = Object.entries(lock.pages).find(([, ids]) => ids[block] !== undefined)?.[0];
    const page = holder?.source.file ?? recordedPage ?? "";
    if (holder !== undefined) {
      references.push({
        block,
        page,
        status: "resolved",
        url: holder.url,
        source: holder.source.file,
      });
    } else if (recordedPage !== undefined) {
      references.push({ block, page: recordedPage, status: "removed" });
    } else {
      references.push({ block, page: "", status: "unknown" });
    }
  }
  return {
    references,
    removed: references.filter((reference) => reference.status === "removed").map((reference) => reference.block),
  };
}

/** A stored reference for every resolved block fragment, so a caller can reread it by id. */
export function fragmentReference(fragment: ContextFragment, build: string): BlockReference | undefined {
  if (fragment.kind !== "block" || fragment.source.block === undefined) return undefined;
  return blockReference(fragment.source.file, fragment.source.block, build);
}
