/**
 * Write an approved draft (#1414). The write path re-runs the preview, so the repository policy and the approval are
 * applied at the moment of writing, not at the moment of review. A denied or unapproved write returns the preview and
 * the reason and changes nothing.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AccessGrant, AccessPolicy, Site } from "../contracts/index.ts";
import type { AuthoringDraft, AuthoringTask, AuthoringWriteResult } from "../contracts/authoring.ts";
import { renderDraftSource } from "./draft.ts";
import { authoringPreview, type AuthoringPreviewOptions } from "./preview.ts";

/** What a write needs. */
export interface AuthoringWriteOptions extends Omit<AuthoringPreviewOptions, "draft" | "task" | "site"> {
  readonly root: string;
  readonly site: Site;
  readonly task: AuthoringTask;
  readonly draft: AuthoringDraft;
  readonly policy?: AccessPolicy;
  readonly approval?: AccessGrant;
  readonly approve?: boolean;
}

/**
 * Previews and, only when the gate allows it, writes the page. The returned preview is the one the gate and the write
 * were based on, so a caller can show exactly what changed.
 */
export async function writeAuthoringDraft(options: AuthoringWriteOptions): Promise<AuthoringWriteResult> {
  const preview = await authoringPreview(options);
  if (preview.write !== "allowed") {
    return { written: false, gate: preview.write, reason: preview.writeReason, preview };
  }
  const path = join(options.root, options.task.location.source);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, renderDraftSource(options.draft), "utf8");
  return {
    written: true,
    path: options.task.location.source,
    gate: preview.write,
    reason: `Wrote \`${options.task.location.source}\` after the approval.`,
    preview,
  };
}
