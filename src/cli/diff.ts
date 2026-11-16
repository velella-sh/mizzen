/**
 * `mizzen diff <a> <b>` and `mizzen diff --base <ref> [dir]`: compare two builds and print what changed.
 *
 * The command exits 0 whenever it ran, whatever it found. `--fail-on` names the kinds of finding that make it exit 1
 * instead (see {@link FAIL_KINDS}); there is no default failure on any difference. A usage problem, such as a folder
 * without a manifest, exits 2.
 */
import { resolve } from "node:path";
import { DiffUsageError, diffBuilds } from "../diff/index.ts";
import { DEFAULT_MAX_ENTRIES, formatDiff, type DiffFormat } from "../diff/format.ts";
import { diffAgainstRef } from "../diff/ref.ts";
import type { SiteDiff } from "../diff/types.ts";

/**
 * What `--fail-on` can name, each a finding of the report:
 * - `removed-pages`: a page of the first build has no page in the second and did not move.
 * - `broken-urls`: an old URL that the second build no longer answers (a removed page, or a move without a redirect).
 * - `render-only`: a page whose rendered HTML changed while its Markdown did not.
 */
export const FAIL_KINDS = ["removed-pages", "broken-urls", "render-only"] as const;
export type FailKind = (typeof FAIL_KINDS)[number];

export interface DiffCommand {
  /** Two built folders, or the single site folder when `base` is a git ref. */
  readonly dirs: readonly string[];
  readonly base?: string;
  readonly format: DiffFormat;
  readonly failOn: readonly FailKind[];
  readonly maxEntries?: number;
  readonly linkBase?: string;
  readonly themeRoot?: string;
  readonly defaultLayout?: string;
}

export interface DiffIo {
  readonly write: (text: string) => void;
  readonly error: (message: string) => void;
}

/** The kinds in `--fail-on` that the report contains. */
export function failedKinds(diff: SiteDiff, failOn: readonly FailKind[]): FailKind[] {
  const hit: Record<FailKind, boolean> = {
    "removed-pages": diff.pages.removed.length > 0,
    "broken-urls": diff.brokenUrls.length > 0,
    "render-only": diff.summary.renderOnly > 0,
  };
  return FAIL_KINDS.filter((kind) => failOn.includes(kind) && hit[kind]);
}

/** Parses `removed-pages,broken-urls`; returns an error message for an unknown kind. */
export function parseFailOn(raw: string): FailKind[] | string {
  const kinds: FailKind[] = [];
  for (const part of raw.split(",")) {
    const name = part.trim();
    if (!(FAIL_KINDS as readonly string[]).includes(name)) {
      return `--fail-on names removed-pages, broken-urls, or render-only, not "${name}"`;
    }
    if (!kinds.includes(name as FailKind)) kinds.push(name as FailKind);
  }
  return kinds;
}

/** Runs the diff and returns the exit code. */
export async function diffCommand(command: DiffCommand, io: DiffIo): Promise<number> {
  try {
    let diff: SiteDiff;
    if (command.base !== undefined) {
      if (command.themeRoot === undefined) throw new DiffUsageError("--base builds both sides and needs a theme: pass --theme <dir>.");
      diff = await diffAgainstRef({
        root: resolve(command.dirs[0] ?? "."),
        ref: command.base,
        themeRoot: command.themeRoot,
        ...(command.defaultLayout === undefined ? {} : { defaultLayout: command.defaultLayout }),
        onBuilt: (side, result) => {
          const errors = result.diagnostics.filter((d) => d.severity === "error").length;
          if (errors > 0) io.error(`mizzen: the ${side} build has ${errors} error${errors === 1 ? "" : "s"}; comparing what it wrote.`);
        },
      });
    } else {
      const [a, b] = command.dirs;
      if (a === undefined || b === undefined) throw new DiffUsageError("diff needs two built folders: mizzen diff <a> <b>");
      diff = await diffBuilds(a, b);
    }
    io.write(
      formatDiff(diff, command.format, {
        maxEntries: command.maxEntries ?? DEFAULT_MAX_ENTRIES,
        ...(command.linkBase === undefined ? {} : { linkBase: command.linkBase }),
      }),
    );
    const failed = failedKinds(diff, command.failOn);
    if (failed.length > 0) {
      io.error(`mizzen: diff failed on ${failed.join(", ")}.`);
      return 1;
    }
    return 0;
  } catch (err) {
    io.error(`mizzen: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
}
