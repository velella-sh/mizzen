/**
 * Export a task and its context pack for an external agent (#1410).
 *
 * Draft generation stays outside the engine: this module writes one versioned JSON document with the authoring task,
 * the ready-to-paste Markdown pack, its accounting, answerability, omissions, requests, and sourced fragments. Nothing
 * here calls a model or a hosted service, and the same task and site give the same bytes.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Site } from "../contracts/index.ts";
import type { AuthoringExport, AuthoringTask } from "../contracts/authoring.ts";
import { compileTaskContext, ContextCompileError } from "../context/compile.ts";
import { formatSpan } from "../source/spans.ts";

/** What an export needs. */
export interface AuthoringExportOptions {
  readonly task: AuthoringTask;
  readonly site: Site;
  /** The site root, so links, includes, and symbols can be collected. */
  readonly root: string;
  /** The context budget; defaults to the task's own budget. */
  readonly maxTokens?: number;
}

/** An export, or every reason the task makes no valid context request. */
export interface AuthoringExportResult {
  readonly exported?: AuthoringExport;
  readonly problems: readonly string[];
}

/** A file's text, or `undefined` when it cannot be read. */
async function fileText(root: string, file: string): Promise<string | undefined> {
  try {
    return await readFile(join(root, file), "utf8");
  } catch {
    return undefined;
  }
}

/** The lines of a file from `start` to `end`, both 1-based and inclusive. */
function linesOf(text: string, start: number, end: number): string {
  return text
    .split(/\r?\n/u)
    .slice(Math.max(0, start - 1), Math.max(start, end))
    .join("\n");
}

/** The exact evidence a draft must cite, with local source text when it is readable. */
async function evidenceOf(task: AuthoringTask, root: string): Promise<AuthoringExport["pack"]["evidence"]> {
  const out: AuthoringExport["pack"]["evidence"][number][] = [];
  for (const entry of task.requiredEvidence) {
    if (entry.kind === "surface") {
      const source = task.surface.source;
      const text = await fileText(root, source.file);
      out.push({
        kind: entry.kind,
        ref: entry.ref,
        detail: entry.detail,
        file: source.file,
        span: formatSpan(source),
        ...(text === undefined ? {} : { content: linesOf(text, source.line, Math.max(source.line, source.endLine)) }),
      });
    } else if (entry.kind === "source" || entry.kind === "test") {
      const match = /^(.*?):(\d+)$/u.exec(entry.ref);
      const file = entry.kind === "test" ? entry.ref : match?.[1];
      if (file === undefined) {
        out.push({ kind: entry.kind, ref: entry.ref, detail: entry.detail });
        continue;
      }
      const text = await fileText(root, file);
      const start = match === null ? 1 : Number(match[2]);
      out.push({
        kind: entry.kind,
        ref: entry.ref,
        detail: entry.detail,
        file,
        ...(text === undefined ? {} : { content: entry.kind === "test" ? text : linesOf(text, start, start) }),
      });
    } else {
      out.push({ kind: entry.kind, ref: entry.ref, detail: entry.detail });
    }
  }
  return out;
}

/**
 * Compiles the task's context within its budget and returns the versioned export. A valid task whose page does not
 * exist yet is not an error: the pack names the missing scope in `answerability.shortages` and `requests`, so the
 * external agent knows exactly what evidence to supply.
 */
export async function authoringExportOf(options: AuthoringExportOptions): Promise<AuthoringExportResult> {
  const { task, site, root } = options;
  try {
    const compiled = await compileTaskContext(site, task.task, {
      root,
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    });
    return {
      exported: {
        version: 1,
        task,
        pack: {
          markdown: compiled.markdown,
          accounting: {
            requested: compiled.accounting.requested,
            used: compiled.accounting.used,
            remaining: compiled.accounting.remaining,
            upper: compiled.accounting.upper,
            method: compiled.accounting.method,
          },
          answerability: {
            complete: compiled.answerability.complete,
            shortages: [...compiled.answerability.shortages],
          },
          omissions: compiled.omitted.map((omission) => ({
            ref: omission.ref,
            reason: omission.reason,
            detail: omission.detail,
            ...(omission.answers === undefined ? {} : { answers: [...omission.answers] }),
          })),
          requests: compiled.requests.map((request) => ({
            kind: request.kind,
            ref: request.ref,
            detail: request.detail,
            action: request.action,
          })),
          fragments: compiled.fragments.map((fragment) => ({
            id: fragment.id,
            title: fragment.title,
            source: {
              file: fragment.source.file,
              span: fragment.source.span,
              ...(fragment.source.block === undefined ? {} : { block: fragment.source.block }),
              ...(fragment.source.record === undefined ? {} : { record: fragment.source.record }),
              snapshot: fragment.source.snapshot,
            },
            tokens: fragment.tokens,
            content: fragment.content,
          })),
          evidence: await evidenceOf(task, root),
        },
      },
      problems: [],
    };
  } catch (error) {
    if (error instanceof ContextCompileError) return { problems: [...error.problems] };
    return { problems: [error instanceof Error ? error.message : String(error)] };
  }
}
