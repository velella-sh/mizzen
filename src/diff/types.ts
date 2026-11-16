/** The shape of a site diff report: `schema/site-diff.schema.json` is the contract, these are its types. */

/** Which kind of change one section of a page had. */
export type BlockKind = "added" | "removed" | "edited" | "moved";

/** A changed section of a changed page. */
export interface Block {
  /** The heading text, or `null` for the text before the first heading. */
  readonly heading: string | null;
  readonly id: string | null;
  readonly kind: BlockKind;
  /** Lines in the head twin, or in the base twin for a removed section. */
  readonly range?: { readonly start: number; readonly end: number };
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
}
