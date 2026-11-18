/**
 * Reports the changed blocks of a changed page.
 *
 * A build that carries block ids (`sourcemap.json`, or `blocks.json` beside it) is compared by those ids, never by
 * heading text or position: a block that kept its id is the same block after a heading edit or a reorder. The block's
 * text comes from the page's Markdown twin, parsed with the same block parser the build used, so whitespace changes
 * and shifted line numbers compare equal. A build without block ids falls back to the heading diff of
 * `src/versions/diff.ts`.
 *
 * Each change names its own kind: heading, code, code-language, table (with the changed cell), link or image (with the
 * destination), record (with the field and the value a record produced), moved, moved with content, or uncertain when
 * two blocks could match. Both source spans are carried when the side exists.
 */
import { blocksOf as declaredBlocks } from "../blocks/parse.ts";
import { parseMarkdown } from "../markdown/parse.ts";
import { diffMarkdown } from "../versions/diff.ts";
import type { Build, BuildPage } from "./builds.ts";
import { byCodePoint } from "./builds.ts";
import { jsonOf, twinOf, type PageDelta } from "./pages.ts";
import type { Reader } from "./reader.ts";
import type { Block, BlockKind, ChangedPage, SourceSpan } from "./types.ts";

const SOURCEMAP = "sourcemap.json";
const BLOCK_INDEX = "blocks.json";

/** The source map's block entry: the id and the span it occupies. */
interface BlockEntry {
  readonly id: string;
  readonly file: string;
  readonly line: number;
  readonly endLine: number;
}

/** What one build's source map says about a page. */
interface PageMapping {
  readonly source: string | undefined;
  readonly blocks: readonly BlockEntry[];
  readonly headings: readonly { readonly line: number; readonly text: string }[];
}

interface BuildMapping {
  readonly pages: ReadonlyMap<string, PageMapping>;
}

/** Parsed source maps, one per build; a build object lives for one comparison. */
const mappings = new WeakMap<Build, Promise<BuildMapping | undefined>>();

/** One block read from a Markdown twin. */
interface TwinBlock {
  readonly id: string;
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly heading: string | null;
}

/** One block of one side, with the source span the build recorded for it. */
interface SideBlock extends TwinBlock {
  readonly span: SourceSpan;
}

/** A change before it is attached to its block and spans. */
type Detail = Pick<Block, "kind" | "cell" | "destination" | "text" | "language" | "field" | "value">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function blockEntry(value: unknown): BlockEntry | undefined {
  if (!isRecord(value)) return undefined;
  const { id, file, line, endLine } = value;
  if (typeof id !== "string" || typeof file !== "string" || typeof line !== "number") return undefined;
  return { id, file, line, endLine: typeof endLine === "number" ? endLine : line };
}

/** The block ids a build wrote: `sourcemap.json` first, then the smaller `blocks.json`. */
async function readMapping(build: Build, reader: Reader): Promise<BuildMapping | undefined> {
  const pages = new Map<string, PageMapping>();
  let found = false;
  const map = await reader.json(build, SOURCEMAP);
  if (Array.isArray(map?.pages)) {
    for (const raw of map.pages) {
      if (!isRecord(raw) || typeof raw.url !== "string") continue;
      const blocks = Array.isArray(raw.blocks) ? raw.blocks.map(blockEntry).filter((entry): entry is BlockEntry => entry !== undefined) : [];
      const headings = Array.isArray(raw.sections)
        ? raw.sections.flatMap((section) => (isRecord(section) && typeof section.line === "number" && typeof section.text === "string" ? [{ line: section.line, text: section.text }] : []))
        : [];
      if (blocks.length > 0) found = true;
      pages.set(raw.url, { source: typeof raw.source === "string" ? raw.source : undefined, blocks, headings });
    }
  }
  if (found) return { pages };

  // Older builds may write only the flat index: id -> { url, file, line }.
  const index = await reader.json(build, BLOCK_INDEX);
  if (!isRecord(index?.blocks)) return undefined;
  for (const [id, value] of Object.entries(index.blocks)) {
    if (!isRecord(value) || typeof value.url !== "string" || typeof value.file !== "string" || typeof value.line !== "number") continue;
    const page = pages.get(value.url) ?? { source: undefined, blocks: [], headings: [] };
    pages.set(value.url, { ...page, blocks: [...page.blocks, { id, file: value.file, line: value.line, endLine: value.line }] });
    found = true;
  }
  return found ? { pages } : undefined;
}

function mappingOf(build: Build, reader: Reader): Promise<BuildMapping | undefined> {
  let found = mappings.get(build);
  if (found === undefined) {
    found = readMapping(build, reader);
    mappings.set(build, found);
  }
  return found;
}

/** Runs of whitespace collapse: a reflowed paragraph is not an edit. */
function normalized(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/** The visible text of a heading block, without its `{#id}`; `undefined` when the block is not a heading. */
function headingText(text: string): string | undefined {
  const lines = text.split(/\r\n|\r|\n/u);
  const atx = /^ {0,3}#{1,6}[ \t]+(.*?)[ \t]*#*[ \t]*$/u.exec(lines[0] ?? "");
  if (atx !== null) return (atx[1] ?? "").replace(/\s*\{#[^}]*\}\s*$/u, "").trim();
  if (/^ {0,3}(?:=+|-+)[ \t]*$/u.test(lines[1] ?? "") && (lines[0] ?? "").trim() !== "") return (lines[0] ?? "").trim();
  return undefined;
}

/** The fence language of a block that opens with a fence; `undefined` when it is not fenced code. */
function fenceLanguage(text: string): string | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)/u.exec(text.split(/\r\n|\r|\n/u)[0] ?? "");
  return match === null ? undefined : (match[2] ?? "");
}

/** A table's rows after the separator, cells trimmed; `undefined` when the block is not a table. */
function tableRows(text: string): string[][] | undefined {
  const lines = text.split(/\r\n|\r|\n/u).filter((line) => line.trim() !== "");
  if (lines.length < 2 || !lines.every((line) => line.includes("|"))) return undefined;
  if (!/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/u.test(lines[1] ?? "")) return undefined;
  const cells = (line: string): string[] => line.trim().replace(/^\|/u, "").replace(/\|$/u, "").split("|").map((cell) => cell.trim());
  return [cells(lines[0] ?? ""), ...lines.slice(2).map(cells)];
}

/** One link or image written in a block. */
interface Target {
  readonly image: boolean;
  readonly label: string;
  readonly href: string;
}

const TARGET = /(!?)\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/gu;

function targets(text: string): Target[] {
  return [...text.matchAll(TARGET)].map((match) => ({ image: match[1] === "!", label: match[2] ?? "", href: match[3] ?? "" }));
}

/** The block's text with every destination dropped, so a destination edit alone is not a text edit. */
function withoutDestinations(text: string): string {
  return text.replace(TARGET, (_whole, bang: string, label: string) => `${bang}[${label}]()`);
}

/** The link and image destinations that changed while their label stayed. */
function destinationChanges(before: string, after: string): Detail[] {
  const was = new Map(targets(before).map((target) => [`${target.image ? "!" : ""}${target.label}`, target]));
  const details: Detail[] = [];
  const seen = new Set<string>();
  for (const target of targets(after)) {
    const key = `${target.image ? "!" : ""}${target.label}`;
    const old = was.get(key);
    if (old === undefined || old.href === target.href || seen.has(key)) continue;
    seen.add(key);
    details.push({ kind: target.image ? "image" : "link", destination: { before: old.href, after: target.href } });
  }
  return details;
}

/** The first cell that differs between two tables, 1-based. */
function tableChange(before: string[][], after: string[][]): Detail {
  for (let row = 0; row < Math.max(before.length, after.length); row += 1) {
    const was = before[row] ?? [];
    const now = after[row] ?? [];
    for (let column = 0; column < Math.max(was.length, now.length); column += 1) {
      if ((was[column] ?? "") === (now[column] ?? "")) continue;
      return { kind: "table", cell: { row: row + 1, column: column + 1 }, text: { before: was[column] ?? "", after: now[column] ?? "" } };
    }
  }
  return { kind: "table" };
}

/** Values a page's record produced, for the fields whose scalar value changed. */
async function recordValues(reader: Reader, build: Build, page: BuildPage, other: Reader, otherBuild: Build, otherPage: BuildPage): Promise<Map<string, { before: string; after: string }>> {
  const [before, after] = await Promise.all([reader.json(build, jsonOf(page, build)), other.json(otherBuild, jsonOf(otherPage, otherBuild))]);
  const fieldsOf = (json: Record<string, unknown> | undefined): Record<string, unknown> => {
    const record = json?.record;
    if (!isRecord(record) || !isRecord(record.fields)) return {};
    return record.fields;
  };
  const was = fieldsOf(before);
  const now = fieldsOf(after);
  const changes = new Map<string, { before: string; after: string }>();
  for (const field of [...new Set([...Object.keys(was), ...Object.keys(now)])].sort(byCodePoint)) {
    const old = was[field];
    const next = now[field];
    if (typeof old !== "string" && typeof old !== "number" && typeof old !== "boolean") continue;
    if (typeof next !== "string" && typeof next !== "number" && typeof next !== "boolean") continue;
    const oldText = String(old);
    const newText = String(next);
    if (oldText === newText) continue;
    changes.set(field, { before: oldText, after: newText });
  }
  return changes;
}

/** A change explained by one record field's old value becoming its new value. */
function recordChange(before: string, after: string, fields: ReadonlyMap<string, { before: string; after: string }>): Detail | undefined {
  const was = normalized(before);
  const now = normalized(after);
  for (const [field, value] of fields) {
    if (value.before === "" || !was.includes(value.before) || !now.includes(value.after)) continue;
    if (was.split(value.before).join(value.after) !== now) continue;
    return { kind: "record", field, value };
  }
  return undefined;
}

/** What changed inside one block, as one or more kinds; empty when whitespace is all that differs. */
function semanticChanges(before: TwinBlock, after: TwinBlock, records: ReadonlyMap<string, { before: string; after: string }>): Detail[] {
  if (normalized(before.text) === normalized(after.text)) return [];

  const oldHeading = headingText(before.text);
  const newHeading = headingText(after.text);
  if (oldHeading !== undefined && newHeading !== undefined) return [{ kind: "heading", text: { before: oldHeading, after: newHeading } }];

  const oldFence = fenceLanguage(before.text);
  const newFence = fenceLanguage(after.text);
  if (oldFence !== undefined && newFence !== undefined) {
    return oldFence === newFence ? [{ kind: "code" }] : [{ kind: "code-language", language: { before: oldFence, after: newFence } }];
  }

  const oldTable = tableRows(before.text);
  const newTable = tableRows(after.text);
  if (oldTable !== undefined && newTable !== undefined) return [tableChange(oldTable, newTable)];

  const record = recordChange(before.text, after.text, records);
  if (record !== undefined) return [record];

  const details = destinationChanges(before.text, after.text);
  if (normalized(withoutDestinations(before.text)) !== normalized(withoutDestinations(after.text))) details.push({ kind: "edited" });
  if (details.length === 0) details.push({ kind: "edited" });
  return details;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  map.set(key, [...(map.get(key) ?? []), value]);
}

/** The indexes (in the after order) of the pairs that stayed in order: a longest increasing subsequence. */
function stayedInOrder(pairs: readonly { readonly beforeIndex: number }[]): Set<number> {
  const length = pairs.length;
  const best = new Array<number>(length).fill(1);
  const previous = new Array<number>(length).fill(-1);
  let end = -1;
  for (let index = 0; index < length; index += 1) {
    for (let earlier = 0; earlier < index; earlier += 1) {
      if (pairs[earlier]!.beforeIndex < pairs[index]!.beforeIndex && best[earlier]! + 1 > best[index]!) {
        best[index] = best[earlier]! + 1;
        previous[index] = earlier;
      }
    }
    if (end === -1 || best[index]! > best[end]!) end = index;
  }
  const kept = new Set<number>();
  for (let index = end; index !== -1; index = previous[index]!) kept.add(index);
  return kept;
}

/** The span of a twin block, from the build's mapping when it has one and the twin's own lines otherwise. */
function spanOf(block: TwinBlock, entry: BlockEntry | undefined, page: BuildPage, source: string | undefined): SourceSpan {
  if (entry === undefined) return { path: source ?? page.source, range: { start: block.start, end: block.end } };
  const end = entry.endLine >= entry.line ? entry.endLine : entry.line + (block.end - block.start);
  return { path: entry.file, range: { start: entry.line, end } };
}

/** Pairs each twin block with the source map entry of the same id, then by position when the ids differ. */
function entriesFor(blocks: readonly TwinBlock[], mapping: PageMapping | undefined): (BlockEntry | undefined)[] {
  if (mapping === undefined) return blocks.map(() => undefined);
  const byId = new Map<string, BlockEntry[]>();
  for (const entry of mapping.blocks) push(byId, entry.id, entry);
  const used = new Set<BlockEntry>();
  const claim = (entry: BlockEntry | undefined): BlockEntry | undefined => {
    if (entry === undefined || used.has(entry)) return undefined;
    used.add(entry);
    return entry;
  };
  return blocks.map((block, index) => {
    const exact = claim((byId.get(block.id) ?? []).find((entry) => !used.has(entry)));
    if (exact !== undefined) return exact;
    // A record page's twin comes from its template, so an automatic id can differ; the order still agrees.
    return mapping.blocks.length === blocks.length ? claim(mapping.blocks[index]) : undefined;
  });
}

/** One side's blocks, with source spans, and the headings the source map knows. */
async function sideOf(build: Build, page: BuildPage, reader: Reader): Promise<{ blocks: SideBlock[]; headings: readonly { line: number; text: string }[] } | undefined> {
  const twin = await reader.text(build, twinOf(page));
  if (twin === undefined) return undefined;
  const mapping = (await mappingOf(build, reader))?.pages.get(page.url);
  const source = mapping?.source ?? page.source;
  const tree = await parseMarkdown(twin, 1);
  const parsed = declaredBlocks({ file: source, tree, markdown: twin, bodyLine: 1 }).blocks;
  const lines = twin.split(/\r\n|\r|\n/u);
  const texts: TwinBlock[] = [];
  let heading: string | null = null;
  for (const block of parsed) {
    const text = lines.slice(block.pos.line - 1, block.pos.endLine).join("\n");
    const own = headingText(text);
    if (own !== undefined) heading = own;
    texts.push({ id: block.id, start: block.pos.line, end: block.pos.endLine, text, heading: own ?? heading });
  }
  const entries = entriesFor(texts, mapping);
  const headings = mapping?.headings ?? [];
  const blocks = texts.map((block, index) => {
    const span = spanOf(block, entries[index], page, source);
    // A block before the first parsed heading can still sit under a heading the source map knows.
    const section = block.heading === null ? headings.filter((candidate) => candidate.line <= span.range.start).at(-1) : undefined;
    return { ...block, heading: section?.text ?? block.heading, span };
  });
  return { blocks, headings };
}

function blockOf(kind: BlockKind, heading: string | null, id: string | null, spans: { before?: SourceSpan; after?: SourceSpan }, detail?: Detail): Block {
  const range = (spans.after ?? spans.before)?.range;
  return {
    heading,
    id,
    kind,
    ...(spans.before === undefined ? {} : { before: spans.before }),
    ...(spans.after === undefined ? {} : { after: spans.after }),
    ...(range === undefined ? {} : { range }),
    ...(detail === undefined ? {} : detail),
  };
}

/** Compares two block lists by identifier, reporting moves, edits, and uncertain matches. */
function compareIdentified(before: readonly SideBlock[], after: readonly SideBlock[], records: ReadonlyMap<string, { before: string; after: string }>): Block[] {
  const byId = new Map<string, SideBlock[]>();
  for (const block of before) push(byId, block.id, block);
  const pairedBy = new Map<SideBlock, SideBlock>();
  const pairedWith = new Set<SideBlock>();
  const uncertain = new Map<SideBlock, Block>();
  const unmatched: SideBlock[] = [];

  for (const block of after) {
    const candidates = (byId.get(block.id) ?? []).filter((candidate) => !pairedWith.has(candidate));
    if (candidates.length === 1) {
      pairedBy.set(block, candidates[0]!);
      pairedWith.add(candidates[0]!);
    } else if (candidates.length > 1) {
      // Two blocks carry the same id: the report does not pick one and call it matched.
      for (const candidate of candidates) pairedWith.add(candidate);
      uncertain.set(block, blockOf("uncertain", block.heading, block.id, { after: block.span }));
    } else {
      unmatched.push(block);
    }
  }

  // A block whose id changed but whose text did not is the same block; two such candidates are uncertain.
  const byText = new Map<string, SideBlock[]>();
  for (const block of before) if (!pairedWith.has(block)) push(byText, normalized(block.text), block);
  const added = new Set<SideBlock>();
  for (const block of unmatched) {
    const candidates = (byText.get(normalized(block.text)) ?? []).filter((candidate) => !pairedWith.has(candidate));
    if (candidates.length === 1) {
      pairedBy.set(block, candidates[0]!);
      pairedWith.add(candidates[0]!);
    } else if (candidates.length > 1) {
      for (const candidate of candidates) pairedWith.add(candidate);
      uncertain.set(block, blockOf("uncertain", block.heading, block.id, { after: block.span }));
    } else {
      added.add(block);
    }
  }

  const pairs = after.flatMap((block, index) => {
    const pair = pairedBy.get(block);
    if (pair === undefined) return [];
    return [{ after: block, before: pair, beforeIndex: before.indexOf(pair), afterIndex: index }];
  });
  const stayed = stayedInOrder(pairs);
  const out: Block[] = [];
  let pairIndex = 0;

  for (const [index, block] of after.entries()) {
    const pair = pairedBy.get(block);
    if (pair === undefined) {
      const notice = uncertain.get(block);
      if (notice !== undefined) out.push(notice);
      else if (added.has(block)) out.push(blockOf("added", block.heading, block.id, { after: block.span }));
      continue;
    }
    const changes = semanticChanges(pair, block, records);
    const spans = { before: pair.span, after: block.span };
    const kept = stayed.has(pairIndex);
    pairIndex += 1;
    if (!kept) {
      if (changes.length === 0) out.push(blockOf("moved", block.heading, block.id, spans));
      else {
        out.push(blockOf("moved-edited", block.heading, block.id, spans, changes[0]));
        for (const change of changes) out.push(blockOf(change.kind, block.heading, block.id, spans, change));
      }
      continue;
    }
    for (const change of changes) out.push(blockOf(change.kind, block.heading, block.id, spans, change));
  }

  for (const block of before) {
    if (pairedWith.has(block)) continue;
    out.push(blockOf("removed", block.heading, block.id, { before: block.span }));
  }
  return out;
}

/** The heading diff of a build without block ids: every matched section compared as one block. */
async function headingChanges(before: string, after: string): Promise<Block[]> {
  const diff = diffMarkdown(before, after);
  const lineCount = (text: string): number => (text === "" ? 1 : text.split(/\r\n|\r|\n/u).length - (/(\r\n|\r|\n)$/u.test(text) ? 1 : 0));
  const inHead: Block[] = [];
  for (const section of diff.added) inHead.push({ heading: section.heading, id: section.id, kind: "added", range: { ...section.newRange } });
  for (const section of diff.changed) inHead.push({ heading: section.heading, id: section.id, kind: "edited", range: { ...section.newRange } });
  for (const section of diff.moved) {
    inHead.push({ heading: section.heading, id: section.id, kind: "moved", range: { ...section.newRange } });
    if (normalized(section.oldText) !== normalized(section.newText)) {
      inHead.push({ heading: section.heading, id: section.id, kind: "edited", range: { ...section.newRange } });
    }
  }
  const order: Record<string, number> = { added: 0, edited: 1, moved: 2, removed: 3 };
  inHead.sort((a, b) => (a.range?.start ?? 0) - (b.range?.start ?? 0) || (order[a.kind] ?? 0) - (order[b.kind] ?? 0));
  const removed: Block[] = diff.removed.map((section) => ({ heading: section.heading, id: section.id, kind: "removed", range: { ...section.oldRange } }));
  removed.sort((a, b) => (a.range?.start ?? 0) - (b.range?.start ?? 0));
  const blocks = [...inHead, ...removed];
  if (blocks.length === 0 && normalized(before) !== normalized(after)) {
    blocks.push({ heading: null, id: null, kind: "edited", range: { start: 1, end: lineCount(after) } });
  }
  return blocks;
}

/** The blocks of one page's twins; empty when the text did not change or no twin was written. */
export async function blocksOf(base: Build, head: Build, delta: PageDelta, reader: Reader): Promise<Block[]> {
  if (!delta.changes.includes("text")) return [];
  const [before, after] = await Promise.all([
    reader.text(base, twinOf(delta.base)),
    reader.text(head, twinOf(delta.head)),
  ]);
  if (before === undefined || after === undefined) return [];

  const identified = (await mappingOf(base, reader)) !== undefined && (await mappingOf(head, reader)) !== undefined;
  if (!identified) return headingChanges(before, after);

  const [oldSide, newSide] = await Promise.all([sideOf(base, delta.base, reader), sideOf(head, delta.head, reader)]);
  if (oldSide === undefined || newSide === undefined) return headingChanges(before, after);
  const records = await recordValues(reader, base, delta.base, reader, head, delta.head);
  return compareIdentified(oldSide.blocks, newSide.blocks, records);
}

/** A changed page as the report lists it. */
export async function changedPage(base: Build, head: Build, delta: PageDelta, reader: Reader): Promise<ChangedPage> {
  return {
    url: delta.head.url,
    source: delta.head.source,
    title: delta.head.title,
    changes: delta.changes,
    renderOnly: delta.changes.length === 1 && delta.changes[0] === "html",
    blocks: await blocksOf(base, head, delta, reader),
  };
}
