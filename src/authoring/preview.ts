/**
 * Preview a draft for human review (#1414): build it in a temporary copy of the site, show the page, the source diff,
 * the citations, and the uncited claims, and decide whether writing is denied, needs an approval, or is allowed.
 *
 * No function here writes the working tree. A draft with an uncited normative claim, a bad citation, a dropped
 * unknown, or a location conflict is reported before the build, so a reviewer never approves an unsupported page.
 * The repository's access policy decides the write gate when one is supplied; otherwise the write needs an explicit
 * approval, because no policy allowed it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AccessGrant, AccessPolicy, Site } from "../contracts/index.ts";
import type {
  AuthoringDraft,
  AuthoringPreview,
  AuthoringProblem,
  AuthoringTask,
  AuthoringWriteGate,
} from "../contracts/authoring.ts";
import { accessPolicyFingerprint } from "../permissions/policy.ts";
import { approvalValid, writeRule } from "../permissions/evaluate.ts";
import { unifiedDiff } from "../diff/unified.ts";
import { buildMergedSite, removeMergedSite } from "./build.ts";
import { renderDraftSource, validateAuthoringDraft } from "./draft.ts";

/** What a preview needs. */
export interface AuthoringPreviewOptions {
  readonly root: string;
  readonly site: Site;
  readonly task: AuthoringTask;
  readonly draft: AuthoringDraft;
  /** The theme root the merged build renders with. */
  readonly themeRoot: string;
  readonly version?: string;
  /** The repository's access policy; without it writing needs an explicit approval. */
  readonly policy?: AccessPolicy;
  /** An approval made under this policy and snapshot. */
  readonly approval?: AccessGrant;
  /** A human's explicit approval when no policy is configured, or alongside one that requires it. */
  readonly approve?: boolean;
}

/** The gate and its reason. */
interface Gate {
  readonly write: AuthoringWriteGate;
  readonly reason: string;
}

/** The synthetic approval `--approve` stands for. */
function explicitApproval(policy: AccessPolicy | undefined, task: AuthoringTask): AccessGrant {
  return {
    id: "authoring-cli-approval",
    capability: "write",
    principal: "cli",
    decision: "approved",
    reason: "A person approved this authoring write on the command line.",
    snapshot: task.task.snapshot.id,
    policy: policy === undefined ? "no-policy" : accessPolicyFingerprint(policy),
    files: [task.location.source],
  };
}

/** The write gate, with one sentence that names the rule. */
function writeGate(options: AuthoringPreviewOptions, problems: readonly AuthoringProblem[]): Gate {
  if (problems.length > 0) return { write: "denied", reason: "The draft is not valid; nothing can be written." };
  const task = options.task;
  const policy = options.policy;
  if (policy === undefined) {
    return options.approve === true
      ? { write: "allowed", reason: "A person approved this write explicitly; no repository policy is configured." }
      : { write: "requires-approval", reason: "No repository policy allows this write; a person must approve it." };
  }
  if (!policy.capabilities.write) return { write: "denied", reason: "The access policy denies write." };
  const decision = writeRule(policy, {
    capability: "write",
    task: task.task.id,
    snapshot: task.task.snapshot.id,
    path: task.location.source,
    scope: task.task.scope,
  });
  if (!decision.allowed) return { write: "denied", reason: `${task.location.source}: ${decision.reason}` };
  if (policy.approvals.write) {
    const grant = options.approval ?? (options.approve === true ? explicitApproval(policy, task) : undefined);
    if (grant === undefined || !approvalValid(grant, policy, task.task.snapshot.id)) {
      return { write: "requires-approval", reason: "The policy requires an approval for write on this snapshot." };
    }
  }
  return { write: "allowed", reason: "The policy allows every file and the approval, when required, is valid." };
}

/** Build error problems, without raw diagnostics or machine paths. */
function buildProblems(errors: readonly { readonly id: string; readonly message: string }[]): AuthoringProblem[] {
  return errors.map((error, index) => ({
    path: `/build/${index}`,
    code: "authoring.preview-build",
    message: `${error.id}: ${error.message}`,
  }));
}

/**
 * Previews a draft. The source diff is computed from the working tree; when the draft is valid, the page is built in a
 * temporary copy and returned with its HTML. The temporary folder is removed before the function returns.
 */
export async function authoringPreview(options: AuthoringPreviewOptions): Promise<AuthoringPreview> {
  const { task, draft, root, site } = options;
  const validation = validateAuthoringDraft(draft, task, site);
  const target = join(root, task.location.source);
  const before = existsSync(target) ? readFileSync(target, "utf8") : "";
  const after = renderDraftSource(draft);
  const diff = unifiedDiff(before, after, task.location.source);
  const problems: AuthoringProblem[] = [...validation.problems];

  if (!validation.ok) {
    const gate = writeGate(options, problems);
    return {
      version: 1,
      item: task.item,
      task: task.task.id,
      source: task.location.source,
      url: task.location.url,
      block: task.location.block,
      diff,
      claims: validation.claims,
      citations: validation.citations,
      uncited: validation.uncited,
      unknowns: validation.unknowns,
      questions: validation.questions,
      limitations: validation.limitations,
      write: gate.write,
      writeReason: gate.reason,
      problems,
    };
  }

  const merged = await buildMergedSite({
    root,
    task,
    draft,
    themeRoot: options.themeRoot,
    ...(options.version === undefined ? {} : { version: options.version }),
  });
  try {
    if (merged.errors.length > 0 || merged.html === undefined) {
      problems.push(...buildProblems(merged.errors));
      if (merged.html === undefined) {
        problems.push({
          path: "/page",
          code: "authoring.preview-missing-page",
          message: `The build wrote no page at \`${merged.file}\`.`,
        });
      }
    }
    const gate = writeGate(options, problems);
    return {
      version: 1,
      item: task.item,
      task: task.task.id,
      source: task.location.source,
      url: task.location.url,
      block: task.location.block,
      ...(merged.html === undefined
        ? {}
        : {
            page: {
              source: task.location.source,
              url: task.location.url,
              file: merged.file,
              html: merged.html,
              markdown: after,
            },
          }),
      diff,
      claims: validation.claims,
      citations: validation.citations,
      uncited: validation.uncited,
      unknowns: validation.unknowns,
      questions: validation.questions,
      limitations: validation.limitations,
      write: gate.write,
      writeReason: gate.reason,
      problems,
    };
  } finally {
    removeMergedSite(merged);
  }
}
