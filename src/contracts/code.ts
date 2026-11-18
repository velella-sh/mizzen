/** Inclusive run of 1-based line numbers inside a code block: `3-5` is `{ from: 3, to: 5 }`. */
export interface CodeLineRange {
  readonly from: number;
  readonly to: number;
}

/** One note attached to an inclusive run of 1-based lines in a code block. */
export interface CodeAnnotation {
  readonly from: number;
  readonly to: number;
  /** The note after the colon, with `\|` and `\\` decoded. */
  readonly text: string;
}

/** Structured fence meta a code component reads from `data.code`. Nothing here is highlighted. */
export interface CodeMeta {
  /** The fence's meta string, verbatim. */
  readonly raw: string;
  /** `title="..."`, or `null` when absent or empty. */
  readonly title: string | null;
  /** Lines in bare braces, `{1,3-5}`. */
  readonly highlight: readonly CodeLineRange[];
  /** Lines in `ins={...}`: inserted in a diff. */
  readonly ins: readonly CodeLineRange[];
  /** Lines in `del={...}`: deleted in a diff. */
  readonly del: readonly CodeLineRange[];
  /** A bare `diff` flag: the fence is a diff. */
  readonly diff: boolean;
  /** `showLineNumbers` turns numbering on; `showLineNumbers=false` turns it off. */
  readonly showLineNumbers: boolean;
  /** `annotations={…}`: notes on 1-based lines, in line order. */
  readonly annotations: readonly CodeAnnotation[];
}
