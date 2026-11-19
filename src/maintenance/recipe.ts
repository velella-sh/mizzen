/**
 * Turn a proved proposal into a reviewable pull-request recipe (#1238-#1239).
 *
 * The recipe is a plan, not an action: it names a branch, a title, a body with the diff, evidence,
 * and impact, the authorized files, and permissions that include neither publish nor merge. A later
 * run of the same task uses the same branch and updates the open pull request instead of opening a
 * second one; labels are unioned, never repeated.
 */
import type { TaskDocument } from "../contracts/task.ts";
import type {
  MaintenanceOpenPullRequest,
  MaintenancePreview,
  MaintenancePullRequestPlan,
  MaintenanceRecipe,
  MaintenanceVerification,
} from "../contracts/index.ts";
import { canonicalJson, sha256 } from "../data/lock.ts";

/** What a recipe may override. */
export interface RecipeOptions {
  /** The branch the pull request targets. Default `main`. */
  readonly base?: string;
  /** The branch to push. Default `mizzen/maintenance/<first 12 characters of the task id>`. */
  readonly branch?: string;
  readonly labels?: readonly string[];
  /** Published outputs the proposal affects. */
  readonly outputs?: readonly string[];
}

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The one branch per task, so a later run updates the same proposal. */
export function maintenanceBranch(taskId: string): string {
  return `mizzen/maintenance/${taskId.slice(0, 12)}`;
}

/** A title that fits a pull request without depending on locale. */
function titleOf(goal: string): string {
  const title = `[maintenance] ${goal.trim()}`;
  return title.length <= 72 ? title : `${title.slice(0, 71)}…`;
}

/** The authorized files: changed, inside the verification scope, and sorted. */
function authorizedFiles(task: TaskDocument, verification: MaintenanceVerification, preview: MaintenancePreview): string[] {
  const allowed = new Set([...task.scope.files, ...task.scope.pages]);
  return preview.files
    .filter((file) => file.changed && allowed.has(file.path))
    .map((file) => file.path)
    .sort(byCodePoint);
}

/** The Markdown body: summary, files, diff, evidence, impact, and the unavailable actions. */
function bodyOf(
  task: TaskDocument,
  verification: MaintenanceVerification,
  preview: MaintenancePreview,
  files: readonly string[],
  outputs: readonly string[],
): string {
  const lines = [
    "<!-- mizzen-maintenance -->",
    `### Maintenance: ${task.goal}`,
    "",
    `- Task: \`${task.id}\``,
    `- Snapshot: \`${verification.snapshot}\``,
    `- Verdict: \`${verification.verdict}\``,
    "",
    "#### Authorized files",
    "",
  ];
  if (files.length === 0) lines.push("No file changes.");
  for (const file of files) lines.push(`- \`${file}\``);
  lines.push("", "#### Diff", "");
  for (const file of preview.files.filter((entry) => entry.changed && files.includes(entry.path))) {
    lines.push("```diff", file.diff.replace(/\n$/, ""), "```", "");
  }
  lines.push("#### Evidence", "");
  for (const claim of verification.claims) {
    const checks = claim.evidence.filter((entry) => entry.kind === "check").map((entry) => (entry.kind === "check" ? entry.id : ""));
    const filesCited = claim.evidence.filter((entry) => entry.kind === "file" || entry.kind === "span").map((entry) => (entry.kind === "file" || entry.kind === "span" ? entry.path : ""));
    lines.push(`- \`${claim.criterion}\`: ${claim.status}${checks.length === 0 ? "" : `; checks: ${checks.join(", ")}`}${filesCited.length === 0 ? "" : `; files: ${filesCited.join(", ")}`}`);
  }
  if (verification.claims.length === 0) lines.push("- No claim was recorded.");
  lines.push("", "#### Impact", "");
  if (outputs.length === 0) lines.push("No published output is affected.");
  for (const output of outputs) lines.push(`- \`${output}\``);
  lines.push(
    "",
    "#### Limits",
    "",
    "This recipe has no publish or merge permission. A person reviews the diff and merges it; no run merges automatically.",
    "",
  );
  return lines.join("\n");
}

/**
 * Builds the recipe. A proposal that is not proved, or whose preview changes no authorized file, is
 * a no-op recipe: it still explains the verdict, but no branch or pull request is proposed.
 */
export function maintenanceRecipe(
  task: TaskDocument,
  verification: MaintenanceVerification,
  preview: MaintenancePreview,
  options: RecipeOptions = {},
): MaintenanceRecipe {
  const files = authorizedFiles(task, verification, preview);
  const outputs = [...(options.outputs ?? preview.outputs)].sort(byCodePoint);
  const branch = options.branch ?? maintenanceBranch(task.id);
  const base = options.base ?? "main";
  const labels = [...new Set(["maintenance", ...(options.labels ?? [])])].sort(byCodePoint);
  const noop = !verification.ready || !verification.scope.ok || files.length === 0;
  const body = bodyOf(task, verification, preview, files, outputs);
  const title = titleOf(task.goal);
  return {
    version: 1,
    id: sha256(`mizzen-maintenance-recipe\0${canonicalJson({ branch, snapshot: verification.snapshot, files, body })}`),
    proposal: verification.proposal,
    snapshot: verification.snapshot,
    branch,
    base,
    title,
    body,
    commitMessage: `maintenance: ${task.goal.trim()}`,
    files,
    labels,
    outputs,
    checks: [...new Set(verification.checks.map((check) => check.id))].sort(byCodePoint),
    permissions: { contents: "write", pullRequests: "write", publish: false, merge: false },
    noop,
  };
}

/**
 * Chooses create, update, or none. The branch is per task, so a later snapshot updates the same
 * open pull request; labels are the union of what the pull request already has and what this recipe
 * asks for, without repeats. A no-op never opens or updates anything.
 */
export function planMaintenancePullRequest(
  recipe: MaintenanceRecipe,
  open: readonly MaintenanceOpenPullRequest[] = [],
): MaintenancePullRequestPlan {
  if (recipe.noop) {
    return {
      action: "none",
      branch: recipe.branch,
      title: recipe.title,
      body: recipe.body,
      labels: recipe.labels,
      files: recipe.files,
      noop: true,
    };
  }
  const existing = open
    .filter((pull) => pull.branch === recipe.branch)
    .sort((a, b) => a.number - b.number)[0];
  if (existing === undefined) {
    return {
      action: "create",
      branch: recipe.branch,
      title: recipe.title,
      body: recipe.body,
      labels: recipe.labels,
      files: recipe.files,
      noop: false,
    };
  }
  return {
    action: "update",
    branch: recipe.branch,
    number: existing.number,
    title: recipe.title,
    body: recipe.body,
    labels: [...new Set([...existing.labels, ...recipe.labels])].sort(byCodePoint),
    files: recipe.files,
    noop: false,
  };
}
