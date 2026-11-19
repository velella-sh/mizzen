/**
 * Write checks: a policy path allowlist AND a semantic scope, checked against the resolved file system target.
 *
 * A lexical check alone cannot stop `docs/../../etc/passwd`, a symbolic link that points outside the site, or a
 * transaction that stages one file and renames it onto another. {@link checkWriteTarget} therefore resolves the site
 * root and the nearest existing parent, refuses a target that leaves the root through a symlink, and refuses a
 * target that is itself a symbolic link. The policy decision runs on the site-relative path, so a caller cannot
 * satisfy the allowlist with an absolute path and then write elsewhere.
 */
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  AccessDecision,
  AccessGrant,
  AccessPolicy,
  AccessWriteScope,
} from "../contracts/permissions.ts";
import { decideAccess } from "./evaluate.ts";
import { sitePathProblem } from "./match.ts";

/** A resolved write target inside the site root. */
export interface ResolvedWriteTarget {
  /** The site root, with symlinks resolved. */
  readonly root: string;
  /** The absolute target path, lexically inside {@link root}. */
  readonly target: string;
  /** The site-relative path with forward slashes, as the policy saw it. */
  readonly path: string;
}

/** The outcome of {@link resolveWriteTarget}: a target, or one sentence that never repeats a private path. */
export interface WriteResolution {
  readonly target?: ResolvedWriteTarget;
  readonly reason?: string;
}

/** True when `child` is the root or below it. */
function inside(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Resolves a site-relative write path without following a final symbolic link.
 *
 * The lexical checks run first: absolute paths, drive letters, backslashes, `.`/`..` segments, and NUL bytes are
 * refused before the file system is read. The nearest existing ancestor is resolved, so a symlinked folder either
 * stays inside the root or refuses the write. A target that exists and is a link is always refused.
 */
export async function resolveWriteTarget(siteRoot: string, path: string): Promise<WriteResolution> {
  const problem = sitePathProblem(path);
  if (problem !== undefined) return { reason: `The write path is refused because ${problem}.` };
  const normalized = path.split("/").filter((segment) => segment !== "").join("/");

  let root: string;
  try {
    root = await realpath(siteRoot);
  } catch {
    root = resolve(siteRoot);
  }
  const lexical = resolve(root, normalized);
  if (!inside(root, lexical)) return { reason: "The write path leaves the site root." };

  let existing = lexical;
  const missing: string[] = [];
  for (;;) {
    try {
      const info = await lstat(existing);
      if (info.isSymbolicLink()) {
        return { reason: "The write target is a symbolic link; a policy write never follows one." };
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return { reason: "The write target cannot be inspected." };
      }
      const parent = dirname(existing);
      if (parent === existing) break;
      missing.unshift(relative(parent, existing));
      existing = parent;
    }
  }

  let resolvedExisting: string;
  try {
    resolvedExisting = await realpath(existing);
  } catch {
    return { reason: "The write target's parent cannot be resolved." };
  }
  if (!inside(root, resolvedExisting)) return { reason: "The write path leaves the site root through a symbolic link." };
  const target = missing.length === 0 ? resolvedExisting : join(resolvedExisting, ...missing);
  if (!inside(root, target)) return { reason: "The write path leaves the site root through a symbolic link." };

  return { target: { root, target, path: normalized } };
}

/** What {@link checkWriteTarget} needs. */
export interface WriteTargetRequest {
  readonly policy: AccessPolicy;
  readonly siteRoot: string;
  readonly path: string;
  readonly scope: AccessWriteScope;
  readonly task: string;
  readonly snapshot: string;
  readonly approvals?: readonly AccessGrant[];
}

/** The policy decision plus the resolved target, or a denial with the rule that refused it. */
export interface WriteTargetDecision {
  readonly decision: AccessDecision;
  readonly target?: ResolvedWriteTarget;
}

/**
 * Checks one write: the policy must allow the path and the scope, and the resolved target must stay inside the site
 * and not be (or pass through) a symbolic link out of it. Both checks are required; neither substitutes for the other.
 */
export async function checkWriteTarget(request: WriteTargetRequest): Promise<WriteTargetDecision> {
  const decision = decideAccess(request.policy, {
    capability: "write",
    task: request.task,
    snapshot: request.snapshot,
    path: request.path,
    scope: request.scope,
    ...(request.approvals === undefined ? {} : { approvals: request.approvals }),
  });
  if (!decision.allowed) return { decision };
  const resolved = await resolveWriteTarget(request.siteRoot, request.path);
  if (resolved.target === undefined) {
    return {
      decision: {
        allowed: false,
        capability: "write",
        rule: "write.symlink",
        reason: resolved.reason ?? "The write target is refused.",
      },
    };
  }
  return { decision, target: resolved.target };
}

/**
 * Checks the paths of a transaction's artifacts. Every site-relative artifact is held to the same policy; a derived
 * record outside the site (a proof beside a patch) is not a site write and is left to the transaction's own identity
 * and duplicate checks, but it still may not point back into the site at a path the policy did not allow.
 */
export async function checkTransactionArtifacts(
  request: WriteTargetRequest,
  artifacts: readonly { readonly path: string; readonly label?: string }[],
): Promise<AccessDecision> {
  for (const artifact of artifacts) {
    const label = (artifact.label ?? artifact.path).replace(/\\/g, "/");
    if (isAbsolute(label) || label.startsWith("../")) continue;
    const checked = await checkWriteTarget({ ...request, path: label });
    if (!checked.decision.allowed) return checked.decision;
  }
  return {
    allowed: true,
    capability: "write",
    rule: "write.transaction",
    reason: "Every site artifact in the transaction is allowed by the policy.",
  };
}

/** The scope an edit to one page names: its source file, and the page itself when a caller supplies it. */
export function scopeOfFile(path: string, page?: string): AccessWriteScope {
  return {
    pages: page === undefined ? [] : [page],
    blocks: [],
    collections: [],
    files: [path],
  };
}
