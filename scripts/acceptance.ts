/**
 * The release acceptance gate. It validates `release/scope.json`, runs every case a shipped feature names through the
 * `mizzen` binary, and fails when a case is missing, unknown, unrun, or failed. In `--release` mode it also requires the
 * candidate commit and the exact tarball's SHA-256, so the publish job cannot pass on another artifact, and it writes
 * the candidate, digest, case ids, and results to the CI step summary.
 *
 * Usage: node scripts/acceptance.ts [--scope release/scope.json] [--mizzen bin/mizzen.js] [--case <id>] [--json]
 *        [--release --candidate <sha> --digest <sha256> --tarball <file>] [--summary <file>]
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CASES, type AcceptanceCase, type CaseContext, type RunResult } from "./acceptance/cases.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** One feature the release either ships or defers with a reason. */
export interface ScopeFeature {
  readonly id: string;
  readonly title: string;
  readonly status: "shipped" | "deferred";
  readonly case?: string;
  readonly reason?: string;
}

/** The release scope: every milestone feature and what proves it is usable. */
export interface Scope {
  readonly version: string;
  readonly features: readonly ScopeFeature[];
}

/** Reads the scope JSON; `problems` explains a file that is not the shape this gate reads. */
export function parseScope(text: string): { scope?: Scope; problems: readonly string[] } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { problems: [`the scope is not JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { problems: ["the scope must be an object"] };
  const record = value as Record<string, unknown>;
  return { scope: { version: String(record.version ?? ""), features: Array.isArray(record.features) ? (record.features as ScopeFeature[]) : [] }, problems: [] };
}

/**
 * Why `scope` cannot gate a release. Every rule fails closed: a feature without a status, a shipped feature without a
 * known case, a case no shipped feature runs, a deferred feature without a reason, or a deferred feature the changelog
 * announces as shipped.
 */
export function validateScope(scope: Scope, caseIds: readonly string[], changelog: string): readonly string[] {
  const problems: string[] = [];
  if (scope.version.trim() === "") problems.push("the scope has no version");
  if (scope.features.length === 0) problems.push("the scope has no features");
  const known = new Set(caseIds);
  const used = new Set<string>();
  const ids = new Set<string>();
  for (const raw of scope.features) {
    if (typeof raw !== "object" || raw === null) {
      problems.push("a feature is not an object");
      continue;
    }
    const feature = raw;
    const label = typeof feature.id === "string" && feature.id !== "" ? feature.id : "<without id>";
    if (typeof feature.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(feature.id)) problems.push(`${label}: id must be lowercase words joined by dashes`);
    if (ids.has(feature.id)) problems.push(`${label}: the id appears twice`);
    ids.add(feature.id);
    if (typeof feature.title !== "string" || feature.title.trim() === "") problems.push(`${label}: title is missing`);
    if (feature.status !== "shipped" && feature.status !== "deferred") {
      problems.push(`${label}: status must be shipped or deferred`);
      continue;
    }
    if (feature.status === "shipped") {
      if (typeof feature.case !== "string" || feature.case === "") problems.push(`${label}: a shipped feature needs a case id`);
      else if (!known.has(feature.case)) problems.push(`${label}: unknown case ${feature.case}`);
      else used.add(feature.case);
    } else {
      if (typeof feature.reason !== "string" || feature.reason.trim() === "") problems.push(`${label}: a deferred feature needs a reason`);
      if (mentions(changelog, feature, scope.version)) problems.push(`${label}: a deferred feature appears in the changelog as shipped`);
    }
  }
  for (const id of caseIds) if (!used.has(id)) problems.push(`case ${id}: no shipped feature runs it`);
  return problems;
}

/** Whether the changelog announces `feature` in the release being cut. */
function mentions(changelog: string, feature: ScopeFeature, version: string): boolean {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sections = changelog.split(/^## /m).filter((section) => /^Unreleased\b/.test(section) || new RegExp(`^${escaped}\\b`).test(section));
  const text = sections.join("\n").toLowerCase();
  const needles = [feature.id, feature.id.replace(/-/g, " "), feature.title.toLowerCase()];
  return needles.some((needle) => needle.trim() !== "" && text.includes(needle));
}

/** Why `--release` inputs cannot name one artifact. */
export function releaseProblems(options: {
  readonly release: boolean;
  readonly candidate?: string;
  readonly digest?: string;
  readonly tarball?: string;
  readonly scopeVersion: string;
  readonly packageVersion?: string;
}): readonly string[] {
  if (!options.release) return [];
  const problems: string[] = [];
  if (options.candidate === undefined || !/^[0-9a-fA-F]{7,40}$/.test(options.candidate)) {
    problems.push("--release needs --candidate <git commit>");
  }
  if (options.digest === undefined || !/^[0-9a-f]{64}$/.test(options.digest)) problems.push("--release needs --digest <sha256 of the tarball>");
  if (options.tarball === undefined || !existsSync(options.tarball)) problems.push("--release needs --tarball <file>");
  else if (options.digest !== undefined) {
    const actual = digestOf(options.tarball);
    if (actual !== options.digest) problems.push(`the tarball's SHA-256 is ${actual}, not the candidate digest ${options.digest}`);
  }
  if (options.packageVersion !== undefined && options.packageVersion !== options.scopeVersion) {
    problems.push(`the scope is ${options.scopeVersion}, but package.json is ${options.packageVersion}`);
  }
  return problems;
}

/** The SHA-256 of a file, lowercase hexadecimal. */
export function digestOf(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** What one case did. */
export interface CaseResult {
  readonly id: string;
  readonly ok: boolean;
  readonly detail?: string | undefined;
}

/** The CI summary: the candidate, the artifact, and every case with its result. */
export function summaryOf(options: {
  readonly scope: Scope;
  readonly candidate?: string;
  readonly digest?: string;
  readonly results: readonly CaseResult[];
  readonly problems: readonly string[];
}): string {
  const lines = ["## Release acceptance", ""];
  if (options.candidate !== undefined) lines.push(`- Candidate: \`${options.candidate}\``);
  if (options.digest !== undefined) lines.push(`- Tarball SHA-256: \`${options.digest}\``);
  lines.push(`- Scope: \`${options.scope.version}\`, ${options.scope.features.length} features`, "");
  if (options.problems.length > 0) {
    lines.push("### Blocked", "");
    for (const problem of options.problems) lines.push(`- ${problem}`);
    lines.push("");
  }
  lines.push("| Case | Result | Detail |", "| --- | --- | --- |");
  for (const result of options.results) {
    lines.push(`| \`${result.id}\` | ${result.ok ? "pass" : "fail"} | ${result.detail ?? ""} |`);
  }
  return `${lines.join("\n")}\n`;
}

/** A value after the flag, or the flag itself when it takes none. */
function value(argv: readonly string[], index: number, flag: string): string {
  const next = argv[index];
  if (next === undefined || next.startsWith("-")) throw new Error(`${flag} needs a value`);
  return next;
}

/** Spawns the CLI under test with `process.execPath`, so a JavaScript, TypeScript, or installed shim all work. */
function runner(bin: string): CaseContext["mizzen"] {
  return (args, cwd): RunResult => {
    const result = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
    return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
}

/** Runs the gate; returns the exit code and writes the summary when asked. */
export async function run(argv: readonly string[]): Promise<number> {
  let scopePath = join(ROOT, "release/scope.json");
  let bin = join(ROOT, "bin/mizzen.js");
  let only: string | undefined;
  let release = false;
  let candidate: string | undefined;
  let digest: string | undefined;
  let tarball: string | undefined;
  let summary: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--scope") scopePath = resolve(value(argv, ++i, arg));
    else if (arg === "--mizzen") bin = resolve(value(argv, ++i, arg));
    else if (arg === "--case") only = value(argv, ++i, arg);
    else if (arg === "--release") release = true;
    else if (arg === "--candidate") candidate = value(argv, ++i, arg);
    else if (arg === "--digest") digest = value(argv, ++i, arg);
    else if (arg === "--tarball") tarball = resolve(value(argv, ++i, arg));
    else if (arg === "--summary") summary = resolve(value(argv, ++i, arg));
    else if (arg === "--json") json = true;
    else throw new Error(`unknown option: ${arg}`);
  }

  const parsed = parseScope(readFileSync(scopePath, "utf8"));
  const scope = parsed.scope ?? { version: "", features: [] };
  const caseIds = CASES.map((entry) => entry.id);
  const problems = [
    ...parsed.problems,
    ...validateScope(scope, caseIds, readFileSync(join(ROOT, "CHANGELOG.md"), "utf8")),
    ...releaseProblems({
      release,
      ...(candidate === undefined ? {} : { candidate }),
      ...(digest === undefined ? {} : { digest }),
      ...(tarball === undefined ? {} : { tarball }),
      scopeVersion: scope.version,
      ...(release ? { packageVersion: (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version } : {}),
    }),
  ];
  const required = [...new Set(scope.features.filter((feature) => feature.status === "shipped" && typeof feature.case === "string").map((feature) => feature.case!))];
  if (only !== undefined && !caseIds.includes(only)) problems.push(`--case ${only}: unknown case`);
  if (only !== undefined && release) problems.push("--case cannot narrow a release run");
  const selected = only === undefined ? required : [only];

  const results: CaseResult[] = [];
  if (problems.length === 0) {
    const base = mkdtempSync(join(tmpdir(), "mizzen-acceptance-"));
    try {
      for (const id of selected) {
        const entry = CASES.find((candidateCase) => candidateCase.id === id) as AcceptanceCase;
        const dir = join(base, id);
        mkdirSync(dir, { recursive: true });
        try {
          entry.run({ dir, mizzen: runner(bin) });
          results.push({ id, ok: true });
        } catch (error) {
          results.push({ id, ok: false, detail: error instanceof Error ? error.message.split("\n")[0] : String(error) });
        }
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
    for (const result of results) if (!result.ok) problems.push(`case ${result.id} failed: ${result.detail ?? ""}`);
  }

  const text = summaryOf({
    scope,
    ...(candidate === undefined ? {} : { candidate }),
    ...(digest === undefined ? {} : { digest }),
    results,
    problems,
  });
  if (summary !== undefined) appendFileSync(summary, text);
  if (json) process.stdout.write(`${JSON.stringify({ candidate, digest, cases: results, problems }, null, 2)}\n`);
  else process.stdout.write(text);
  return problems.length === 0 && results.every((result) => result.ok) ? 0 : 1;
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  run(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error: unknown) => {
    process.stderr.write(`mizzen acceptance: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}
