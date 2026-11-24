import type { Diagnostic, ExampleRunStatus, Page, RecordedExampleResult, Site, SourcePos } from "../contracts/index.ts";
import type { Output, OutputFile } from "../contracts/output.ts";
import { type MarkdownExample } from "../markdown/plugins/example-fence.ts";
import { cachedRun, exampleCache, exampleCacheDirOf, type ExampleCache } from "../pipeline/examples/cache.ts";
import { exampleFailed, exampleSandboxUnavailable } from "../pipeline/examples/diagnostic.ts";
import { runNodeExample, type ExampleLang } from "../pipeline/examples/run-node.ts";
import { runShellExample, sandboxAvailable } from "../pipeline/examples/run-shell.ts";
import { exampleHash, exampleRoute, pageExamples, type ExamplesLock, type RecordedExamples } from "../examples/pinned.ts";
import { runPageExamples, type RunPageOptions } from "../examples/run.ts";

/**
 * Writes `examples.json`: one entry per page with how many runnable examples it declares, how many passed, how many
 * failed, and how many were not run (#1465).
 *
 * Every fence marked `test` is found again from the page's Markdown by `examplesOf`, then run: `js`, `mjs`, and `ts`
 * through `runNodeExample`, `bash` and `sh` through `runShellExample`. An example passes when it exits with code 0
 * and, when it is followed by an `output` fence, when its stdout matches that fence after line endings are normalized
 * and trailing newlines are dropped. A fence without an `output` fence checks only that it exits successfully. A
 * failing example is reported through `exampleFailed`, with the fence's source position. It is a warning by default;
 * `examples: { failOnFailure: true }` makes it an error, so `mizzen check` exits 1 without turning any other warning
 * into an error. A host with no OS sandbox reports one `example-sandbox` warning, so a build never presents
 * best-effort limits as isolation.
 *
 * A fence whose language has no runner (`python`, `rust`, an empty language) is **not run**: it is counted in `skipped`
 * and neither passed nor failed, because the engine cannot know whether it works. For every page
 * `total = passed + failed + skipped`.
 *
 * ## Machine dependence
 *
 * Running an example makes the build depend on the machine it runs on: the installed Node version, `PATH`, the
 * process limit, and whatever the example reads from the network. A build has to be deterministic,
 * so the legacy `examples.json` records only counts, in a fixed key order, sorted by page URL. Pinned mode reports
 * provenance from an earlier explicit run. A site can switch the output off with
 * `outputs: { examples-report: false }`.
 *
 * ## Cache
 *
 * `examplesReport` runs every example unless `cacheDir` names a folder. The output enables the cache only when
 * `MIZZEN_EXAMPLES_CACHE` is set: a path uses that folder, and `1`, `true`, or an empty value use the default
 * `.mizzen/examples` under the working directory. With the cache on, changing the code, language, runner, Node
 * version, or engine version misses the entry and the example runs again.
 *
 */

/** The runner family of a supported example language; also the `kind` of its cache key. */
export type ExampleKind = "node" | "shell";

/** What one runner reports. A duration is allowed and ignored: it never reaches the JSON. */
export interface ExampleRun {
  /** The process exit code, or `null` when it timed out, was refused, or could not start. */
  readonly exitCode: number | null;
  /** Standard output, which an `output` fence is compared with. */
  readonly stdout: string;
  /** How long the run took, in milliseconds; accepted and never written. */
  readonly durationMs?: number;
  /** Why the runner refused or could not run the example, shown instead of an empty actual output. */
  readonly error?: string;
}

/** What a runner receives. */
export interface ExampleRunInput {
  /** The fence's code, unmodified. */
  readonly code: string;
  /** The lowercased fence language: `js`, `mjs`, `ts`, `bash`, or `sh`. */
  readonly lang: string;
  /** Which runner family handles it. */
  readonly kind: ExampleKind;
}

/** Runs one example. Tests replace it; the default spawns a process. */
export type ExampleRunner = (input: ExampleRunInput) => Promise<ExampleRun>;

/** Options of {@link examplesReport}. Every field has a default. */
export interface ExamplesReportOptions {
  /** Called once per failing example, with the fence's position. The output passes the build context's `report`. */
  readonly report?: (diagnostic: Diagnostic) => void;
  /** Enables the example cache in this folder. Default: no cache, so every example runs. */
  readonly cacheDir?: string;
  /** Replaces the process runners. The cache still wraps it, so a hit never calls it. */
  readonly runner?: ExampleRunner;
  /** Per-example timeout for the default runners, in milliseconds. Default: the runner's own. */
  readonly timeoutMs?: number;
}

/** One page's counts, in the order the JSON writes them. */
interface PageExamples {
  /** Output URL, including `base`. */
  readonly url: string;
  /** Every `test` fence on the page, including the ones not run. */
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  /** Examples whose language has no runner; they are neither passed nor failed. */
  readonly skipped: number;
}

/** The JSON body, with a fixed key order so the same counts give the same bytes. */
interface ExamplesJson {
  readonly pages: readonly PageExamples[];
}

/** The environment variable that enables the cache in the output. */
const CACHE_ENV = "MIZZEN_EXAMPLES_CACHE";

/** Languages `runNodeExample` runs. */
const NODE_LANGS: ReadonlySet<string> = new Set(["js", "mjs", "ts"]);

/** Languages `runShellExample` runs. */
const SHELL_LANGS: ReadonlySet<string> = new Set(["bash", "sh"]);

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The runner family of a language, or `undefined` when no runner handles it. */
function kindOf(lang: string): ExampleKind | undefined {
  if (NODE_LANGS.has(lang)) return "node";
  if (SHELL_LANGS.has(lang)) return "shell";
  return undefined;
}

/**
 * What an `output` fence and stdout are compared as: CRLF folded to LF and trailing newlines dropped. A code fence
 * value carries no trailing newline while `console.log` writes one, so the two would never match otherwise.
 */
function normalize(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
}

/** True when a run passed: exit code 0, and stdout equal to the expected output when the page gives one. */
function passed(example: MarkdownExample, run: ExampleRun): boolean {
  if (run.exitCode !== 0) return false;
  if (example.expected === null) return true;
  return normalize(example.expected) === normalize(run.stdout);
}

/** The fence's source span, with the page's file when the record has none. */
function posOf(page: Page, example: MarkdownExample): SourcePos {
  return {
    file: example.pos.file ?? page.source.file,
    line: example.pos.line,
    column: example.pos.column,
    endLine: example.pos.endLine,
    endColumn: example.pos.endColumn,
  };
}

/** The default runner: the Node process runner or the shell process runner, chosen by language family. */
function defaultRunner(options: ExamplesReportOptions): ExampleRunner {
  /** A refused run carries its reason, so the diagnostic shows why instead of an empty actual output. */
  const report = (result: {
    readonly exitCode: number | null;
    readonly stdout: string;
    readonly durationMs: number;
    readonly rejected: boolean;
    readonly stderr: string;
  }): ExampleRun => ({
    exitCode: result.exitCode,
    stdout: result.stdout,
    durationMs: result.durationMs,
    ...(result.rejected ? { error: result.stderr.trim() } : {}),
  });
  return async (input) => {
    if (input.kind === "node") {
      const result = await runNodeExample({
        code: input.code,
        lang: input.lang as ExampleLang,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
      return report(result);
    }
    const result = await runShellExample({
      code: input.code,
      shell: input.lang as "bash" | "sh",
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    return report(result);
  };
}

/**
 * Runs one example, through the cache when there is one. A runner that throws is a failed result, not a failed
 * build: the message becomes the observed output in the diagnostic.
 */
async function runOne(
  cache: ExampleCache | undefined,
  runner: ExampleRunner,
  input: ExampleRunInput,
): Promise<ExampleRun> {
  try {
    if (cache === undefined) return await runner(input);
    const { result } = await cachedRun(
      cache,
      { code: input.code, lang: input.lang, kind: input.kind },
      () => runner(input),
    );
    return result;
  } catch (error) {
    return { exitCode: null, stdout: "", error: error instanceof Error ? error.message : String(error) };
  }
}

/** The diagnostic for one failed example: the fence's position, the expected output, and what happened. */
function diagnosticOf(
  page: Page,
  example: MarkdownExample,
  run: ExampleRun,
  failOnFailure: boolean,
): Diagnostic {
  const diagnostic = exampleFailed({
    pos: posOf(page, example),
    page: page.url,
    expected: example.expected ?? "",
    actual: run.error ?? run.stdout,
    ...(run.exitCode === null || run.exitCode === 0 ? {} : { exitCode: run.exitCode }),
  });
  return failOnFailure ? { ...diagnostic, severity: "error" } : diagnostic;
}

/**
 * Runs a site's examples and returns page totals and optional per-fence evidence. Pages without examples
 * are present with zero totals.
 *
 * Only doc pages are parsed and run: an app page has no Markdown body of its own, so it is present with zeros. The
 * runner, the cache folder, and the report sink are options, so a test can use a fake runner and a temp cache.
 */
async function runExamples(
  site: Site,
  options: ExamplesReportOptions,
  recording?: Pick<RecordedExampleResult, "date" | "commit">,
): Promise<{ readonly pages: readonly PageExamples[]; readonly examples: RecordedExamples }> {
  const runner = options.runner ?? defaultRunner(options);
  const cache = options.cacheDir === undefined ? undefined : exampleCache({ dir: options.cacheDir });
  const failOnFailure = site.config.examples?.failOnFailure === true;
  const pages: PageExamples[] = [];
  // Probed only when the default runners are about to run a real example, so a fake runner stays sandbox-free.
  let hasSandbox: boolean | undefined;
  const recorded: Record<string, Record<string, RecordedExampleResult>> = {};
  const save = (page: Page, example: MarkdownExample, status: ExampleRunStatus): void => {
    if (recording === undefined) return;
    const route = exampleRoute(page.url, site.config.base);
    (recorded[route] ??= {})[example.id] = {
      status,
      file: example.pos.file ?? page.source.file,
      line: example.pos.line,
      language: example.lang,
      ...recording,
      sha256: exampleHash(example),
    };
  };

  const allPages = [...site.pages].sort((a, b) => byCodePoint(a.url, b.url));
  for (const page of allPages) {
    const examples = await pageExamples(page, recording !== undefined);
    let passedCount = 0;
    let failedCount = 0;
    let skipped = 0;

    for (const example of examples) {
      const lang = example.lang.trim().toLowerCase();
      const kind = kindOf(lang);
      if (kind === undefined) {
        skipped += 1;
        save(page, example, "skipped");
        continue;
      }
      // One explicit finding when the host cannot confine examples, so a passing example never silently implies
      // isolation the platform did not provide. Only the default runners are subject to the host's sandbox.
      if (options.runner === undefined && hasSandbox === undefined) {
        hasSandbox = sandboxAvailable();
        if (!hasSandbox && recording === undefined) options.report?.(exampleSandboxUnavailable(process.platform));
      }
      if (recording !== undefined && hasSandbox === false) {
        skipped += 1;
        save(page, example, "sandbox-unavailable");
        continue;
      }
      const outcome = await runOne(cache, runner, { code: example.code, lang, kind });
      if (passed(example, outcome)) {
        passedCount += 1;
        save(page, example, "passed");
      } else {
        failedCount += 1;
        save(page, example, "failed");
        options.report?.(diagnosticOf(page, example, outcome, failOnFailure));
      }
    }

    pages.push({ url: page.url, total: examples.length, passed: passedCount, failed: failedCount, skipped });
  }

  return { pages, examples: recorded };
}

/** Explicitly run examples without the cache and capture their provenance. */
export async function recordExamples(
  site: Site,
  provenance: Pick<RecordedExampleResult, "date" | "commit">,
  report: (diagnostic: Diagnostic) => void,
): Promise<ExamplesLock> {
  const { examples } = await runExamples(site, { report }, provenance);
  return { version: 1, examples };
}

/** What {@link recordExecutableExamples} needs: the site, its root, and the locked inputs. */
export interface RecordExecutableOptions {
  /** The site whose pages hold the fences. */
  readonly site: Site;
  /** Absolute site root: where snippets, fixtures, and `node_modules` live. */
  readonly root: string;
  /** Absolute source folder. */
  readonly sourceDir: string;
  /** The recorded run's provenance. */
  readonly provenance: Pick<RecordedExampleResult, "date" | "commit">;
  /** The environment hash the run cites, from `.mizzen-env.json`. */
  readonly environment?: string;
  /** The locked limits and allowlist. */
  readonly limits: RunPageOptions["limits"];
  readonly allowlist?: readonly string[];
  /** The result cache, so an unchanged session replays its stored outcome. */
  readonly cache?: ExampleCache;
  /** The `tsc` entry, for a test. */
  readonly tsc?: string;
  /** Fail a failed example as an error. */
  readonly failOnFailure?: boolean;
  /** Receives every finding. */
  readonly report: (diagnostic: Diagnostic) => void;
}

/**
 * Runs a site's opt-in examples through the session orchestrator and records one result per fence: shared sessions,
 * hidden setup and teardown, snippets, runbooks, type-check, stdout and stderr, limits, and the cache all apply, and
 * every result keeps its environment hash and evidence. The lock is written by the caller; this function never touches
 * the filesystem beyond reading snippets and fixtures.
 */
export async function recordExecutableExamples(options: RecordExecutableOptions): Promise<ExamplesLock> {
  const examples: Record<string, Record<string, RecordedExampleResult>> = {};
  const failOnFailure = options.failOnFailure === true || options.site.config.examples?.failOnFailure === true;
  for (const page of [...options.site.pages].sort((a, b) => byCodePoint(a.url, b.url))) {
    const blocks = await pageExamples(page, true);
    if (blocks.length === 0) continue;
    const file = blocks[0]?.pos.file ?? page.source.file;
    const run = await runPageExamples({
      examples: blocks,
      page: page.url,
      file,
      root: options.root,
      sourceDir: options.sourceDir,
      limits: options.limits,
      ...(options.allowlist === undefined ? {} : { allowlist: options.allowlist }),
      provenance: options.provenance,
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      ...(options.cache === undefined ? {} : { cache: options.cache }),
      ...(options.tsc === undefined ? {} : { tsc: options.tsc }),
      failOnFailure,
    });
    const route = exampleRoute(page.url, options.site.config.base);
    examples[route] = Object.fromEntries(run.results);
    for (const diagnostic of run.diagnostics) options.report(diagnostic);
  }
  return { version: 1, examples };
}

function reportFile(body: ExamplesJson & Partial<ExamplesLock>): readonly OutputFile[] {
  return [{ path: "examples.json", contents: `${JSON.stringify(body, null, 2)}\n` }];
}

/** A pinned report counts stale or missing evidence as skipped and publishes only current results. */
async function pinnedReport(site: Site, report: ExamplesReportOptions["report"]): Promise<readonly OutputFile[]> {
  const pages: PageExamples[] = [];
  const current: Record<string, Record<string, RecordedExampleResult>> = {};
  for (const page of [...site.pages].sort((a, b) => byCodePoint(a.url, b.url))) {
    const examples = await pageExamples(page, true);
    let passedCount = 0;
    let failedCount = 0;
    for (const example of examples) {
      const result = page.examples?.[example.id];
      if (result === undefined || result.status === "stale") continue;
      (current[page.url] ??= {})[example.id] = result;
      if (result.status === "passed") passedCount += 1;
      if (result.status === "failed") {
        failedCount += 1;
        report?.({
          id: "example-failed",
          severity: site.config.examples?.failOnFailure === true ? "error" : "warning",
          message: `The recorded run of ${example.id} failed on ${result.date}.`,
          pos: posOf(page, example),
        });
      }
    }
    const total = examples.length;
    pages.push({ url: page.url, total, passed: passedCount, failed: failedCount, skipped: total - passedCount - failedCount });
  }
  return reportFile({ pages, version: 1, examples: current });
}

/**
 * Publishes `examples.json` from the results the build already attached to each page (`examples.execute`). The build
 * runs the examples once, before its outputs, and attaches them to `page.examples`; this reads that one map, so the
 * output never runs an example a second time and `examples.json`, page JSON, and the HTML always agree. A page with no
 * results is present with zero counts.
 */
export function attachedReport(site: Site): readonly OutputFile[] {
  const pages: PageExamples[] = [];
  const examples: Record<string, Record<string, RecordedExampleResult>> = {};
  for (const page of [...site.pages].sort((a, b) => byCodePoint(a.url, b.url))) {
    const results = page.examples ?? {};
    const ids = Object.keys(results).sort(byCodePoint);
    if (ids.length === 0) {
      pages.push({ url: page.url, total: 0, passed: 0, failed: 0, skipped: 0 });
      continue;
    }
    let passedCount = 0;
    let failedCount = 0;
    const current: Record<string, RecordedExampleResult> = {};
    for (const id of ids) {
      const result = results[id]!;
      // A build's own run never leaves a stale entry; a manually written one is skipped rather than republished.
      if (result.status === "stale") continue;
      current[id] = result;
      if (result.status === "passed") passedCount += 1;
      if (result.status === "failed") failedCount += 1;
    }
    examples[page.url] = current;
    pages.push({ url: page.url, total: ids.length, passed: passedCount, failed: failedCount, skipped: ids.length - passedCount - failedCount });
  }
  return reportFile({ pages, version: 1, examples });
}

export async function examplesReport(
  site: Site,
  options: ExamplesReportOptions = {},
): Promise<readonly OutputFile[]> {
  if (site.config.examples?.pinned === true) return pinnedReport(site, options.report);
  const { pages } = await runExamples(site, options);
  return reportFile({ pages });
}

/**
 * The cache folder `MIZZEN_EXAMPLES_CACHE` asks for, or `undefined` when the variable is unset.
 *
 * A value of `1`, `true`, or nothing is the default `.mizzen/examples` under the working directory; any other value
 * is a folder path, resolved by the cache against the working directory. The output calls this once per build, so the
 * variable is read at run time and never by {@link examplesReport}.
 */
export function examplesCacheDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[CACHE_ENV];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "1" || trimmed.toLowerCase() === "true") {
    return exampleCacheDirOf(process.cwd());
  }
  return trimmed;
}

/**
 * The output that writes `examples.json`. In pinned mode it only reads recorded results. The legacy runner
 * caches examples only when `MIZZEN_EXAMPLES_CACHE` is set.
 */
export const examplesReportOutput: Output = {
  name: "examples-report",
  async run(site: Site, ctx): Promise<readonly OutputFile[]> {
    // The build already ran and attached the examples in execute mode; the output only publishes that one map.
    if (site.config.examples?.execute === true) return attachedReport(site);
    const cacheDir = examplesCacheDir();
    return examplesReport(site, {
      report: (diagnostic) => ctx.report(diagnostic),
      ...(cacheDir === undefined ? {} : { cacheDir }),
    });
  },
};
