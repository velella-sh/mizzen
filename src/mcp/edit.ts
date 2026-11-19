/**
 * The edit tools' shared half. No edit logic lives here: a request becomes the patch document `mizzen edit apply`
 * reads, and `editApply` (src/cli/edit-apply.ts) plans, checks, and commits it.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { editApply, EditApplyError } from "../cli/edit-apply.ts";
import { McpError } from "./limits.ts";
import type { Runtime, Session } from "./runtime/operations.ts";
import type { SiteState } from "./site.ts";
import { json, refusal, type InputSchema, type ToolResult } from "./tool.ts";
import { traceMcpEdit } from "../trace/instrument.ts";

/** What both edit tools take: one span, the text and hash it was read with, and the replacement. */
export interface EditInput {
  readonly file: string;
  readonly span: { readonly line: number; readonly column: number; readonly endLine: number; readonly endColumn: number };
  readonly expected: string;
  readonly beforeHash: string;
  readonly replacement: string;
  /** An optional key: repeating the apply with it returns the first receipt instead of writing again. */
  readonly idempotencyKey?: string;
}

export const editSchema: InputSchema = {
  type: "object",
  properties: {
    file: { type: "string", minLength: 1, description: "Source file, site-relative, from get_block_source." },
    span: {
      type: "object",
      properties: {
        line: { type: "integer", minimum: 1 },
        column: { type: "integer", minimum: 1 },
        endLine: { type: "integer", minimum: 1 },
        endColumn: { type: "integer", minimum: 1 },
      },
      required: ["line", "column", "endLine", "endColumn"],
      additionalProperties: false,
    },
    expected: { type: "string", description: "The exact text the span holds now (`text` of get_block_source)." },
    beforeHash: { type: "string", pattern: "^[0-9a-fA-F]{64}$", description: "`beforeHash` of get_block_source." },
    replacement: { type: "string", description: "The text that takes the span's place; empty deletes it." },
    idempotencyKey: { type: "string", minLength: 1, maxLength: 200, description: "apply_edit only: repeating this key returns the first receipt instead of applying again." },
  },
  required: ["file", "span", "expected", "beforeHash", "replacement"],
  additionalProperties: false,
};

function patchOf(input: EditInput): string {
  return `${JSON.stringify(
    { span: { file: input.file, ...input.span }, expected: input.expected, replacement: input.replacement, beforeHash: input.beforeHash },
    null,
    2,
  )}\n`;
}

/** The refusal's file as the agent may see it: site-relative, or left out when it lies outside the site (a patch file). */
function pathOf(path: string | undefined): Record<string, unknown> {
  if (path === undefined || isAbsolute(path)) return {};
  const shown = path.replace(/\\/g, "/");
  return shown.startsWith("..") ? {} : { path: shown };
}

/** Runs the edit as a dry run (nothing is written to the site) or for real (source, proof, and audit in one transaction). */
export async function runEdit(site: SiteState, input: EditInput, apply: boolean, signal?: AbortSignal): Promise<ToolResult> {
  if (signal?.aborted) throw new McpError("cancelled", "The edit was cancelled before its transaction; nothing was written.", { retryable: true, stage: "edit" });
  const sha = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 12);
  const scratch = apply ? undefined : await mkdtemp(join(tmpdir(), "mizzen-mcp-edit-"));
  const folder = scratch ?? join(site.root, ".mizzen", "mcp", "edits");
  try {
    await mkdir(folder, { recursive: true });
    const patch = join(folder, `${input.beforeHash.slice(0, 12)}-${sha(patchOf(input))}.patch.json`);
    await writeFile(patch, patchOf(input), "utf8");
    const result = await editApply({
      siteRoot: site.root,
      patch,
      ...(apply ? {} : { dryRun: true }),
      // Cancellation stops at the transaction's safe boundary: before the first rename, nothing changes.
      ...(apply && signal !== undefined ? { transactionHooks: { beforeCommit: () => signal.throwIfAborted() } } : {}),
    });
    if (!apply) {
      return json({
        ok: true,
        applied: false,
        file: result.file,
        patch: { span: { file: input.file, ...input.span }, expected: input.expected, replacement: input.replacement, beforeHash: input.beforeHash },
        beforeHash: result.beforeHash,
        afterHash: result.afterHash,
        diff: result.diff ?? "",
      });
    }
    await site.refresh();
    const diagnostics = site.diagnostics.filter((d) => d.pos?.file.replace(/\\/g, "/") === result.file);
    await traceMcpEdit(
      { file: input.file, span: input.span },
      {
        file: result.file,
        beforeHash: result.beforeHash,
        afterHash: result.afterHash,
        ...(result.proof === undefined ? {} : { proof: site.relative(result.proof) }),
        diagnostics: diagnostics.length,
      },
    );
    return json({
      ok: true,
      applied: true,
      file: result.file,
      proof: result.proof === undefined ? undefined : site.relative(result.proof),
      beforeHash: result.beforeHash,
      afterHash: result.afterHash,
      diagnostics,
    });
  } catch (err) {
    if (signal?.aborted) {
      throw new McpError("cancelled", "The edit was cancelled at its safe boundary; no source, proof, or audit was written.", {
        retryable: true,
        stage: "edit",
      });
    }
    if (err instanceof EditApplyError) return refusal(err.code, err.message, pathOf(err.path));
    throw err instanceof Error ? new McpError("edit-failed", err.message) : err;
  } finally {
    if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
  }
}

/** Applies an edit at most once per idempotency key, returning the first receipt for every repeat. */
export async function runApply(
  site: SiteState,
  input: EditInput,
  runtime: Runtime,
  session: Session,
  signal: AbortSignal,
): Promise<ToolResult> {
  const payloadHash = createHash("sha256")
    .update(JSON.stringify({ file: input.file, span: input.span, expected: input.expected, beforeHash: input.beforeHash, replacement: input.replacement }))
    .digest("hex");
  const key = input.idempotencyKey;
  if (key !== undefined) {
    const existing = await runtime.receipt(session, key, payloadHash);
    if (existing !== undefined) return json({ ...existing.result, idempotent: true, receiptId: existing.id });
  }
  const result = await runEdit(site, input, true, signal);
  if (key === undefined || result.isError === true || result.data === undefined) return result;
  const receipt = await runtime.recordReceipt(session, key, payloadHash, result.data);
  return json({ ...result.data, idempotent: false, receiptId: receipt.id });
}
