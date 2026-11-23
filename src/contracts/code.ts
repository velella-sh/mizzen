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

/** What happened in a recorded run of a fence marked `test`. */
export type ExampleRunStatus = "passed" | "failed" | "skipped" | "sandbox-unavailable";

/** One result from the recorded run. File and line refer to the source at that commit. */
export interface RecordedExampleResult {
  readonly status: ExampleRunStatus;
  readonly file: string;
  readonly line: number;
  readonly language: string;
  /** The UTC run date, as YYYY-MM-DD. */
  readonly date: string;
  /** The full Git commit ID supplied by the recorder. */
  readonly commit: string;
  /** SHA-256 of the JSON array [language, code, expected output or null]. */
  readonly sha256: string;
}

/** A recorded result, or evidence from an earlier version of this fence. */
export type FenceExampleResult = RecordedExampleResult
  | (Omit<RecordedExampleResult, "status"> & {
      readonly status: "stale";
      readonly recordedStatus: ExampleRunStatus;
    });
