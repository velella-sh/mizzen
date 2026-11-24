/**
 * Reads a versioned decision record (an ADR or another decision document) from one Markdown file's text.
 *
 * The reader is local and synchronous: no file read, no network, no clock. A record is split into front matter and a
 * body, the required front matter keys are checked, and the body's headings are matched to the named sections
 * (`Context`, `Decision`, `Rationale`, `Alternatives`). Every problem is reported at the exact front matter key or
 * heading it belongs to, and a record with a problem is not returned: a half-read decision is worse than none.
 *
 * The original text of each section is kept verbatim, with the span it occupies, so a rationale or a rejected
 * alternative can be cited from the same bytes the author wrote.
 */
import { LineCounter, isMap, isNode, parseDocument, type Document, type Node, type Pair, type YAMLMap } from "yaml";
import type { Diagnostic } from "../contracts/diagnostic.ts";
import type { SourcePos } from "../contracts/source.ts";
import type {
  DecisionAlternative,
  DecisionEvidence,
  DecisionEvidenceKind,
  DecisionLink,
  DecisionLinkKind,
  DecisionRecord,
  DecisionSource,
  DecisionStatus,
  DecisionText,
  DecisionValidity,
} from "../contracts/decisions.ts";
import { parseFrontMatter } from "../content/frontmatter.ts";
import { checkAsOf } from "../dates/as-of.ts";
import { lineIndex, nodePos, sourcePosOf } from "../data/positions.ts";

/** The five statuses, in report order. */
export const DECISION_STATUSES: readonly DecisionStatus[] = [
  "proposed",
  "accepted",
  "superseded",
  "deprecated",
  "rejected",
];

/** The link kinds a decision may name. */
export const DECISION_LINK_KINDS: readonly DecisionLinkKind[] = ["api", "behavior", "surface", "collection", "page"];

/** The evidence kinds a decision may cite. */
export const DECISION_EVIDENCE_KINDS: readonly DecisionEvidenceKind[] = ["commit", "pull-request", "rfc", "test"];

/** The directory a decision file lives in, and the numbered file name an ADR folder uses. */
export const DECISION_FILE = /^(\d{3,4})[-_].*\.md$/i;

/** True for one of the five lifecycle statuses. */
export function isDecisionStatus(value: unknown): value is DecisionStatus {
  return typeof value === "string" && (DECISION_STATUSES as readonly string[]).includes(value);
}

/** What reading one record needs. */
export interface ParseDecisionOptions {
  /** The file the record was read from, for diagnostics. */
  readonly file: string;
  /** A prefix for diagnostic ids. */
  readonly idPrefix?: string;
}

/** The result of reading one record. */
export interface ParseDecisionResult {
  /** The record, present exactly when `diagnostics` holds no error. */
  readonly record?: DecisionRecord;
  /** Every finding, in file order. */
  readonly diagnostics: readonly Diagnostic[];
}

/** One section of the body, matched to a canonical name. */
interface Section {
  readonly title: string;
  readonly text: string;
  readonly span: SourcePos;
}

/** A non-array, non-null object. */
function isMapping(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Compares strings by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sorts diagnostics by line, column, and id, keeping a stable order for equal positions. */
function sortDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return [...diagnostics].sort((a, b) => {
    const pa = a.pos;
    const pb = b.pos;
    if (pa === undefined || pb === undefined) return pa === pb ? 0 : pa === undefined ? 1 : -1;
    return pa.line - pb.line || pa.column - pb.column || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
}

/** True when the file starts with a closed `---` front matter block. */
function hasFrontMatter(text: string): boolean {
  return /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.test(text.replace(/^﻿/, ""));
}

/** The YAML text between the fences, and the file line its first line has. */
function frontMatterYaml(text: string): { readonly yaml: string; readonly firstLine: number } {
  const lines = text.split("\n");
  let close = -1;
  for (let index = 1; index < lines.length; index++) {
    if (/^(?:---|\.\.\.)[ \t]*\r?$/.test(lines[index]!)) {
      close = index;
      break;
    }
  }
  if (close === -1) return { yaml: "", firstLine: 2 };
  return { yaml: lines.slice(1, close).join("\n"), firstLine: 2 };
}

/** Shifts a position by whole lines, keeping its columns. */
function shiftLines(pos: SourcePos, delta: number): SourcePos {
  if (delta === 0) return pos;
  return { ...pos, line: pos.line + delta, endLine: pos.endLine + delta };
}

/** Looks up the pair of a top-level key in a parsed front matter document. */
function keyPair(doc: Document, key: string): Pair<unknown, unknown> | undefined {
  if (!isMap(doc.contents)) return undefined;
  return (doc.contents as YAMLMap).items.find((pair) => {
    const node = pair.key as Node | null;
    return node !== null && typeof node === "object" && "value" in node && (node as { value?: unknown }).value === key;
  });
}

/** The source position of a front matter key's value (or its key when there is no value), in file lines. */
function spanOfKey(
  doc: Document,
  index: ReturnType<typeof lineIndex>,
  file: string,
  firstLine: number,
  key: string,
): SourcePos {
  const pair = keyPair(doc, key);
  const node = isNode(pair?.value) ? (pair!.value as Node) : isNode(pair?.key) ? (pair!.key as Node) : undefined;
  if (node === undefined) return { file, line: 1, column: 1, endLine: 1, endColumn: 1 };
  return shiftLines(sourcePosOf(nodePos(index, file, node)), firstLine - 1);
}

/** A scalar text value, trimmed; `undefined` for anything else. */
function textOf(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  }
  if (typeof value === "number") return String(value);
  return undefined;
}

/** A string list, keeping only non-empty trimmed values. */
function stringList(value: unknown): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? [] : [trimmed];
  }
  if (!Array.isArray(value)) return [];
  return value.map((item) => (typeof item === "string" ? item.trim() : "")).filter((item) => item !== "");
}

/** A record source from a string or `{ value, public }`. */
function sourceOf(value: unknown): DecisionSource | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? undefined : { value: trimmed };
  }
  if (!isMapping(value)) return undefined;
  const raw = textOf(value.value);
  if (raw === undefined) return undefined;
  return { value: raw, ...(typeof value.public === "boolean" ? { public: value.public } : {}) };
}

/** A validity block, keeping only the forms it declares. */
function validityOf(value: unknown): DecisionValidity {
  if (!isMapping(value)) return {};
  const versions = stringList(value.versions);
  const snapshots = stringList(value.snapshots);
  const from = textOf(value.from);
  const until = textOf(value.until);
  return {
    ...(versions.length === 0 ? {} : { versions }),
    ...(from === undefined ? {} : { from }),
    ...(until === undefined ? {} : { until }),
    ...(snapshots.length === 0 ? {} : { snapshots }),
  };
}

/** One link from `kind:id`, `{ kind, id }`, or a bare id whose kind is the key it was written under. */
function linkOf(value: unknown, defaultKind: DecisionLinkKind | undefined, span: SourcePos): DecisionLink | undefined {
  if (typeof value === "string") {
    const raw = value.trim();
    if (raw === "") return undefined;
    const at = raw.indexOf(":");
    if (at > 0) {
      const kind = raw.slice(0, at).trim() as DecisionLinkKind;
      const id = raw.slice(at + 1).trim();
      if ((DECISION_LINK_KINDS as readonly string[]).includes(kind) && id !== "") return { kind, id, raw, pos: span };
    }
    if (defaultKind !== undefined) return { kind: defaultKind, id: raw, raw: `${defaultKind}:${raw}`, pos: span };
    return undefined;
  }
  if (!isMapping(value)) return undefined;
  const kind = textOf(value.kind) as DecisionLinkKind | undefined;
  const id = textOf(value.id);
  if (kind === undefined || id === undefined || !(DECISION_LINK_KINDS as readonly string[]).includes(kind)) return undefined;
  return { kind, id, raw: `${kind}:${id}`, pos: span };
}

/** The links a record names, under `links`, `apis`, `behaviors`, `surfaces`, `collections`, or `pages`. */
function linksOf(record: Readonly<Record<string, unknown>>, span: SourcePos): DecisionLink[] {
  const links: DecisionLink[] = [];
  const push = (link: DecisionLink | undefined): void => {
    if (link !== undefined) links.push(link);
  };
  for (const value of Array.isArray(record.links) ? record.links : []) push(linkOf(value, undefined, span));
  const byKey: readonly (readonly [string, DecisionLinkKind])[] = [
    ["apis", "api"],
    ["behaviors", "behavior"],
    ["surfaces", "surface"],
    ["collections", "collection"],
    ["pages", "page"],
  ];
  for (const [key, kind] of byKey) {
    const value = record[key];
    if (typeof value === "string") push(linkOf(value, kind, span));
    for (const entry of Array.isArray(value) ? value : []) push(linkOf(entry, kind, span));
  }
  const seen = new Set<string>();
  return links
    .filter((link) => {
      const key = `${link.kind}\u0000${link.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => byCodePoint(a.kind, b.kind) || byCodePoint(a.id, b.id));
}

/** One evidence entry from `kind:value` or `{ kind, value }`. */
function evidenceEntryOf(
  value: unknown,
  defaultKind: DecisionEvidenceKind | undefined,
): { kind: DecisionEvidenceKind; value: string } | undefined {
  if (typeof value === "string") {
    const raw = value.trim();
    if (raw === "") return undefined;
    const at = raw.indexOf(":");
    if (at > 0) {
      const kind = raw.slice(0, at).trim() as DecisionEvidenceKind;
      const rest = raw.slice(at + 1).trim();
      if ((DECISION_EVIDENCE_KINDS as readonly string[]).includes(kind) && rest !== "") return { kind, value: rest };
    }
    if (defaultKind !== undefined) return { kind: defaultKind, value: raw };
    return undefined;
  }
  if (!isMapping(value)) return undefined;
  const kind = textOf(value.kind) as DecisionEvidenceKind | undefined;
  const raw = textOf(value.value);
  if (kind === undefined || raw === undefined || !(DECISION_EVIDENCE_KINDS as readonly string[]).includes(kind)) return undefined;
  return { kind, value: raw };
}

/** The evidence a record cites, under `evidence`, `commits`, `pullRequests`, `rfcs`, or `tests`. */
function evidenceOfRecord(
  record: Readonly<Record<string, unknown>>,
  resolve: (kind: DecisionEvidenceKind, value: string) => boolean,
  span: SourcePos,
): DecisionEvidence[] {
  const out: DecisionEvidence[] = [];
  const add = (entry: { kind: DecisionEvidenceKind; value: string } | undefined): void => {
    if (entry !== undefined) {
      out.push({ kind: entry.kind, value: entry.value, status: resolve(entry.kind, entry.value) ? "resolved" : "unknown", pos: span });
    }
  };
  for (const value of Array.isArray(record.evidence) ? record.evidence : []) add(evidenceEntryOf(value, undefined));
  const keys: readonly (readonly [string, DecisionEvidenceKind])[] = [
    ["commits", "commit"],
    ["pullRequests", "pull-request"],
    ["rfcs", "rfc"],
    ["tests", "test"],
  ];
  for (const [key, kind] of keys) {
    const value = record[key];
    if (typeof value === "string") add(evidenceEntryOf(value, kind));
    for (const entry of Array.isArray(value) ? value : []) add(evidenceEntryOf(entry, kind));
  }
  const seen = new Set<string>();
  return out
    .filter((entry) => {
      const key = `${entry.kind}\u0000${entry.value}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => byCodePoint(a.kind, b.kind) || byCodePoint(a.value, b.value));
}

/**
 * Splits a body into its top-level sections, one per ATX or Setext heading, with the exact span of each. The span
 * runs from the heading line to the last line before the next heading, so `sliceSpan` returns what the author wrote.
 */
function sectionsOf(body: string, file: string, bodyLine: number): Section[] {
  const lines = body.split("\n");
  const starts: { index: number; depth: number; title: string; underline: boolean }[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const atx = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*\r?$/.exec(line);
    if (atx !== null) {
      starts.push({ index, depth: atx[1]!.length, title: atx[2]!.trim(), underline: false });
      continue;
    }
    const setext = /^(=+|-+)[ \t]*\r?$/.exec(line);
    if (setext !== null && index > 0 && lines[index - 1]!.trim() !== "" && !starts.some((start) => start.index === index - 1)) {
      starts.push({ index: index - 1, depth: setext[1]!.startsWith("=") ? 1 : 2, title: lines[index - 1]!.trim(), underline: true });
    }
  }

  const sections: Section[] = [];
  for (let position = 0; position < starts.length; position++) {
    const current = starts[position]!;
    const next = starts[position + 1];
    const endIndex = next === undefined ? lines.length - 1 : next.index - 1;
    const textStart = current.index + (current.underline ? 2 : 1);
    const text = lines.slice(textStart, endIndex + 1).join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
    sections.push({
      title: current.title,
      text,
      span: {
        file,
        line: bodyLine + current.index,
        column: 1,
        endLine: bodyLine + Math.max(current.index, endIndex),
        endColumn: Math.max(1, (lines[endIndex] ?? "").length),
      },
    });
  }
  return sections;
}

/** The canonical form of a section title: lower case, punctuation folded to spaces. */
function canonical(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** The first section whose title matches one of `names`. */
function findSection(sections: readonly Section[], names: readonly string[]): Section | undefined {
  const wanted = new Set(names);
  return sections.find((section) => wanted.has(canonical(section.title)));
}

/** The paragraph of an alternative that says why it was rejected. */
function rejectionOf(section: { readonly text: string; readonly span: SourcePos }): DecisionText | undefined {
  const lines = section.text.split("\n");
  const at = lines.findIndex((line) => /(?:^|\s)(?:rejected|reject|not chosen|not selected|why not|turned down)\b/i.test(line));
  if (at < 0) return undefined;
  const kept = [lines[at]!.trim()];
  for (let index = at + 1; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.trim() === "") break;
    if (!/^\s{2,}/.test(line) && !/^[*-]\s/.test(line)) break;
    kept.push(line.trim());
  }
  return {
    text: kept.join(" ").trim(),
    span: { ...section.span, line: section.span.line + at, endLine: section.span.line + at },
  };
}

/** Every alternative under an `Alternatives` section: one per bullet or per sub-heading. */
function alternativesOf(section: Section | undefined): DecisionAlternative[] {
  if (section === undefined) return [];
  const alternatives: DecisionAlternative[] = [];
  const lines = section.text.split("\n");
  let current: { name: string; start: number; body: string[] } | undefined;
  const flush = (): void => {
    if (current === undefined) return;
    const text = current.body.join("\n").trim();
    const span = { ...section.span, line: section.span.line + current.start, endLine: section.span.line + current.start };
    const alternative: DecisionAlternative = { name: current.name, text: { text, span } };
    const rejected = rejectionOf({ text, span });
    if (rejected !== undefined) alternatives.push({ ...alternative, rejectedBecause: rejected });
    else alternatives.push(alternative);
    current = undefined;
  };
  for (const [index, line] of lines.entries()) {
    const bullet = /^[*-][ \t]+(.+)$/.exec(line);
    if (bullet !== null) {
      flush();
      const body = bullet[1]!.trim();
      const lead = /^\*\*(.+?)\*\*[:.—-]?\s*(.*)$/.exec(body) ?? /^_(.+?)_[:.—-]?\s*(.*)$/.exec(body);
      const split = lead ?? /^([^:—–-]{1,80})[:—–-]\s*(.*)$/.exec(body);
      const name = (split?.[1] ?? body).trim();
      const rest = (split?.[2] ?? "").replace(/^[—–-]\s*/, "");
      current = { name, start: index, body: rest === "" ? [] : [rest] };
      continue;
    }
    const heading = /^(#{1,6})[ \t]+(.+?)[ \t]*\r?$/.exec(line);
    if (heading !== null) {
      flush();
      current = { name: heading[2]!.trim(), start: index, body: [] };
      continue;
    }
    if (current !== undefined) current.body.push(line);
  }
  flush();
  return alternatives;
}

const CONTEXT_NAMES = ["context", "background", "problem", "motivation"];
const DECISION_NAMES = ["decision", "the decision", "resolution"];
const RATIONALE_NAMES = ["rationale", "why", "reasoning", "consequences", "reasons", "justification"];
const ALTERNATIVE_NAMES = ["alternatives", "considered alternatives", "options", "rejected alternatives", "considered options"];

/**
 * Reads one decision record from a Markdown file's text.
 *
 * The front matter must name an `id`, a `title`, a `status` from the five, a real `date`, and a `source`. A missing or
 * invalid key is a located error, and a record with any error is not returned.
 */
export function parseDecision(text: string, options: ParseDecisionOptions): ParseDecisionResult {
  const prefix = options.idPrefix ?? "decision";
  const diagnostics: Diagnostic[] = [];
  const start: SourcePos = { file: options.file, line: 1, column: 1, endLine: 1, endColumn: 1 };

  if (!hasFrontMatter(text)) {
    diagnostics.push({
      id: `${prefix}.no-front-matter`,
      severity: "error",
      message: "A decision record needs front matter naming its id, title, status, date, and source.",
      pos: start,
      help: "Start the file with `---`, write the five keys, and close the block with `---`.",
    });
    return { diagnostics };
  }

  const front = parseFrontMatter(text, options.file);
  diagnostics.push(...front.diagnostics);
  if (front.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return { diagnostics: sortDiagnostics(diagnostics) };
  }

  const { yaml, firstLine } = frontMatterYaml(text);
  const doc = parseDocument(yaml, { lineCounter: new LineCounter() });
  const index = lineIndex(yaml);
  const spanOf = (key: string): SourcePos => spanOfKey(doc, index, options.file, firstLine, key);
  const record = front.data;

  const reported = (id: string, message: string, key: string, help?: string): void => {
    diagnostics.push({ id: `${prefix}.${id}`, severity: "error", message, pos: spanOf(key), ...(help === undefined ? {} : { help }) });
  };

  const id = textOf(record.id);
  if (id === undefined) reported("missing-id", "A decision record needs a non-empty `id`.", "id");
  const title = textOf(record.title);
  if (title === undefined) reported("missing-title", "A decision record needs a non-empty `title`.", "title");

  let status: DecisionStatus | undefined;
  if (record.status === undefined) {
    reported("missing-status", `A decision record needs a \`status\`: ${DECISION_STATUSES.join(", ")}.`, "status");
  } else if (isDecisionStatus(record.status)) {
    status = record.status;
  } else {
    reported("invalid-status", `\`status\` is "${String(record.status)}"; use one of ${DECISION_STATUSES.join(", ")}.`, "status");
  }

  let date: string | undefined;
  if (record.date === undefined) {
    reported("missing-date", "A decision record needs an explicit `date` written YYYY-MM-DD.", "date");
  } else {
    const raw = typeof record.date === "string" ? record.date.trim() : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || checkAsOf(raw) !== undefined) {
      reported("invalid-date", `\`date\` is not a day: ${JSON.stringify(record.date)}; use YYYY-MM-DD.`, "date");
    } else {
      date = raw;
    }
  }

  let source: DecisionSource | undefined;
  if (record.source === undefined) {
    reported("missing-source", "A decision record needs a `source`: where the decision was made.", "source");
  } else {
    source = sourceOf(record.source);
    if (source === undefined) reported("invalid-source", "`source` must be a non-empty string or `{ value, public }`.", "source");
  }

  if (id === undefined || title === undefined || status === undefined || date === undefined || source === undefined || diagnostics.length > 0) {
    return { diagnostics: sortDiagnostics(diagnostics) };
  }

  const span = spanOf("id");
  const sections = sectionsOf(front.body, options.file, front.bodyLine);
  const toText = (section: Section | undefined): DecisionText | undefined =>
    section === undefined || section.text === "" ? undefined : { text: section.text, span: section.span };

  const context = toText(findSection(sections, CONTEXT_NAMES));
  const decision = toText(findSection(sections, DECISION_NAMES));
  const rationale = toText(findSection(sections, RATIONALE_NAMES));

  const resolveEvidence = (kind: DecisionEvidenceKind, value: string): boolean => {
    // With no site model, only a test path or a commit-shaped id can be named resolved; the rest stays `unknown`
    // until a caller resolves it against a build.
    if (kind === "test") return /^test\/.+\.(?:test|spec)\.(?:ts|tsx|js|mjs)$/.test(value);
    if (kind === "commit") return /^[0-9a-f]{7,40}$/i.test(value);
    return false;
  };

  const parsed: DecisionRecord = {
    id,
    title,
    status,
    date,
    source,
    supersedes: stringList(record.supersedes).sort(byCodePoint),
    supersededBy: [],
    validity: validityOf(record.validity),
    links: linksOf(record, span),
    evidence: evidenceOfRecord(record, resolveEvidence, span),
    ...(context === undefined ? {} : { context }),
    ...(decision === undefined ? {} : { decision }),
    ...(rationale === undefined ? {} : { rationale }),
    alternatives: alternativesOf(findSection(sections, ALTERNATIVE_NAMES)),
    audience: stringList(record.audience),
    public: record.public === true,
    span,
  };

  return { record: parsed, diagnostics: sortDiagnostics(diagnostics) };
}
