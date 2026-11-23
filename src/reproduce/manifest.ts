/**
 * The build diagnostic manifest: a versioned record of what a build read, how it was configured, which tools and
 * environment produced it, and which publishable files it wrote. Two records are compared by their categories so a
 * difference names its cause, and a difference no input, config, tool, or environment value explains is flagged.
 *
 * Paths are relative to the site root or the output folder with `/` separators, so moving a checkout changes nothing.
 * Content comes from `canonicalJson`, hashes from `output.build-hash`, and the output list is the same fingerprint
 * `mizzen verify` checks. Rule values and redirect destinations are fingerprinted, so a token or credential in the
 * config can only change a hash, never the report text.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { loadConfig } from "../config/load.ts";
import { discover } from "../content/discover.ts";
import { canonicalJson } from "../data/lock.ts";
import { EVIDENCE_LOCK_FILE } from "../evidence/store.ts";
import { version } from "../index.ts";
import { fingerprint, hashOf, isIdentityPath } from "../outputs/build-hash.ts";
import type { SiteConfig } from "../contracts/index.ts";

/** The report format this version writes and reads. */
export const BUILD_REPORT_FORMAT = 1;

/** The Mizzen release that introduced each format, so a rejected record names a compatible version. */
export const BUILD_REPORT_VERSIONS: Readonly<Record<number, string>> = Object.freeze({ 1: "0.2.5" });

/** Where `mizzen build --diagnose` writes the report, relative to the site root. */
export const BUILD_REPORT_PATH = ".mizzen/build-report.json";

/** The categories two reports are compared by, in the order a report lists them. */
export const BUILD_REPORT_CATEGORIES = ["inputs", "config", "tools", "environment", "outputs"] as const;

export type BuildReportCategory = (typeof BUILD_REPORT_CATEGORIES)[number];

/** One file identity: a path relative to its root, and the SHA-256 of its bytes. */
export interface InputFile {
  readonly path: string;
  readonly sha256: string;
}

/** SHA-256 of one canonical rule value, stored instead of the value itself. */
export interface RuleFingerprint {
  readonly sha256: string;
}

/** The rule-bearing part of the effective config, with every rule value fingerprinted. */
export interface ConfigRules {
  readonly defaults: readonly { readonly path: string; readonly keys: readonly string[] }[];
  readonly redirects: Readonly<Record<string, string>>;
  readonly outputs: Readonly<Record<string, boolean>>;
  readonly collections: Readonly<Record<string, {
    readonly transform?: RuleFingerprint;
    readonly derived?: Readonly<Record<string, string>>;
    readonly referenceDate?: string;
  }>>;
  readonly quality?: RuleFingerprint;
  readonly feeds: readonly string[];
  readonly calendars: readonly string[];
}

/** The effective configuration: its hash, its reference date, and the rules that shape output. */
export interface EffectiveConfig {
  readonly sha256: string;
  readonly referenceDate?: string;
  readonly rules: ConfigRules;
}

/** The tools that produced the build, as the actual environment reports them. */
export interface BuildTools {
  readonly mizzen: string;
  readonly node: string;
  readonly theme: { readonly name: string; readonly version: string };
}

/** Environment values that can change what a build writes. */
export interface BuildEnvironment {
  readonly timezone: string;
  readonly locale: string;
  readonly lang?: string;
  readonly sourceDateEpoch?: string;
}

/** The versioned build diagnostic manifest. */
export interface BuildReport {
  readonly format: number;
  readonly categories: readonly BuildReportCategory[];
  readonly inputs: {
    readonly lock?: InputFile;
    readonly locks: Readonly<Record<string, string>>;
    readonly data: Readonly<Record<string, string>>;
    readonly content: Readonly<Record<string, string>>;
  };
  readonly config: EffectiveConfig;
  readonly tools: BuildTools;
  readonly environment: BuildEnvironment;
  readonly outputs: {
    readonly hash: string;
    readonly files: Readonly<Record<string, string>>;
  };
}

/** One difference: the category, the path or field, and the two values when both sides have one. */
export interface BuildDifference {
  readonly path: string;
  readonly before?: string;
  readonly after?: string;
}

/** A comparison, grouped by the category the difference belongs to. */
export interface BuildComparison {
  /** True when no category differs. */
  readonly same: boolean;
  readonly differences: Readonly<Record<BuildReportCategory, readonly BuildDifference[]>>;
  /** True when the outputs differ while every declared input, config, tool, and environment value matches. */
  readonly unexplained: boolean;
}

/** One reason a build cannot be reproduced here, before it runs. */
export interface PreflightProblem {
  readonly category: BuildReportCategory;
  readonly message: string;
  /** A warning does not stop the build; an error does. */
  readonly fatal: boolean;
}

/** What {@link preflightReport} found. */
export interface Preflight {
  readonly ok: boolean;
  readonly problems: readonly PreflightProblem[];
}

export interface BuildReportOptions {
  /** Absolute site root. */
  readonly root: string;
  /** Absolute folder the build wrote. */
  readonly out: string;
  /** Absolute theme root, when one was used. */
  readonly themeRoot?: string;
  /** The effective as-of date, after `--as-of` won over the config. */
  readonly asOf?: string;
  /** The effective base, after `--base` won over the config. */
  readonly base?: string;
}

function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A path relative to `root`, with `/` separators, or `undefined` when it leaves the root. */
function relativePath(root: string, path: string): string | undefined {
  const rel = relative(root, path).split(sep).join("/");
  return rel === "" || rel === ".." || rel.startsWith("../") || isAbsolute(rel) ? undefined : rel;
}

/** SHA-256 of a file, or `undefined` when it cannot be read. */
async function hashFile(path: string): Promise<string | undefined> {
  try {
    return hashOf(await readFile(path));
  } catch {
    return undefined;
  }
}

/** The rule-bearing config, with every value that could carry a secret replaced by its SHA-256. */
export function rulesOf(config: SiteConfig): ConfigRules {
  const collections: Record<string, { transform?: RuleFingerprint; derived?: Readonly<Record<string, string>>; referenceDate?: string }> = {};
  const fingerprintRule = (value: unknown): string => hashOf(canonicalJson(value));
  for (const name of Object.keys(config.collections).sort(byCodePoint)) {
    const entry = config.collections[name]!;
    const rules: { transform?: RuleFingerprint; derived?: Readonly<Record<string, string>>; referenceDate?: string } = {};
    if (entry.transform !== undefined) rules.transform = { sha256: fingerprintRule(entry.transform) };
    if (entry.derived !== undefined) {
      rules.derived = Object.fromEntries(Object.entries(entry.derived).map(([field, rule]) => [field, fingerprintRule(rule)]));
    }
    if (entry.referenceDate !== undefined) rules.referenceDate = entry.referenceDate;
    if (Object.keys(rules).length > 0) collections[name] = rules;
  }
  return {
    defaults: config.defaults.map((entry) => ({ path: entry.path, keys: Object.keys(entry.values).sort(byCodePoint) })),
    redirects: Object.fromEntries(Object.entries(config.redirects).map(([from, to]) => [from, fingerprintRule(to)])),
    outputs: config.outputs,
    collections,
    ...(config.quality === undefined ? {} : { quality: { sha256: fingerprintRule(config.quality) } }),
    feeds: Object.keys(config.feeds).sort(byCodePoint),
    calendars: Object.keys(config.calendars ?? {}).sort(byCodePoint),
  };
}

/** SHA-256 of the resolved config, so two effective configs compare in one value. */
export function configHashOf(config: SiteConfig): string {
  return hashOf(canonicalJson(config));
}

/** The theme's package name and version, or a package-free label; never an absolute path. */
async function toolsOf(themeRoot: string | undefined): Promise<BuildTools> {
  let theme: { name: string; version: string } = { name: "custom", version: "" };
  if (themeRoot !== undefined) {
    try {
      const parsed = JSON.parse(await readFile(join(themeRoot, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
      if (typeof parsed.name === "string" && parsed.name !== "") {
        theme = { name: parsed.name, version: typeof parsed.version === "string" ? parsed.version : "" };
      }
    } catch {
      // A folder theme without a package file still has an identity: its renderer is the engine itself.
    }
  }
  return { mizzen: version, node: process.versions.node, theme };
}

/** The environment the build actually ran in, as the runtime reports it. */
export function environmentOf(): BuildEnvironment {
  const resolved = new Intl.DateTimeFormat().resolvedOptions();
  const lang = process.env.LANG;
  const sourceDateEpoch = process.env.SOURCE_DATE_EPOCH;
  return {
    timezone: resolved.timeZone ?? "UTC",
    locale: resolved.locale ?? "en-US",
    ...(lang === undefined || lang === "" ? {} : { lang }),
    ...(sourceDateEpoch === undefined || sourceDateEpoch === "" ? {} : { sourceDateEpoch }),
  };
}

/** Lock files whose bytes change what a build reads. */
const LOCK_FILES = ["mizzen.lock.json", "urls.lock.json", "blocks.lock.json", EVIDENCE_LOCK_FILE] as const;

/**
 * Reads the site and the built folder and returns the report. The site root and output folder are only read, never
 * written; `writeBuildReport` writes the result.
 */
export async function buildReportOf(options: BuildReportOptions): Promise<BuildReport> {
  const root = resolve(options.root);
  const out = resolve(options.out);
  const loaded = loadConfig(root);
  const config: SiteConfig = {
    ...loaded.config,
    ...(options.asOf === undefined ? {} : { asOf: options.asOf }),
    ...(options.base === undefined ? {} : { base: options.base }),
  };
  const sourceDir = resolve(root, config.source);

  const locks: Record<string, string> = {};
  let lock: InputFile | undefined;
  for (const name of LOCK_FILES) {
    const digest = await hashFile(join(root, name));
    if (digest === undefined) continue;
    locks[name] = digest;
    if (name === "mizzen.lock.json") lock = { path: name, sha256: digest };
  }

  const data: Record<string, string> = {};
  for (const name of Object.keys(config.collections).sort(byCodePoint)) {
    const source = config.collections[name]!.source;
    if (/^[a-z][a-z\d+.-]*:/i.test(source)) continue;
    const path = resolve(root, source);
    const rel = relativePath(root, path);
    if (rel === undefined) continue;
    const digest = await hashFile(path);
    if (digest !== undefined) data[rel] = digest;
  }

  const content: Record<string, string> = {};
  try {
    const files = await discover(sourceDir, { include: config.include, exclude: config.exclude });
    for (const file of files) {
      const digest = await hashFile(join(sourceDir, file.path));
      if (digest !== undefined) content[file.path] = digest;
    }
  } catch {
    // A source folder that cannot be read is a build error elsewhere; the report still records what it could see.
  }
  const outputs = await fingerprint(out);

  return {
    format: BUILD_REPORT_FORMAT,
    categories: BUILD_REPORT_CATEGORIES,
    inputs: { ...(lock === undefined ? {} : { lock }), locks, data, content },
    config: {
      sha256: configHashOf(config),
      ...(config.asOf === undefined ? {} : { referenceDate: config.asOf }),
      rules: rulesOf(config),
    },
    tools: await toolsOf(options.themeRoot),
    environment: environmentOf(),
    outputs: { hash: outputs.hash, files: outputs.files },
  };
}

/** The report as bytes: two-space JSON, sorted by construction, and one trailing line feed. */
export function buildReportText(report: BuildReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/** Writes `file`, creating its folder, after the report is fully formed. */
export async function writeBuildReport(file: string, report: BuildReport): Promise<void> {
  const target = resolve(file);
  await mkdir(resolve(target, ".."), { recursive: true });
  await writeFile(target, buildReportText(report));
}

const HASH = /^[0-9a-f]{64}$/;

function isHash(value: unknown): value is string {
  return typeof value === "string" && HASH.test(value);
}

function isFileMap(value: unknown): value is Readonly<Record<string, string>> {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(([path, hash]) => isIdentityPath(path) && isHash(hash));
}

function isRules(value: unknown): value is ConfigRules {
  const fingerprint = (entry: unknown): boolean =>
    isRecord(entry) && Object.keys(entry).length === 1 && isHash(entry["sha256"]);
  if (!isRecord(value)) return false;
  if (Object.keys(value).some((key) => !["defaults", "redirects", "outputs", "collections", "quality", "feeds", "calendars"].includes(key))) return false;
  if (!Array.isArray(value["defaults"])) return false;
  if (!value["defaults"].every((entry) => isRecord(entry) && Object.keys(entry).length === 2 && typeof entry["path"] === "string" && Array.isArray(entry["keys"]) && entry["keys"].every((key) => typeof key === "string"))) return false;
  if (!isRecord(value["redirects"]) || !Object.values(value["redirects"]).every((to) => isHash(to))) return false;
  if (!isRecord(value["outputs"]) || !Object.values(value["outputs"]).every((on) => typeof on === "boolean")) return false;
  if (!isRecord(value["collections"]) || !Object.values(value["collections"]).every((entry) => {
    if (!isRecord(entry)) return false;
    if (Object.keys(entry).some((key) => key !== "transform" && key !== "derived" && key !== "referenceDate")) return false;
    if (entry["transform"] !== undefined && !fingerprint(entry["transform"])) return false;
    if (entry["derived"] !== undefined && (!isRecord(entry["derived"]) || !Object.values(entry["derived"]).every((hash) => isHash(hash)))) return false;
    return entry["referenceDate"] === undefined || (typeof entry["referenceDate"] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(entry["referenceDate"]));
  })) return false;
  if (value["quality"] !== undefined && !fingerprint(value["quality"])) return false;
  if (!Array.isArray(value["feeds"]) || !value["feeds"].every((name) => typeof name === "string")) return false;
  if (!Array.isArray(value["calendars"]) || !value["calendars"].every((name) => typeof name === "string")) return false;
  return true;
}

/** Why `value` is not a report this version may compare, or `undefined` when it is one. */
export function validateBuildReport(value: unknown): string | undefined {
  if (!isRecord(value)) return "the build report must be a JSON object";
  const keys = ["format", "categories", "inputs", "config", "tools", "environment", "outputs"];
  if (Object.keys(value).sort(byCodePoint).join(",") !== keys.slice().sort(byCodePoint).join(",")) {
    return `the build report must hold exactly ${keys.join(", ")}`;
  }
  if (typeof value["format"] !== "number" || !Number.isInteger(value["format"]) || value["format"] < 1) {
    return "format must be a whole number of at least 1";
  }
  if (value["format"] !== BUILD_REPORT_FORMAT) {
    return `format ${value["format"]} is not the format this version reads (${BUILD_REPORT_FORMAT})`;
  }
  const categories = value["categories"];
  if (!Array.isArray(categories) || categories.length !== BUILD_REPORT_CATEGORIES.length) {
    return `categories must name exactly ${BUILD_REPORT_CATEGORIES.join(", ")}`;
  }
  if (categories.some((category, index) => category !== BUILD_REPORT_CATEGORIES[index])) {
    return `categories must be ${BUILD_REPORT_CATEGORIES.join(", ")} in that order`;
  }

  const inputs = value["inputs"];
  if (!isRecord(inputs)) return "inputs must be an object";
  if (inputs["lock"] !== undefined) {
    const lock = inputs["lock"];
    if (!isRecord(lock) || typeof lock["path"] !== "string" || !isHash(lock["sha256"])) return "inputs.lock must hold a path and a SHA-256";
  }
  if (!isRecord(inputs["locks"]) || !isFileMap(inputs["locks"])) return "inputs.locks must map lock paths to SHA-256 values";
  if (!isFileMap(inputs["data"])) return "inputs.data must map site paths to SHA-256 values";
  if (!isFileMap(inputs["content"])) return "inputs.content must map source paths to SHA-256 values";

  const config = value["config"];
  if (!isRecord(config) || !isHash(config["sha256"])) return "config.sha256 must be a SHA-256";
  if (config["referenceDate"] !== undefined && (typeof config["referenceDate"] !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(config["referenceDate"]))) {
    return "config.referenceDate must be YYYY-MM-DD";
  }
  if (!isRules(config["rules"])) return "config.rules must hold the rule sections this format records";

  const tools = value["tools"];
  if (!isRecord(tools) || typeof tools["mizzen"] !== "string" || typeof tools["node"] !== "string") return "tools must name the Mizzen and Node versions";
  const theme = tools["theme"];
  if (!isRecord(theme) || typeof theme["name"] !== "string" || typeof theme["version"] !== "string") return "tools.theme must name a theme and its version";

  const environment = value["environment"];
  if (!isRecord(environment) || typeof environment["timezone"] !== "string" || typeof environment["locale"] !== "string") {
    return "environment must name the time zone and locale";
  }
  for (const key of ["lang", "sourceDateEpoch"]) {
    if (environment[key] !== undefined && typeof environment[key] !== "string") return `environment.${key} must be a string`;
  }

  const outputs = value["outputs"];
  if (!isRecord(outputs) || !isHash(outputs["hash"]) || !isFileMap(outputs["files"])) return "outputs must hold a build hash and relative file hashes";
  return undefined;
}

/** True when `value` is a report this version may compare. */
export function isBuildReport(value: unknown): value is BuildReport {
  return validateBuildReport(value) === undefined;
}

/** A report read from a file, or why it cannot be used. */
export type ReadBuildReport =
  | { readonly report: BuildReport }
  | { readonly error: string };

/** Reads and validates one report; a missing file or a malformed report is one clear error. */
export async function readBuildReport(file: string): Promise<ReadBuildReport> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return { error: `"${file}" cannot be read.` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: `"${file}" is not valid JSON.` };
  }
  const problem = validateBuildReport(parsed);
  if (problem !== undefined) return { error: `"${file}" is not a build report: ${problem}.` };
  return { report: parsed as BuildReport };
}

/** Adds a difference when the two values differ. */
function valueDifference(out: BuildDifference[], path: string, before: unknown, after: unknown): void {
  if (before === after) return;
  out.push({
    path,
    ...(typeof before === "string" ? { before } : {}),
    ...(typeof after === "string" ? { after } : {}),
  });
}

/** Compares two file maps, naming every added, removed, and changed path. */
function fileDifferences(out: BuildDifference[], prefix: string, before: Readonly<Record<string, string>>, after: Readonly<Record<string, string>>): void {
  for (const path of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort(byCodePoint)) {
    const was = before[path];
    const now = after[path];
    if (was === now) continue;
    out.push({ path: `${prefix}${path}`, ...(was === undefined ? {} : { before: was }), ...(now === undefined ? {} : { after: now }) });
  }
}

/** Compares two reports, grouped by category, and flags output differences nothing else explains. */
export function compareBuildReports(before: BuildReport, after: BuildReport): BuildComparison {
  const inputs: BuildDifference[] = [];
  const config: BuildDifference[] = [];
  const tools: BuildDifference[] = [];
  const environment: BuildDifference[] = [];
  const outputs: BuildDifference[] = [];

  valueDifference(inputs, "lock", before.inputs.lock?.sha256, after.inputs.lock?.sha256);
  fileDifferences(inputs, "locks/", before.inputs.locks, after.inputs.locks);
  fileDifferences(inputs, "data/", before.inputs.data, after.inputs.data);
  fileDifferences(inputs, "content/", before.inputs.content, after.inputs.content);

  valueDifference(config, "sha256", before.config.sha256, after.config.sha256);
  valueDifference(config, "referenceDate", before.config.referenceDate, after.config.referenceDate);
  if (canonicalJson(before.config.rules) !== canonicalJson(after.config.rules)) {
    config.push({ path: "rules", before: canonicalJson(before.config.rules), after: canonicalJson(after.config.rules) });
  }

  valueDifference(tools, "mizzen", before.tools.mizzen, after.tools.mizzen);
  valueDifference(tools, "node", before.tools.node, after.tools.node);
  valueDifference(tools, "theme.name", before.tools.theme.name, after.tools.theme.name);
  valueDifference(tools, "theme.version", before.tools.theme.version, after.tools.theme.version);

  valueDifference(environment, "timezone", before.environment.timezone, after.environment.timezone);
  valueDifference(environment, "locale", before.environment.locale, after.environment.locale);
  valueDifference(environment, "lang", before.environment.lang, after.environment.lang);
  valueDifference(environment, "sourceDateEpoch", before.environment.sourceDateEpoch, after.environment.sourceDateEpoch);

  if (before.outputs.hash !== after.outputs.hash) outputs.push({ path: "hash", before: before.outputs.hash, after: after.outputs.hash });
  fileDifferences(outputs, "", before.outputs.files, after.outputs.files);

  const differences = { inputs, config, tools, environment, outputs };
  const same = BUILD_REPORT_CATEGORIES.every((category) => differences[category].length === 0);
  const explained = differences.inputs.length + differences.config.length + differences.tools.length + differences.environment.length > 0;
  return { same, differences, unexplained: differences.outputs.length > 0 && !explained };
}

/** The optional theme's actual package version, for preflight. */
async function currentTools(themeRoot: string | undefined): Promise<BuildTools> {
  return toolsOf(themeRoot);
}

/**
 * Checks whether `target` can be reproduced from the current site before anything is built: the report format, the
 * actual tool versions, the effective config, and every declared input's presence and bytes. Environment differences
 * are warnings; everything else stops the build because the output cannot match.
 */
export async function preflightReport(
  target: BuildReport,
  options: { readonly root: string; readonly themeRoot?: string; readonly asOf?: string; readonly base?: string },
): Promise<Preflight> {
  const problems: PreflightProblem[] = [];
  const root = resolve(options.root);
  const current = await currentTools(options.themeRoot);
  if (target.tools.mizzen !== current.mizzen) {
    problems.push({ category: "tools", message: `the report was built with Mizzen ${target.tools.mizzen}, but this is ${current.mizzen}`, fatal: true });
  }
  if (target.tools.node.split(".")[0] !== current.node.split(".")[0]) {
    problems.push({ category: "tools", message: `the report was built with Node ${target.tools.node}, but this is ${current.node}`, fatal: true });
  }
  if (target.tools.theme.name !== current.theme.name || target.tools.theme.version !== current.theme.version) {
    problems.push({
      category: "tools",
      message: `the report was built with theme ${target.tools.theme.name} ${target.tools.theme.version || "(no version)"}, but this is ${current.theme.name} ${current.theme.version || "(no version)"}`,
      fatal: true,
    });
  }

  const loaded = loadConfig(root);
  const config: SiteConfig = {
    ...loaded.config,
    ...(options.asOf === undefined ? {} : { asOf: options.asOf }),
    ...(options.base === undefined ? {} : { base: options.base }),
  };
  if (configHashOf(config) !== target.config.sha256) {
    problems.push({ category: "config", message: "the effective configuration does not match the report", fatal: true });
  }

  for (const [path, hash] of Object.entries(target.inputs.locks).sort(([a], [b]) => byCodePoint(a, b))) {
    const actual = await hashFile(join(root, path));
    if (actual === undefined) problems.push({ category: "inputs", message: `missing lock file ${path}`, fatal: true });
    else if (actual !== hash) problems.push({ category: "inputs", message: `lock file ${path} differs from the report`, fatal: true });
  }
  for (const [path, hash] of Object.entries(target.inputs.data).sort(([a], [b]) => byCodePoint(a, b))) {
    const actual = await hashFile(join(root, path));
    if (actual === undefined) problems.push({ category: "inputs", message: `missing data input ${path}`, fatal: true });
    else if (actual !== hash) problems.push({ category: "inputs", message: `data input ${path} differs from the report`, fatal: true });
  }
  for (const [path, hash] of Object.entries(target.inputs.content).sort(([a], [b]) => byCodePoint(a, b))) {
    const actual = await hashFile(join(root, loaded.config.source, path));
    if (actual === undefined) problems.push({ category: "inputs", message: `missing content input ${path}`, fatal: true });
    else if (actual !== hash) problems.push({ category: "inputs", message: `content input ${path} differs from the report`, fatal: true });
  }

  const environment = environmentOf();
  if (target.environment.timezone !== environment.timezone) {
    problems.push({ category: "environment", message: `the report was built in time zone ${target.environment.timezone}, but this is ${environment.timezone}`, fatal: false });
  }
  if (target.environment.locale !== environment.locale) {
    problems.push({ category: "environment", message: `the report was built in locale ${target.environment.locale}, but this is ${environment.locale}`, fatal: false });
  }
  return { ok: problems.every((problem) => !problem.fatal), problems };
}

/** The comparison as the text the CLI prints, with the unexplained finding first. */
export function comparisonText(comparison: BuildComparison): string {
  if (comparison.same) return "identical: every category matches.\n";
  const lines: string[] = [];
  if (comparison.unexplained) {
    lines.push("unexplained: the outputs differ while every input, config, tool, and environment value matches; investigate the build.");
  }
  for (const category of BUILD_REPORT_CATEGORIES) {
    const differences = comparison.differences[category];
    if (differences.length === 0) continue;
    lines.push(`${category}: ${differences.length} difference${differences.length === 1 ? "" : "s"}`);
    for (const difference of differences) {
      const before = difference.before === undefined ? "(absent)" : difference.before;
      const after = difference.after === undefined ? "(absent)" : difference.after;
      lines.push(`  ${difference.path}: ${before} -> ${after}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** The comparison as the JSON report the CLI prints. */
export function comparisonJson(comparison: BuildComparison): string {
  return `${JSON.stringify(comparison, null, 2)}\n`;
}

/** The preflight as the text the CLI prints. */
export function preflightText(preflight: Preflight): string {
  if (preflight.problems.length === 0) return "reproducible: every declared input and tool matches.\n";
  const lines = preflight.problems.map((problem) => `${problem.fatal ? "error" : "warning"}: ${problem.category}: ${problem.message}`);
  return `${lines.join("\n")}\n`;
}
