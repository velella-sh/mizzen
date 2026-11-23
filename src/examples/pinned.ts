import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FenceExampleResult, Page, RecordedExampleResult } from "../contracts/index.ts";
import { checkAsOf } from "../dates/as-of.ts";
import { examplesOf, type MarkdownExample } from "../markdown/plugins/example-fence.ts";
import { spansIn } from "../source/spans.ts";

export const EXAMPLES_LOCK_FILE = ".mizzen-examples.json";

export type RecordedExamples = Readonly<Record<string, Readonly<Record<string, RecordedExampleResult>>>>;

export interface ExamplesLock {
  readonly version: 1;
  readonly examples: RecordedExamples;
}

export function validRunDate(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && checkAsOf(date) === undefined;
}

export function validRunCommit(commit: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit);
}

export function exampleHash({ lang, code, expected }: MarkdownExample): string {
  return createHash("sha256").update(JSON.stringify([lang, code, expected])).digest("hex");
}

/** The lock uses routes without the deployment base so preview builds can reuse the same evidence. */
export function exampleRoute(url: string, base: string): string {
  return base !== "" && url.startsWith(`${base}/`) ? url.slice(base.length) : url;
}

export async function pageExamples(page: Page, withSource = false): Promise<MarkdownExample[]> {
  // An app has no Markdown body. A test fence always contains the token.
  if (page.kind !== "doc" || !page.markdown.includes("test")) return [];
  const examples = await examplesOf(page);
  if (!withSource || examples.length === 0) return examples;

  // The HTML stage stamps the original file and span before includes and generated fields lose their source mapping
  // in the Markdown twin. The source is on <pre> and the example ID is on its immediate <code> element.
  const positions = new Map(
    [...page.html.matchAll(/<pre\s+([^>]*)><code\s+[^>]*?\bdata-example-id="(example-[1-9]\d*)"/g)]
      .map((match) => [match[2], spansIn(match[1] ?? "")[0]] as const),
  );
  return examples.map((example) => {
    const pos = positions.get(example.id);
    return pos === undefined ? example : { ...example, pos };
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordedResult(value: unknown): RecordedExampleResult | undefined {
  if (!isObject(value)) return undefined;
  const { status, file, line, language, date, commit, sha256 } = value;
  if (status !== "passed" && status !== "failed" && status !== "skipped" && status !== "sandbox-unavailable") return undefined;
  if (typeof file !== "string" || file === "" || typeof line !== "number" || !Number.isSafeInteger(line) || line < 1) return undefined;
  if (typeof language !== "string" || typeof date !== "string" || !validRunDate(date)) return undefined;
  if (typeof commit !== "string" || !validRunCommit(commit) || typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) return undefined;
  return { status, file, line, language, date, commit, sha256 };
}

export async function readExamplesLock(root: string): Promise<{ readonly lock: ExamplesLock; readonly digest: string } | undefined> {
  const contents = await readFile(join(root, EXAMPLES_LOCK_FILE), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (contents === undefined) return undefined;
  const value: unknown = JSON.parse(contents);
  if (!isObject(value) || value.version !== 1 || !isObject(value.examples)) {
    throw new Error("Expected a version 1 example results file.");
  }
  const examples: Record<string, Record<string, RecordedExampleResult>> = {};
  for (const [route, entries] of Object.entries(value.examples)) {
    if (!route.startsWith("/") || !isObject(entries)) throw new Error(`Invalid example results at ${route}.`);
    const results: Record<string, RecordedExampleResult> = {};
    for (const [id, entry] of Object.entries(entries)) {
      const result = recordedResult(entry);
      if (!/^example-[1-9]\d*$/.test(id) || result === undefined) throw new Error(`Invalid result for ${route} ${id}.`);
      results[id] = result;
    }
    examples[route] = results;
  }
  return { lock: { version: 1, examples }, digest: createHash("sha256").update(contents).digest("hex") };
}

/** Match each result against the current fence. A changed or new fence cannot inherit a passing state. */
export async function pinnedExamplesOf(
  page: Page,
  base: string,
  lock: ExamplesLock,
): Promise<Readonly<Record<string, FenceExampleResult>> | undefined> {
  const prior = lock.examples[exampleRoute(page.url, base)];
  if (prior === undefined) return undefined;
  const results: Record<string, FenceExampleResult> = {};
  for (const example of await pageExamples(page)) {
    const recorded = prior[example.id];
    if (recorded === undefined) continue;
    if (recorded.sha256 === exampleHash(example)) results[example.id] = recorded;
    else results[example.id] = { ...recorded, status: "stale", recordedStatus: recorded.status };
  }
  return Object.keys(results).length === 0 ? undefined : results;
}
