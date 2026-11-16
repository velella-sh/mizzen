/**
 * Builds a git ref for `mizzen diff --base <ref>`.
 *
 * The ref is checked out into a temporary detached worktree, built there, and compared with a build of the current
 * tree. The user's working tree and index are never touched: `git worktree add --detach` writes only under the
 * repository's own metadata folder, and both the worktree and that metadata are removed whether the build succeeds
 * or fails. Both sides use the build cache of the site being diffed, so an unchanged page is rendered once.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { build, type BuildResult } from "../pipeline/build.ts";
import { cacheRootOf } from "../pipeline/cache.ts";
import { DiffUsageError } from "./builds.ts";
import { diffBuilds } from "./index.ts";
import type { SiteDiff } from "./types.ts";

const run = promisify(execFile);

/** What {@link diffAgainstRef} needs: the site, the ref, and how to build. */
export interface RefOptions {
  readonly root: string;
  readonly ref: string;
  readonly themeRoot: string;
  readonly defaultLayout?: string;
  /** Called with a build's diagnostics count of errors, so the caller can say a side built with errors. */
  readonly onBuilt?: (side: "base" | "head", result: BuildResult) => void;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await run("git", ["-C", cwd, ...args], { maxBuffer: 16 * 1024 * 1024 });
    return stdout.trim();
  } catch (err) {
    const message = (err as { stderr?: string }).stderr?.trim() ?? (err as Error).message;
    throw new DiffUsageError(`git ${args[0] ?? ""} failed: ${message.split("\n")[0] ?? ""}`);
  }
}

/** Builds the ref and the current tree, compares them, and removes everything it made. */
export async function diffAgainstRef(options: RefOptions): Promise<SiteDiff> {
  const root = resolve(options.root);
  if (options.ref === "" || options.ref.startsWith("-")) throw new DiffUsageError(`"${options.ref}" is not a git ref.`);

  const top = await git(root, ["rev-parse", "--show-toplevel"]).catch(() => {
    throw new DiffUsageError("--base needs the site to be inside a git repository.");
  });
  const commit = await git(root, ["rev-parse", "--verify", "--quiet", `${options.ref}^{commit}`]).catch(() => {
    throw new DiffUsageError(`"${options.ref}" is not a commit of this repository.`);
  });
  // Resolve symlinks (macOS /var -> /private/var) the way git does before taking the path inside the repository.
  const inside = relative(await realpathOf(top), await realpathOf(root));
  if (inside.startsWith("..") || inside.split(sep).includes("..")) throw new DiffUsageError("the site is outside its repository.");

  const scratch = await mkdtemp(join(tmpdir(), "mizzen-diff-"));
  const worktree = join(scratch, "base-tree");
  let added = false;
  try {
    await git(top, ["worktree", "add", "--detach", "--quiet", worktree, commit]);
    added = true;
    const cacheDir = cacheRootOf(root);
    const common = {
      themeRoot: options.themeRoot,
      cache: true,
      cacheDir,
      ...(options.defaultLayout === undefined ? {} : { defaultLayout: options.defaultLayout }),
    };
    const baseOut = join(scratch, "base");
    const headOut = join(scratch, "head");
    const baseBuild = await build({ ...common, root: join(worktree, inside), out: baseOut });
    options.onBuilt?.("base", baseBuild);
    const headBuild = await build({ ...common, root, out: headOut });
    options.onBuilt?.("head", headBuild);
    return await diffBuilds(baseOut, headOut);
  } finally {
    if (added) {
      await git(top, ["worktree", "remove", "--force", worktree]).catch(() => undefined);
      await git(top, ["worktree", "prune"]).catch(() => undefined);
    }
    await rm(scratch, { recursive: true, force: true });
  }
}

async function realpathOf(path: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  return realpath(path);
}
