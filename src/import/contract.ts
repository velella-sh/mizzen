import type { Diagnostic } from "../contracts/index.ts";

/** How the migration uses an input file. */
export type ImportFileKind = "content" | "config" | "asset" | "unsupported";

/** How faithfully a block of an input file was migrated. */
export type ImportAccuracy = "full" | "approximate" | "manual";

/** One input file and the importer's decision about it. */
export interface ImportFile {
  /** Path relative to the source root, using `/` on every platform. */
  readonly path: string;
  readonly kind: ImportFileKind;
  /** Why the file has no destination; required for `unsupported`, optional for content held back. */
  readonly reason?: string;
}

/** A source project as an importer reads it. */
export interface ImportSource {
  /** Absolute path of the source folder. */
  readonly root: string;
  /** Every regular file under the root, relative, `/`-separated, in code-point order. */
  readonly files: readonly string[];
  /** Reads one file as UTF-8. */
  read(path: string): string;
  /** Reads one file as bytes, for an asset that must be copied unchanged. */
  bytes(path: string): Uint8Array;
}

/** One block of an input file and how far the conversion carried it. */
export interface ImportBlock {
  /** 1-based line in the input file. */
  readonly line: number;
  readonly status: ImportAccuracy;
  /** What a person still has to do, or what changed approximately. */
  readonly note?: string;
}

/** One converted page: the complete text of its destination file. */
export interface ImportedPage {
  /** Path relative to the source root. */
  readonly source: string;
  /** Destination path relative to the generated project, ending in `.md`. */
  readonly destination: string;
  /** The destination file's text, front matter included. */
  readonly contents: string;
  /** The page's blocks, when the importer needs to report more than the whole page. */
  readonly blocks?: readonly ImportBlock[];
}

/** One input file copied to the generated project unchanged. */
export interface ImportedAsset {
  readonly source: string;
  readonly destination: string;
}

/** The generated site config. */
export interface ImportedConfig {
  /** The input file it came from, when it was converted rather than generated. */
  readonly source?: string;
  readonly contents: string;
}

/** Everything one importer returns for one source project. */
export interface ImportOutcome {
  /** Every input file the importer read, with its kind. */
  readonly files: readonly ImportFile[];
  readonly pages: readonly ImportedPage[];
  readonly assets: readonly ImportedAsset[];
  readonly config: ImportedConfig;
  readonly diagnostics: readonly Diagnostic[];
}

/** The contract every importer implements. */
export interface Importer {
  /** The name `mizzen import <name>` selects. */
  readonly name: string;
  /** One line that describes the source it reads. */
  readonly description: string;
  /**
   * Reads the source project and returns every file it classified plus the converted content. The shared command
   * completes missing files, builds the mapping, rewrites links, and reports accuracy, so an importer only converts.
   */
  import(source: ImportSource): ImportOutcome | Promise<ImportOutcome>;
}
