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
  /** The exit code the run reported; absent when the language was not run. */
  readonly exitCode?: number | null;
  /** SHA-256 of the execution environment the run used, from `.mizzen-env.json`; absent for a skipped block. */
  readonly environment?: string;
  /** The evidence for this run: its outputs, its span, and any snippet it read. */
  readonly evidence?: ExampleEvidence;
}

/** One expected-vs-actual comparison the evidence keeps. */
export interface ExampleEvidenceOutput {
  /** `stdout` or `stderr`. */
  readonly stream: "stdout" | "stderr";
  /** How the two were compared. */
  readonly match: "exact" | "pattern";
  /** The expected text, normalized; absent when the block checked only the exit code. */
  readonly expected?: string;
  /** The produced text, normalized. */
  readonly actual: string;
  /** True when the two agree. */
  readonly ok: boolean;
}

/** Where a block's code came from, when it was not written inline. */
export interface ExampleEvidenceSnippet {
  /** The file, relative to the source folder. */
  readonly file: string;
  /** 1-based first line the block holds. */
  readonly start: number;
  /** 1-based last line the block holds, inclusive. */
  readonly end: number;
  /** The language the extension gave it. */
  readonly language: string;
}

/** The portable evidence one run keeps: no temporary paths, no durations, no clocks. */
export interface ExampleEvidence {
  /** The exit code, or `null` when the block timed out, was refused, or did not start. */
  readonly exitCode: number | null;
  /** The limit that stopped the block, when one did. */
  readonly violation?: string;
  /** Each expected output compared, in `stdout` then `stderr` order. */
  readonly outputs: readonly ExampleEvidenceOutput[];
  /** The snippet read, when the block imported one. */
  readonly snippet?: ExampleEvidenceSnippet;
  /** True when the host confined writes; absent when the block is not run. */
  readonly sandboxed?: boolean;
  /** The block's session, when it shared one. */
  readonly session?: string;
}

/** A recorded result, or evidence from an earlier version of this fence. */
export type FenceExampleResult = RecordedExampleResult
  | (Omit<RecordedExampleResult, "status"> & {
      readonly status: "stale";
      readonly recordedStatus: ExampleRunStatus;
    });
