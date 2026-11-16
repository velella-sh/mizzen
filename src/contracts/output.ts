import type { Diagnostic } from "./diagnostic.ts";
import type { Page, Site } from "./content.ts";

/** One file an output writes. */
export interface OutputFile {
  /** Path relative to the output folder, using `/`. */
  readonly path: string;
  /** The file's bytes: text is UTF-8 with LF line endings. */
  readonly contents: string | Uint8Array;
}

/** What a build tells an output about itself, for an output that reads files or does work of its own. */
export interface OutputBuild {
  /** Absolute path of the site root: the folder that holds `mizzen.yml`. */
  readonly root: string;
  /** Worker threads the build may use, as `--workers` set them; `1` means work in this process. */
  readonly workers: number;
  /** Absolute folder an output may keep reusable results in, or absent when the build does not cache. */
  readonly cacheDir?: string;
}

/** What the engine hands an output besides the site model. */
export interface OutputContext {
  /** Renders a page to a complete HTML document through the theme. */
  renderPage(page: Page): Promise<string>;
  /** The build's own facts; absent where an output is run without a build, as in a unit test. */
  readonly build?: OutputBuild;
  /** Reports a diagnostic; an output never throws for a problem in the content. */
  report(diagnostic: Diagnostic): void;
}

/** A unit that turns the site model into files (`packages/engine/src/outputs/<name>.ts` exports one). */
export interface Output {
  /** The output's name, equal to its file name; the config's `outputs` map switches it off by this name. */
  readonly name: string;
  /** Produces the files, in a deterministic order. */
  run(site: Site, ctx: OutputContext): Promise<readonly OutputFile[]>;
}
