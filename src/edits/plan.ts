/**
 * Turning a change to a rendered page into a patch of its Markdown source.
 *
 * A caller names a page by URL and a heading by its anchor id, and says what the heading should
 * read. The plan looks the heading up in the site model, where every source heading already carries
 * its span, and returns the {@link Patch} that replaces exactly that span. The patch is
 * plain data: nothing here reads a file, and the caller supplies the source text it was computed
 * from.
 *
 * Content that is rendered but not written in the page's Markdown — an app page, a heading in raw
 * HTML, or anything a theme adds — has no source heading. Asking to edit one is a typed
 * `edit.generated-target` error, never a guess.
 */
import type { Heading, Page, Site, SourcePos } from "../contracts/index.ts";
import { compileSchemas } from "../data/schema.ts";
import { parseDocument } from "yaml";
import { applyPatch, hashSource, PatchError, sliceBySpan, type Patch, type PatchSpan } from "./patch.ts";

/** Why a heading edit could not be planned. Each code names one situation, so a caller can act on it. */
export type EditPlanErrorCode =
  | "edit.unknown-page"
  | "edit.generated-target"
  | "edit.ambiguous-target"
  | "edit.source-mismatch"
  | "edit.unparseable"
  | "edit.invalid-record";

/** A refused edit plan. `url` and `headingId` echo the request, so a caller can report it. */
export class EditPlanError extends Error {
  readonly code: EditPlanErrorCode;
  readonly url: string;
  readonly headingId: string;
  /** The span the plan pointed at, when the error came from checking the source text. */
  readonly span: PatchSpan | undefined;

  constructor(
    code: EditPlanErrorCode,
    message: string,
    detail: { readonly url: string; readonly headingId: string; readonly span?: PatchSpan },
  ) {
    super(message);
    this.name = "EditPlanError";
    this.code = code;
    this.url = detail.url;
    this.headingId = detail.headingId;
    this.span = detail.span;
  }
}

/** What {@link planHeadingEdit} needs. */
export interface PlanHeadingEditOptions {
  /** The site model the page and its headings come from. */
  readonly site: Site;
  /** The page's source file as text, including front matter and line endings. */
  readonly source: string;
  /** The page's output URL, as it appears in the site model. */
  readonly url: string;
  /** The heading's anchor id, unique within the page. */
  readonly headingId: string;
  /** The heading's new plain text. Inline Markdown is not interpreted. */
  readonly newText: string;
}

/** A heading id that points at a page's own Markdown rather than generated content. */
function pageAt(site: Site, url: string): Page | undefined {
  return site.pages.find((candidate) => candidate.url === url);
}

/** Whether a heading position is a usable 1-based span, as generated content's may not be. */
function usablePos(pos: SourcePos): boolean {
  const values = [pos.line, pos.column, pos.endLine, pos.endColumn];
  if (!values.every((value) => Number.isInteger(value) && value >= 1)) return false;
  return pos.endLine > pos.line || (pos.endLine === pos.line && pos.endColumn >= pos.column);
}

/**
 * The number of columns the line has, in code points. A trailing `\r` is a line ending,
 * not a column, so a CRLF file measures like the same file with LF endings.
 */
function codePointColumns(line: string): number {
  return Array.from(line.endsWith("\r") ? line.slice(0, -1) : line).length;
}

/**
 * The heading's span in the source, with its end clamped to the line's real width.
 *
 * `remark` reports columns in UTF-16 code units while the contract counts code points, so a heading
 * with a surrogate pair reports an end one column too far for every astral character. Clamping to
 * what the line actually holds keeps the span exact for both; for ASCII it changes nothing.
 */
function spanOfPos(source: string, pos: SourcePos): PatchSpan | undefined {
  const lines = source.split("\n");
  const endLine = lines[pos.endLine - 1];
  if (lines[pos.line - 1] === undefined || endLine === undefined) return undefined;
  const endColumn = Math.min(pos.endColumn, codePointColumns(endLine));
  if (endColumn < pos.column && pos.endLine === pos.line) return undefined;
  return { file: pos.file, line: pos.line, column: pos.column, endLine: pos.endLine, endColumn: Math.max(1, endColumn) };
}

/** Whether `expected`, the text at the heading's span, is a heading of the given depth. */
function looksLikeHeading(expected: string, depth: number): boolean {
  const lines = expected.split("\n");
  const first = lines[0] ?? "";
  const atx = /^ {0,3}(#{1,6})(?:[ \t]|$)/.exec(first);
  if (atx !== null) return atx[1]?.length === depth;
  if (lines.length < 2) return false;
  const underline = (lines[lines.length - 1] ?? "").trim();
  return depth === 1 ? /^=+$/.test(underline) : depth === 2 && /^-+$/.test(underline);
}

/**
 * Plans the single patch that changes a heading's text.
 *
 * The page is found by `url`, then the heading by `headingId` in `page.headings` — source headings
 * only. The span is the heading node's full span in `source`, its `expected` is the exact text there,
 * and its `replacement` is `'#' × depth + ' ' + newText`. Leading indentation outside the heading
 * node and a line ending after it are left alone; a line ending inside the span (setext headings)
 * is carried through.
 *
 * The patch carries the SHA-256 of `source`, so applying it to a file that changed after planning
 * is refused with `hash-mismatch` before the span is touched.
 *
 * Throws an {@link EditPlanError}:
 * - `edit.unknown-page` when no page has the URL;
 * - `edit.generated-target` when the heading id is not a source heading, or has no usable position;
 * - `edit.ambiguous-target` when more than one source heading has the id, so the edit names no
 *   single span;
 * - `edit.source-mismatch` when the span in `source` does not hold a heading of that depth (usually
 *   because the caller passed another page's text).
 */
export function planHeadingEdit(options: PlanHeadingEditOptions): Patch {
  const { site, source, url, headingId, newText } = options;
  const page = pageAt(site, url);
  if (page === undefined) {
    throw new EditPlanError("edit.unknown-page", `No page has the URL ${JSON.stringify(url)}.`, {
      url,
      headingId,
    });
  }

  const matches = page.headings.filter((candidate) => candidate.id === headingId);
  if (matches.length > 1) {
    throw new EditPlanError(
      "edit.ambiguous-target",
      `Heading id ${JSON.stringify(headingId)} names ${matches.length} source headings of ${JSON.stringify(url)}; the edit is ambiguous.`,
      { url, headingId },
    );
  }
  const heading: Heading | undefined = matches[0];
  if (heading === undefined) {
    throw new EditPlanError(
      "edit.generated-target",
      `Heading ${JSON.stringify(headingId)} is not a source heading of ${JSON.stringify(url)}; it is generated content and has no Markdown source to patch.`,
      { url, headingId },
    );
  }
  if (!usablePos(heading.pos)) {
    throw new EditPlanError(
      "edit.generated-target",
      `Heading ${JSON.stringify(headingId)} on ${JSON.stringify(url)} has no usable source span; it is generated content and has no Markdown source to patch.`,
      { url, headingId },
    );
  }

  const span = spanOfPos(source, heading.pos);
  if (span === undefined) {
    throw new EditPlanError(
      "edit.source-mismatch",
      `Heading ${JSON.stringify(headingId)} on ${JSON.stringify(url)} points at ${heading.pos.file}:${heading.pos.line}:${heading.pos.column}, which is outside the source text given.`,
      { url, headingId },
    );
  }

  let expected: string;
  try {
    expected = sliceBySpan(source, span);
  } catch (error) {
    if (!(error instanceof PatchError)) throw error;
    throw new EditPlanError(
      "edit.source-mismatch",
      `Heading ${JSON.stringify(headingId)} on ${JSON.stringify(url)} points at a span outside the source text given: ${error.message}`,
      { url, headingId, span },
    );
  }

  if (!looksLikeHeading(expected, heading.depth)) {
    throw new EditPlanError(
      "edit.source-mismatch",
      `The source at ${heading.pos.file}:${heading.pos.line}:${heading.pos.column}-${span.endLine}:${span.endColumn} is not a depth-${heading.depth} heading: ${JSON.stringify(expected)}. Pass the page's own Markdown source.`,
      { url, headingId, span },
    );
  }

  // A heading node normally ends before its line's newline, so this is empty. A source that puts the
  // line ending inside the span (a setext heading) keeps it, so the following line does not move up.
  const newline = expected.endsWith("\r\n") ? "\r\n" : expected.endsWith("\n") ? "\n" : "";
  return {
    span,
    expected,
    replacement: `${"#".repeat(heading.depth)} ${newText}${newline}`,
    beforeHash: hashSource(source),
  };
}

/** What {@link planRecordFieldEdit} needs. */
export interface PlanRecordFieldEditOptions {
  /** The site model the record page comes from. */
  readonly site: Site;
  /** The site root, used to compile the collection's schema when it has one. */
  readonly root: string;
  /** The data file as text, including line endings. */
  readonly source: string;
  /** The record page's output URL. */
  readonly url: string;
  /** The top-level field to replace. */
  readonly field: string;
  /** The field's new value, written as the data file writes it. */
  readonly newText: string;
}

/** Reads the edited record's fields from a parsed data file, by the id the collection uses. */
function fieldsOfDocument(document: unknown, idField: string, id: string): Readonly<Record<string, unknown>> | undefined {
  const value: unknown = document;
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
      const fields = entry as Record<string, unknown>;
      if (String(fields[idField] ?? fields["id"] ?? "") === id) return fields;
    }
    return undefined;
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const fields = (value as Record<string, unknown>)[id];
    return typeof fields === "object" && fields !== null && !Array.isArray(fields)
      ? (fields as Record<string, unknown>)
      : undefined;
  }
  return undefined;
}

/**
 * Plans the single patch that changes one field of a record, and refuses a change the data file cannot hold.
 *
 * The page is found by `url` and must be a record page. The field's span is the one the collection read, so only that
 * value changes and the rest of the file keeps its bytes. After the patch the module parses the file again: a file that
 * no longer parses is `edit.unparseable`, and a record the collection's schema rejects is `edit.invalid-record`. A
 * collection without a schema is checked for a parse and an id only, because it has no other rule to apply.
 */
export function planRecordFieldEdit(options: PlanRecordFieldEditOptions): Patch {
  const { site, root, source, url, field, newText } = options;
  const page = pageAt(site, url);
  if (page === undefined) {
    throw new EditPlanError("edit.unknown-page", `No page has the URL ${JSON.stringify(url)}.`, { url, headingId: field });
  }
  const record = page.record;
  if (record === undefined) {
    throw new EditPlanError(
      "edit.generated-target",
      `${JSON.stringify(url)} is not a record page, so it has no field to edit.`,
      { url, headingId: field },
    );
  }
  const position = site.collections[record.collection]?.records.find((entry) => entry.id === record.id)?.fieldPositions[field];
  if (position === undefined) {
    throw new EditPlanError(
      "edit.generated-target",
      `The record ${record.collection}.${record.id} has no top-level field ${JSON.stringify(field)} with a span.`,
      { url, headingId: field },
    );
  }
  const span: PatchSpan = {
    file: position.file,
    line: position.startLine,
    column: position.startColumn,
    endLine: position.endLine,
    endColumn: position.endColumn,
  };
  let expected: string;
  try {
    expected = sliceBySpan(source, span);
  } catch (error) {
    if (!(error instanceof PatchError)) throw error;
    throw new EditPlanError(
      "edit.source-mismatch",
      `The field ${JSON.stringify(field)} of ${record.collection}.${record.id} points outside the data file given: ${error.message}`,
      { url, headingId: field, span },
    );
  }

  const patch: Patch = { span, expected, replacement: newText, beforeHash: hashSource(source) };
  const after = applyPatch(source, patch);
  const entry = site.config.collections[record.collection];
  if (entry === undefined || !/\.(ya?ml|json)$/i.test(position.file)) {
    // CSV has no nested parse to check; the span edit is all the format gives.
    return patch;
  }
  const document = parseDocument(after, { uniqueKeys: false });
  if (document.errors.length > 0) {
    throw new EditPlanError(
      "edit.unparseable",
      `The edit would make ${position.file} unparseable: ${document.errors[0]?.message.split("\n")[0] ?? "parse error"}.`,
      { url, headingId: field, span },
    );
  }
  const idField = entry.id ?? "id";
  const fields = fieldsOfDocument(document.toJS(), idField, record.id);
  if (fields === undefined) {
    throw new EditPlanError(
      "edit.invalid-record",
      `The edit would leave ${record.collection} without the record ${record.id}.`,
      { url, headingId: field, span },
    );
  }
  const schema = compileSchemas(root, site.config, {}, []).schemas[record.collection];
  if (schema !== undefined && !schema.validate(fields)) {
    const first = schema.validate.errors?.[0];
    throw new EditPlanError(
      "edit.invalid-record",
      `The edit would make ${record.collection}.${record.id} invalid${first === undefined ? "" : `: ${first.instancePath || "/"} ${first.message ?? ""}`}.`,
      { url, headingId: field, span },
    );
  }
  return patch;
}
