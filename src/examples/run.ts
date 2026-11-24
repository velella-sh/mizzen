/**
 * Runs a page's executable examples (#1328 – #1334).
 *
 * A page's `test` fences are grouped and executed as one plan:
 *
 * 1. **Snippets** are read first (#1332). A block that names `snippet="file.ts:2-10"` takes its code from the file, and
 *    the snippet's bytes are part of the block's evidence hash, so an edited source invalidates a recorded pass.
 * 2. **Type-checking** (#1327) compiles every visible `ts`/`js` block against the fixture files it imports and reports a
 *    type error at the fence. A block that fails to type-check is not run.
 * 3. **Sessions** (#1330) group the blocks by `session`: an unset session is the page default, and every block in one
 *    session runs in order in a single folder, so a later block sees what an earlier one wrote. The declared order is
 *    document order, so page order and a parallel build produce the same result.
 * 4. **Hidden setup and teardown** (#1331) run in the same session as the visible blocks around them; they are hidden
 *    from the public HTML but kept in the Markdown twin.
 * 5. **Runbooks** (#1333) are `step` blocks that run as an allowlisted shell sequence and stop at the first failure.
 * 6. **Limits** (#1334) — the timeout, the memory limit, the output cap, the denied network, and the denied commands —
 *    are applied by the shared session runner, which classifies each violation.
 * 7. **Output checks** (#1329) compare stdout and stderr with the adjacent `output` and `stderr` fences under the
 *    documented whitespace rule.
 *
 * The result is deterministic and portable: it keeps exit codes, normalized output, hashes, and spans, never a
 * temporary path or a duration, so the same evidence can be cached, replayed, and published.
 */
import type { Diagnostic } from "../contracts/diagnostic.ts";
import type { ExampleEvidence, ExampleEvidenceOutput, RecordedExampleResult } from "../contracts/code.ts";
import type { MarkdownExample } from "../markdown/plugins/example-fence.ts";
import { exampleHash } from "./pinned.ts";
import { loadSnippet, type LoadedSnippet } from "./snippet.ts";
import { matchOutput, type OutputMatch } from "./match.ts";
import { runSession, sessionSandboxAvailable, type BlockLang, type SessionBlock, type SessionLimits, type SessionResult } from "./session.ts";
import { exampleSandboxUnavailable } from "../pipeline/examples/diagnostic.ts";
import type { ExampleCache } from "../pipeline/examples/cache.ts";
import { runRunbook, type Runbook, type RunbookResult } from "./runbook.ts";
import { typeCheckExample, typeCheckable, type ExampleTypeFinding } from "./type-check.ts";
import {
  exampleTypeDiagnostic,
  exitDiagnostic,
  mismatchDiagnostic,
  runbookDiagnostic,
  typeDiagnosticOf,
} from "./diagnostics.ts";

/** The block language a fence runs as, or `undefined` when no runner handles it. */
export function blockLangOf(lang: string): BlockLang | undefined {
  const lower = lang.trim().toLowerCase();
  if (lower === "js" || lower === "mjs") return "js";
  if (lower === "ts") return "ts";
  if (lower === "bash" || lower === "sh") return "bash";
  return undefined;
}

/** One block of the plan: it is either run, skipped, or a runbook step handled elsewhere. */
export interface PlannedBlock {
  readonly example: MarkdownExample;
  /** The code as it will run: an imported snippet's text, or the fence's own. */
  readonly code: string;
  /** The language it runs as, when a runner handles it. */
  readonly lang: BlockLang | undefined;
  /** The snippet it read, when it imported one. */
  readonly snippet: LoadedSnippet | undefined;
  /** One finding when the snippet could not be read, so the block is skipped. */
  readonly problem: Diagnostic | undefined;
}

/** What one page's run produced: one result per block, and the findings that do not belong to a block. */
export interface PageRun {
  /** One recorded result per runnable or skipped block, keyed by the block's id. */
  readonly results: ReadonlyMap<string, RecordedExampleResult>;
  /** Findings: type errors, snippet problems, runbook failures, and failed blocks. */
  readonly diagnostics: readonly Diagnostic[];
  /** The runbook results, when the page had any. */
  readonly runbooks: readonly RunbookResult[];
}

/** What {@link runPageExamples} needs. */
export interface RunPageOptions {
  /** The page's blocks, in document order (the parsed `MarkdownExample`s). */
  readonly examples: readonly MarkdownExample[];
  /** The page's URL, named in findings. */
  readonly page: string;
  /** The page's file, relative to the source folder. */
  readonly file: string;
  /** Absolute site root: where `node_modules` lives for type-checking. */
  readonly root: string;
  /** Absolute source folder: where snippets and fixtures live. */
  readonly sourceDir: string;
  /** The locked limits. */
  readonly limits: SessionLimits;
  /** The allowlist a runbook's steps may use. Default `[]`, so a runbook with no allowlist refuses every step. */
  readonly allowlist?: readonly string[];
  /** The recorded run's provenance; absent during a plain check, which records nothing. */
  readonly provenance?: Pick<RecordedExampleResult, "date" | "commit">;
  /** The environment hash the run may cite; absent when the site is not locked. */
  readonly environment?: string;
  /** Type-check visible `ts`/`js` blocks before running them. Default `true`. */
  readonly typeCheck?: boolean;
  /** The `tsc` entry, for a test. Default the installed TypeScript. */
  readonly tsc?: string;
  /** Fail a failed example as an error. Default `false`, a warning. */
  readonly failOnFailure?: boolean;
  /** A result cache: a session whose inputs are unchanged replays its stored outcomes instead of running. */
  readonly cache?: ExampleCache;
}

/** Sorts by code point. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Reads every snippet the page's blocks name, returning the plan and any snippet findings. */
async function plan(options: RunPageOptions): Promise<{ blocks: PlannedBlock[]; diagnostics: Diagnostic[] }> {
  const blocks: PlannedBlock[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const example of options.examples) {
    if (example.snippet === undefined) {
      const lang = blockLangOf(example.lang);
      blocks.push({ example, code: example.code, lang, snippet: undefined, problem: undefined });
      continue;
    }
    const read = await loadSnippet({ snippet: example.snippet, sourceDir: options.sourceDir, example, file: options.file });
    diagnostics.push(...read.diagnostics);
    if (read.snippet === undefined) {
      blocks.push({ example, code: "", lang: undefined, snippet: undefined, problem: read.diagnostics[0] });
      continue;
    }
    blocks.push({ example, code: read.snippet.code, lang: blockLangOf(read.snippet.lang), snippet: read.snippet, problem: undefined });
  }
  // A declared id that repeats would make two blocks indistinguishable in the evidence; keep the first and report it.
  const seen = new Map<string, number>();
  for (const block of blocks) seen.set(block.example.id, (seen.get(block.example.id) ?? 0) + 1);
  for (const [id, count] of seen) {
    if (count > 1) {
      const first = blocks.find((block) => block.example.id === id)!.example;
      diagnostics.push({
        id: "example-duplicate-id",
        severity: "error",
        message: `${count} examples on ${options.page} use the id "${id}".`,
        pos: { file: options.file, line: first.pos.line, column: first.pos.column, endLine: first.pos.endLine, endColumn: first.pos.endColumn },
        help: 'Give each block a unique id="...", or remove the explicit ids and rely on the page order.',
      });
    }
  }
  return { blocks, diagnostics };
}

/** The expected text and match mode for one block's stream: `output` for stdout, `stderr` for stderr. */
function expectedOf(block: PlannedBlock): { stdout?: { text: string; match: OutputMatch }; stderr?: { text: string; match: OutputMatch } } {
  const { example } = block;
  return {
    ...(example.expected === null ? {} : { stdout: { text: example.expected, match: example.stdoutMatch ?? "exact" } }),
    ...(example.expectedStderr === undefined ? {} : { stderr: { text: example.expectedStderr, match: example.stderrMatch ?? "exact" } }),
  };
}

/** One block's result, built from its run outcome and the output comparisons. */
function resultOf(options: RunPageOptions, block: PlannedBlock, outcome: {
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly violation?: string;
  readonly sandboxed?: boolean;
}): { result: RecordedExampleResult; diagnostics: Diagnostic[] } {
  const { example } = block;
  const expected = expectedOf(block);
  const outputs: ExampleEvidenceOutput[] = [];
  const diagnostics: Diagnostic[] = [];
  let ok = outcome.exitCode === 0;

  const compare = (stream: "stdout" | "stderr", expectedText: { text: string; match: OutputMatch } | undefined, actual: string): void => {
    if (expectedText === undefined) {
      outputs.push({ stream, match: "exact", actual, ok: outcome.exitCode === 0 });
      return;
    }
    const matched = matchOutput(expectedText.text, actual, expectedText.match);
    outputs.push({ stream, match: expectedText.match, expected: matched.expected, actual: matched.actual, ok: matched.ok });
    if (!matched.ok) {
      if (ok) diagnostics.push(mismatchDiagnostic(options, example, options.file, stream, matched));
      ok = false;
    }
  };
  compare("stdout", expected.stdout, outcome.stdout);
  compare("stderr", expected.stderr, outcome.stderr);

  // A non-zero exit or a violation is reported once, at the fence, even when its output would also differ.
  if (outcome.exitCode !== 0 || outcome.violation !== undefined) {
    if (outcome.exitCode !== 0 && (expected.stdout === undefined || outcomesAgree(outputs))) {
      diagnostics.push(exitDiagnostic(options, example, options.file, outcome));
    }
  }

  const evidence: ExampleEvidence = {
    exitCode: outcome.exitCode,
    ...(outcome.violation === undefined || outcome.violation === "none" ? {} : { violation: outcome.violation }),
    outputs,
    ...(block.snippet === undefined ? {} : { snippet: { file: block.snippet.file, start: block.snippet.start, end: block.snippet.end, language: block.snippet.lang } }),
    ...(outcome.sandboxed === undefined ? {} : { sandboxed: outcome.sandboxed }),
    ...(example.session === undefined ? {} : { session: example.session }),
  };

  const provenance = options.provenance;
  const result: RecordedExampleResult = {
    status: ok ? "passed" : "failed",
    file: options.file,
    line: example.pos.line,
    language: block.lang === undefined ? example.lang : block.lang === "js" ? "js" : block.lang,
    // A plain check has no date or commit; the report reads it, but only a record writes it to the lock.
    date: provenance?.date ?? "",
    commit: provenance?.commit ?? "",
    sha256: exampleHash({ ...example, code: block.code }),
    exitCode: outcome.exitCode,
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    evidence,
  };
  return { result, diagnostics };
}

/** True when every output comparison the block made agrees; used to avoid a second finding for one failure. */
function outcomesAgree(outputs: readonly ExampleEvidenceOutput[]): boolean {
  return outputs.every((output) => output.ok);
}

/** A skipped result: a language with no runner, a hidden setup that does not produce evidence, or a snippet miss. */
function skipped(options: RunPageOptions, block: PlannedBlock, status: "skipped" | "sandbox-unavailable"): RecordedExampleResult {
  return {
    status,
    file: options.file,
    line: block.example.pos.line,
    language: block.example.lang,
    date: options.provenance?.date ?? "",
    commit: options.provenance?.commit ?? "",
    sha256: exampleHash(block.example),
    ...(options.environment === undefined ? {} : { environment: options.environment }),
  };
}

/** Groups blocks into sessions: the page default, or each declared session, in first-declared order. */
function sessionsOf(blocks: readonly PlannedBlock[]): Map<string, PlannedBlock[]> {
  const sessions = new Map<string, PlannedBlock[]>();
  for (const block of blocks) {
    const name = block.example.session ?? "";
    const list = sessions.get(name) ?? [];
    list.push(block);
    sessions.set(name, list);
  }
  return sessions;
}

/** The cache key of one session: its blocks' ids, languages, and code, plus the limits, in a fixed order. */
function sessionKey(blocks: readonly SessionBlock[], limits: SessionLimits): { code: string; lang: string; kind: string } {
  return {
    code: JSON.stringify(blocks.map((block) => ({ id: block.id, lang: block.lang, code: block.code }))),
    lang: "session",
    kind: `session:${limits.timeoutMs}:${limits.memoryMb}:${limits.network}`,
  };
}

/** Replays a stored session result when every input is unchanged; `undefined` on a miss. */
async function replaySession(cache: ExampleCache, blocks: readonly SessionBlock[], limits: SessionLimits): Promise<SessionResult | undefined> {
  const stored = await cache.get<SessionResult>(cache.key(sessionKey(blocks, limits)));
  return stored === undefined ? undefined : stored;
}

/** Stores a session result under its inputs, without timing fields, so a replay keeps the same bytes. */
async function storeSession(cache: ExampleCache, blocks: readonly SessionBlock[], limits: SessionLimits, result: SessionResult): Promise<void> {
  await cache.set(cache.key(sessionKey(blocks, limits)), result);
}

/**
 * Runs one page's examples. Snippets are read, types are checked, sessions and runbooks are executed, outputs are
 * compared, and the result and findings are returned. Nothing here throws for a failing example.
 */
export async function runPageExamples(options: RunPageOptions): Promise<PageRun> {
  const planned = await plan(options);
  const results = new Map<string, RecordedExampleResult>();
  const diagnostics: Diagnostic[] = [...planned.diagnostics];
  const runbooks: RunbookResult[] = [];

  // Type-check the visible Node blocks first, so a block that cannot compile is reported and never run.
  const failedTypeCheck = new Set<string>();
  if (options.typeCheck !== false) {
    for (const block of planned.blocks) {
      if (block.problem !== undefined || block.lang === undefined) continue;
      if (!typeCheckable(block.example.lang, block.example.role)) continue;
      const findings: ExampleTypeFinding[] = await typeCheckExample({
        example: { ...block.example, lang: block.example.lang, code: block.code },
        root: options.root,
        sourceDir: options.sourceDir,
        file: options.file,
        ...(options.tsc === undefined ? {} : { tsc: options.tsc }),
      });
      for (const finding of findings) {
        diagnostics.push(finding.id === "example-type-error" ? typeDiagnosticOf(finding, options.failOnFailure === true) : exampleTypeDiagnostic(finding));
        if (finding.id === "example-type-error") failedTypeCheck.add(block.example.id);
      }
    }
  }

  // The sandbox's availability is probed once, so a run without one reports it once and never claims isolation.
  const sandboxed = sessionSandboxAvailable();
  if (!sandboxed && planned.blocks.some((block) => block.lang !== undefined)) {
    diagnostics.push(exampleSandboxUnavailable(process.platform));
  }
  // Split the runbook steps out: they are a shell sequence with their own allowlist and their own result.
  const steps = planned.blocks.filter((block) => block.example.role === "step");
  const runnable = planned.blocks.filter((block) => block.example.role !== "step" && block.problem === undefined);
  for (const block of planned.blocks) {
    if (block.problem !== undefined) results.set(block.example.id, skippedWith(options, block));
  }

  if (steps.length > 0) {
    const runbookList: Runbook[] = groupRunbooks(steps, options.allowlist ?? []);
    for (const runbook of runbookList) {
      const outcome = await runRunbook(runbook, options.limits);
      runbooks.push(outcome);
      for (const step of outcome.steps) {
        const block = steps.find((candidate) => candidate.example.id === step.id)!;
        const ok = step.status === "passed";
        results.set(step.id, {
          status: ok ? "passed" : "failed",
          file: options.file,
          line: block.example.pos.line,
          language: "bash",
          date: options.provenance?.date ?? "",
          commit: options.provenance?.commit ?? "",
          sha256: exampleHash({ ...block.example, code: block.code }),
          exitCode: ok ? 0 : null,
          ...(options.environment === undefined ? {} : { environment: options.environment }),
          evidence: { exitCode: ok ? 0 : null, outputs: [], ...(block.example.runbook === undefined ? {} : { session: block.example.runbook }) },
        });
        if (!ok) diagnostics.push(runbookDiagnostic(options, block.example, options.file, step));
      }
      // A step that never ran because the runbook stopped is still reported, so the count is complete.
      for (const block of steps.filter((candidate) => !results.has(candidate.example.id))) {
        results.set(block.example.id, skipped(options, block, "skipped"));
      }
    }
  }

  for (const [session, blocks] of sessionsOf(runnable)) {
    // A block with no runner is skipped; it never enters a session.
    const runnableBlocks: PlannedBlock[] = [];
    for (const block of blocks) {
      if (block.lang === undefined) {
        results.set(block.example.id, skipped(options, block, "skipped"));
        continue;
      }
      if (failedTypeCheck.has(block.example.id)) {
        results.set(block.example.id, { ...skipped(options, block, "skipped"), status: "failed" });
        continue;
      }
      runnableBlocks.push(block);
    }
    if (runnableBlocks.length === 0) continue;

    const sessionBlocks: SessionBlock[] = runnableBlocks.map((block) => ({
      id: block.example.id,
      lang: block.lang!,
      // A setup or teardown block is hidden but still runs; its role does not change how the runner treats it.
      code: block.code,
    }));
    const limits: SessionLimits = { timeoutMs: options.limits.timeoutMs, memoryMb: options.limits.memoryMb, network: options.limits.network };
    // The cache key covers every input that changes what the session does: its blocks, its language, and its limits. A
    // hit replays the stored block outcomes, so a hit and a fresh run produce the same evidence (#1335).
    const sessionKeyInput: SessionBlock[] = sessionBlocks;
    const stored = options.cache === undefined
      ? undefined
      : await replaySession(options.cache, sessionKeyInput, limits);
    const outcome = stored ?? await runSession({ blocks: sessionBlocks, limits, stopOnFailure: true });
    if (options.cache !== undefined && stored === undefined) {
      await storeSession(options.cache, sessionKeyInput, limits, outcome);
    }
    for (const blockResult of outcome.blocks) {
      const block = runnableBlocks.find((candidate) => candidate.example.id === blockResult.id)!;
      // A hidden setup or teardown block still runs, but it has no public expected output to compare.
      const built = resultOf(options, block, {
        ok: blockResult.ok,
        exitCode: blockResult.exitCode,
        stdout: blockResult.stdout,
        stderr: blockResult.stderr,
        ...(blockResult.violation === "none" ? {} : { violation: blockResult.violation }),
        sandboxed: blockResult.sandboxed,
      });
      results.set(block.example.id, built.result);
      diagnostics.push(...built.diagnostics);
    }
    // A block the runner never reached, because the session stopped at an earlier failure, is reported as not run.
    for (const block of runnableBlocks.filter((candidate) => !results.has(candidate.example.id))) {
      results.set(block.example.id, skipped(options, block, "skipped"));
    }
  }

  // Every block on the page has a result: a failure to reach one is `skipped`, never silently absent.
  for (const block of planned.blocks) {
    if (!results.has(block.example.id)) results.set(block.example.id, skipped(options, block, "skipped"));
  }

  return {
    results: new Map([...results].sort((a, b) => byCodePoint(a[0], b[0]))),
    diagnostics,
    runbooks,
  };
}

/** A skipped result for a block whose snippet could not be read: it is `failed`, because the page asked it to run. */
function skippedWith(options: RunPageOptions, block: PlannedBlock): RecordedExampleResult {
  return { ...skipped(options, block, "skipped"), status: "failed" };
}

/** Groups `step` blocks by their runbook name, with the allowlist they share. */
function groupRunbooks(steps: readonly PlannedBlock[], allowlist: readonly string[]): Runbook[] {
  const byName = new Map<string, PlannedBlock[]>();
  for (const block of steps) {
    const name = block.example.runbook ?? "default";
    const list = byName.get(name) ?? [];
    list.push(block);
    byName.set(name, list);
  }
  return [...byName].map(([name, blocks]) => ({
    name,
    allowed: allowlist,
    steps: blocks.map((block) => ({
      id: block.example.id,
      command: block.code,
      ...(block.example.precondition === undefined ? {} : { precondition: block.example.precondition }),
      ...(block.example.expected === null ? {} : { expected: block.example.expected }),
      ...(block.example.stdoutMatch === undefined ? {} : { expectedMatch: block.example.stdoutMatch }),
    })),
  }));
}
