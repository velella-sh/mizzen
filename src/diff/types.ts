/** The shape of a site diff report: `schema/site-diff.schema.json` is the contract, these are its types. */

/** Which kind of change one block of a page had. */
export type BlockKind =
  | "added"
  | "removed"
  | "edited"
  | "moved"
  | "moved-edited"
  | "heading"
  | "code"
  | "code-language"
  | "table"
  | "link"
  | "image"
  | "record"
  | "uncertain";

/** A 1-based, inclusive range of lines in one file. */
export interface LineRange {
  readonly start: number;
  readonly end: number;
}

/** Where one side of a change sits: the source file and its line range. */
export interface SourceSpan {
  readonly path: string;
  readonly range: LineRange;
}

/** A changed block of a changed page. */
export interface Block {
  /** The heading text, or `null` before the first heading. */
  readonly heading: string | null;
  readonly id: string | null;
  readonly kind: BlockKind;
  /** Lines in the head twin, or in the base twin for a removed section. Kept for readers of version 1. */
  readonly range?: LineRange;
  /** The block's source span in the base build, when it has one there. */
  readonly before?: SourceSpan;
  /** The block's source span in the head build, when it has one there. */
  readonly after?: SourceSpan;
  /** The first changed cell of a table change: 1-based row and column. */
  readonly cell?: { readonly row: number; readonly column: number };
  /** The destination of a link or image change, on each side. */
  readonly destination?: { readonly before: string; readonly after: string };
  /** The heading text on each side of a heading change. */
  readonly text?: { readonly before: string; readonly after: string };
  /** The fence language on each side of a code-language change. */
  readonly language?: { readonly before: string; readonly after: string };
  /** The record field a `record` change came from. */
  readonly field?: string;
  /** The value a record produced, before and after. */
  readonly value?: { readonly before: string; readonly after: string };
}

export interface PageRef {
  readonly url: string;
  readonly source: string;
  readonly title: string;
}

/** The manifest fields that can differ for one page, in report order. */
export type PageChange = "source" | "title" | "layout" | "text" | "html";

export interface ChangedPage extends PageRef {
  readonly changes: readonly PageChange[];
  readonly renderOnly: boolean;
  readonly blocks: readonly Block[];
}

export interface MovedPage {
  readonly from: string;
  readonly to: string;
  readonly source: string;
  readonly by: "source" | "record";
  readonly redirect: boolean;
  readonly changed: boolean;
}

export interface FileRef {
  readonly name: string;
  readonly group: string;
  readonly size?: number;
}

export interface ChangedFile {
  readonly name: string;
  readonly group: string;
  readonly path: string;
  readonly size?: { readonly before: number; readonly after: number };
}

export interface FieldChange {
  readonly name: string;
  readonly before?: unknown;
  readonly after?: unknown;
}

export interface RecordRef {
  readonly id: string;
  readonly url: string;
  readonly lists?: readonly string[];
}

export interface ChangedRecord {
  readonly id: string;
  readonly url: string;
  readonly fields: readonly FieldChange[];
  readonly lists: readonly string[];
}

export interface CollectionDiff {
  readonly collection: string;
  readonly added: readonly RecordRef[];
  readonly removed: readonly RecordRef[];
  readonly changed: readonly ChangedRecord[];
}

/** The report `mizzen diff` prints as JSON. */
export interface SiteDiff {
  /** The report schema, for a tool that reads several versions. */
  readonly schemaVersion: 1;
  readonly version: 1;
  readonly base: { readonly hash: string };
  readonly head: { readonly hash: string };
  readonly identical: boolean;
  readonly summary: {
    readonly pages: { readonly added: number; readonly removed: number; readonly changed: number; readonly moved: number };
    readonly files: { readonly added: number; readonly removed: number; readonly changed: number };
    readonly records: { readonly added: number; readonly removed: number; readonly changed: number };
    readonly brokenUrls: number;
    readonly renderOnly: number;
  };
  readonly pages: {
    readonly added: readonly PageRef[];
    readonly removed: readonly PageRef[];
    readonly changed: readonly ChangedPage[];
    readonly moved: readonly MovedPage[];
  };
  readonly brokenUrls: readonly string[];
  readonly files: {
    readonly added: readonly FileRef[];
    readonly removed: readonly FileRef[];
    readonly changed: readonly ChangedFile[];
  };
  readonly records: readonly CollectionDiff[];
  /** History entries `mizzen data changes --write` would append. Present only when some are pending. */
  readonly changes?: readonly PendingChanges[];
}

/** One history event a pull request would add, as `mizzen data changes` would write it. */
export interface PendingEvent {
  readonly type: "added" | "removed" | "changed" | "renamed" | "imported";
  readonly record: string;
  readonly field?: string;
  readonly summary: string;
  /** The snapshot date the event would carry. */
  readonly date: string;
}

/** The history entries that are pending for one collection. */
export interface PendingChanges {
  readonly collection: string;
  readonly events: readonly PendingEvent[];
}
