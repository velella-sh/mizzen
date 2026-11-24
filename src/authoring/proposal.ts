/**
 * Prepare a reviewable pull-request proposal only after verification proved the draft (#1415).
 *
 * The proposal is data: a branch, a title, a body with the page, citations, checks, remaining unknowns, and the diff,
 * the authorized files with their hashes, and permissions that include neither publish nor merge. A proposal whose
 * verification is not proved is a no-op and names the failures, so no branch is opened for unfinished work.
 */
import type { AuthoringProposal, AuthoringTask, AuthoringVerification } from "../contracts/authoring.ts";
import type { AuthoringPreview } from "../contracts/authoring.ts";
import { canonicalJson, sha256 } from "../data/lock.ts";
import { renderDraftSource } from "./draft.ts";
import type { AuthoringDraft } from "../contracts/authoring.ts";

/** What a proposal may override. */
export interface AuthoringProposalOptions {
  /** The branch the pull request targets. Default `main`. */
  readonly base?: string;
  /** The branch to push. Default `mizzen/authoring/<item name>`. */
  readonly branch?: string;
  readonly labels?: readonly string[];
}

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A title that fits a pull request without depending on locale. */
function titleOf(task: AuthoringTask): string {
  const title = `docs: document ${task.item}`;
  return title.length <= 72 ? title : `${title.slice(0, 71)}…`;
}

/** The default branch for one item. */
export function authoringBranch(item: string): string {
  const name = item.replace(/^[a-z-]+:/u, "").replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return `mizzen/authoring/${name === "" ? "page" : name.slice(0, 48)}`;
}

/** The Markdown body a reviewer reads. */
function bodyOf(
  task: AuthoringTask,
  verification: AuthoringVerification,
  draft: AuthoringDraft,
  preview: AuthoringPreview,
  files: readonly string[],
): string {
  const lines = [
    "<!-- mizzen-authoring -->",
    `### Authoring: ${task.item}`,
    "",
    `- Item: \`${task.item}\``,
    `- Task: \`${task.task.id}\``,
    `- Snapshot: \`${task.task.snapshot.id}\``,
    `- Page type: \`${task.pageType.kind}\` (${task.pageType.reason})`,
    `- Verdict: \`${verification.verdict}\``,
    "",
    "#### Proposed page",
    "",
    `- URL: \`${task.location.url}\``,
    `- Source: \`${task.location.source}\``,
    `- Block: \`${task.location.block}\``,
    `- Navigation: \`${task.location.nav.list}\`${task.location.nav.parent === undefined ? "" : ` / \`${task.location.nav.parent}\``}, titled \`${task.location.nav.title}\``,
    "",
    "#### Citations",
    "",
  ];
  if (verification.proof === undefined) lines.push("- No proof was written.");
  else {
    for (const citation of verification.proof.citations) {
      lines.push(`- \`[[${citation.kind}:${citation.ref}]]\` at line ${citation.line}: ${citation.claim}`);
    }
    lines.push("", `Proof: \`${verification.proof.hash}\``);
  }
  lines.push("", "#### Checks", "", "| Check | Kind | Status | Detail |", "| --- | --- | --- | --- |");
  for (const entry of verification.checks) {
    lines.push(`| \`${entry.id}\` | ${entry.kind} | ${entry.status} | ${entry.detail ?? ""} |`);
  }
  lines.push("", "#### Explicit unknowns", "");
  if (verification.remainingUnknowns.length === 0) lines.push("- None.");
  for (const unknown of verification.remainingUnknowns) {
    lines.push(`- \`${unknown.id}\`: ${unknown.statement}${unknown.evidence === undefined ? "" : ` Evidence: ${unknown.evidence}`}`);
  }
  lines.push("", "#### Reviewer questions", "");
  if (verification.remainingQuestions.length === 0) lines.push("- None.");
  for (const question of verification.remainingQuestions) {
    lines.push(`- \`${question.id}\`: ${question.question}`);
  }
  lines.push("", "#### Files", "");
  for (const file of files) lines.push(`- \`${file}\``);
  lines.push("", "#### Diff", "", "```diff", preview.diff.replace(/\n$/u, ""), "```", "");
  lines.push(
    "#### Limits",
    "",
    "This proposal has no publish or merge permission. A person reviews the page, the citations, and the remaining unknowns, then merges it; no run merges automatically.",
    "",
  );
  return lines.join("\n");
}

/**
 * Builds the proposal. A verification that is not proved yields a no-op proposal with the failures named; a proved
 * verification yields the page file, its hash, and the review body.
 */
export function authoringProposalOf(
  task: AuthoringTask,
  verification: AuthoringVerification,
  draft: AuthoringDraft,
  preview: AuthoringPreview,
  options: AuthoringProposalOptions = {},
): AuthoringProposal {
  const content = renderDraftSource(draft);
  const files = verification.ready
    ? [{ path: task.location.source, sha256: sha256(content), content }]
    : [];
  const branch = options.branch ?? authoringBranch(task.item);
  const baseBranch = options.base ?? "main";
  const labels = [...new Set(["authoring", task.surface.area, ...(options.labels ?? [])])].sort(byCodePoint);
  const body = bodyOf(task, verification, draft, preview, files.map((file) => file.path));
  const title = titleOf(task);
  const noop = !verification.ready || files.length === 0;
  return {
    version: 1,
    id: sha256(
      canonicalJson({
        branch,
        base: baseBranch,
        files: files.map((file) => `${file.path}\u0000${file.sha256}`),
        body,
        proof: verification.proof?.hash ?? "",
      }),
    ),
    item: task.item,
    task: task.task.id,
    branch,
    base: baseBranch,
    title,
    body,
    commitMessage: `docs: document ${task.item}`,
    files,
    labels,
    checks: verification.checks.filter((entry) => entry.status === "passed").map((entry) => entry.id).sort(byCodePoint),
    proofHash: verification.proof?.hash ?? "",
    remainingUnknowns: [...verification.remainingUnknowns],
    remainingQuestions: [...verification.remainingQuestions],
    permissions: { contents: "write", pullRequests: "write", publish: false, merge: false },
    noop,
    ...(noop
      ? {
          noopReason: verification.failures.length === 0
            ? "The verification is not proved."
            : `The verification is not proved: ${verification.failures.join(" ")}`,
        }
      : {}),
  };
}
