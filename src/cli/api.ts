/**
 * `mizzen api check [dir] --against <folder|ref>`: fail when the data API of the site would break a consumer of an
 * older one. `--against` is a built folder (a deployed copy, or the last release's build) or a git ref, which is
 * built in a temporary worktree. The site's current tree is built into a temporary folder, so nothing is written.
 */
import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compareApi, type ApiBreak } from "../api/compat.ts";
import { build } from "../pipeline/build.ts";
import { withBuiltRef } from "../diff/ref.ts";

export interface ApiCheckCommand {
  readonly root: string;
  readonly against: string;
  readonly themeRoot: string;
  readonly defaultLayout?: string;
}

export interface ApiIo {
  readonly write: (text: string) => void;
  readonly error: (message: string) => void;
}

/** What the command prints: one block per break, or a line saying the API is compatible. */
export function formatBreaks(breaks: readonly ApiBreak[]): string {
  if (breaks.length === 0) return "api: compatible with the baseline.\n";
  const lines = breaks.map((b) =>
    [`${b.file}${b.field === undefined ? "" : ` (field ${b.field})`}: ${b.message}`, `  fix: ${b.fix}`].join("\n"),
  );
  return `${lines.join("\n")}\napi: ${breaks.length} breaking change${breaks.length === 1 ? "" : "s"}.\n`;
}

/** Builds the current tree, compares it with the baseline, and returns the exit code: 0 compatible, 1 breaks, 2 usage. */
export async function apiCheck(command: ApiCheckCommand, io: ApiIo): Promise<number> {
  const root = resolve(command.root);
  const scratch = await mkdtemp(join(tmpdir(), "mizzen-api-"));
  try {
    const common = {
      themeRoot: command.themeRoot,
      ...(command.defaultLayout === undefined ? {} : { defaultLayout: command.defaultLayout }),
    };
    const headOut = join(scratch, "head");
    const head = await build({ ...common, root, out: headOut });
    const errors = head.diagnostics.filter((d) => d.severity === "error").length;
    if (errors > 0) io.error(`mizzen: the current build has ${errors} error${errors === 1 ? "" : "s"}; comparing what it wrote.`);
    const against = resolve(command.against);
    const breaks =
      existsSync(against) && statSync(against).isDirectory()
        ? await compareApi(against, headOut)
        : await withBuiltRef({ root, ref: command.against, ...common }, (baseOut) => compareApi(baseOut, headOut));
    io.write(formatBreaks(breaks));
    return breaks.length === 0 ? 0 : 1;
  } catch (err) {
    io.error(`mizzen: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
