/**
 * Proves a release keeps the published site contract of the previous version.
 *
 * It installs the baseline and the candidate packages into separate empty projects, builds the
 * site fixture with the fixed test theme, and compares every public output byte, the
 * canonical links, the `_redirects` file, and the sitemap URLs. It also reports the URL surface,
 * the effective configuration, the CLI inventory and probes, and the exported contract surface, so
 * a compatibility review covers behavior beyond the rendered files. Then it builds the same site
 * with the published theme package and checks the base path, its assets, the canonical links, and a
 * rendered Mermaid diagram.
 *
 * Usage:
 *   node scripts/release-compat.ts --candidate <tarball> [--baseline @velella/mizzen@0.2.6]
 *     [--theme @velella/lateen@0.2.3] [--report compat-report.json] [--skip-theme]
 *   node scripts/release-compat.ts --baseline @velella/mizzen@0.2.6 \
 *     --write-baseline fixtures/compat-0.2.6/baseline.json
 *
 * `--write-baseline` only builds the baseline package and records its snapshot. Do not regenerate
 * the committed baseline to make the test pass: review the difference and record it in the fixture
 * README instead.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DEFAULT_FIXTURE = join(ROOT, "fixtures/compat-0.2.4");
const TEST_THEME = join(ROOT, "fixtures/compat-0.2/theme");
const PACKAGE = "@velella/mizzen";
const TEXT = new Set([".html", ".json", ".md", ".txt", ".xml", ".csv", ".ndjson", ".yml", ".js", ".css"]);
/** Pagefind's wasm is built per platform, so the same source produces different bytes on macOS and Linux. */
const PLATFORM_BINARY = /^pagefind\/wasm\.[^.]+\.pagefind$/;

/** What one build publishes, with the engine version normalized out of version-stamped JSON. */
export interface ReleaseSnapshot {
  readonly engine: string;
  /** Every public file, relative to the output folder, and the SHA-256 of its normalized bytes. */
  readonly files: Readonly<Record<string, string>>;
  /** Each HTML page's canonical link, when the page has one. */
  readonly canonicals: Readonly<Record<string, string>>;
  /** The `_redirects` file, verbatim. */
  readonly redirects: string;
  /** The absolute URLs in `sitemap.xml`, in file order. */
  readonly sitemap: readonly string[];
}

/** What changed between two snapshots. Every list is sorted; an empty diff passes. */
export interface ReleaseDiff {
  readonly missing: readonly string[];
  readonly changed: readonly string[];
  readonly added: readonly string[];
  readonly canonicals: readonly string[];
  readonly redirects: boolean;
  readonly sitemap: readonly string[];
}

export function compareSnapshots(baseline: ReleaseSnapshot, candidate: ReleaseSnapshot): ReleaseDiff {
  const baselineFiles = Object.keys(baseline.files).sort();
  const candidateFiles = Object.keys(candidate.files).sort();
  const missing = baselineFiles.filter((path) => !(path in candidate.files));
  const added = candidateFiles.filter((path) => !(path in baseline.files));
  const changed = baselineFiles.filter((path) => path in candidate.files && candidate.files[path] !== baseline.files[path]);
  const canonicalPaths = [...new Set([...Object.keys(baseline.canonicals), ...Object.keys(candidate.canonicals)])].sort();
  const canonicals = canonicalPaths.filter((path) => baseline.canonicals[path] !== candidate.canonicals[path]);
  const sitemap = baseline.sitemap.filter((url) => !candidate.sitemap.includes(url)).map((url) => `-${url}`).concat(
    candidate.sitemap.filter((url) => !baseline.sitemap.includes(url)).map((url) => `+${url}`),
  );
  return {
    missing,
    changed,
    added,
    canonicals,
    redirects: baseline.redirects !== candidate.redirects,
    sitemap,
  };
}

export const hasDifferences = (diff: ReleaseDiff): boolean =>
  diff.missing.length > 0 || diff.changed.length > 0 || diff.added.length > 0 ||
  diff.canonicals.length > 0 || diff.redirects || diff.sitemap.length > 0;

/**
 * The head tags the build prints for a baseline that predates the head wiring, so a candidate can be compared with
 * every published baseline through 0.2.6: Open Graph and Twitter meta tags, JSON-LD scripts, a canonical link on a page
 * the baseline gave none, and the description meta on the pages named in `descriptions` (the site-description
 * fallback). Nothing else is removed, so any other head or body change still fails the comparison. `trust.json`'s
 * `build.id` is a hash of the rendered HTML and moves with it.
 */
export interface AddedHead {
  readonly baseline: ReleaseSnapshot;
  readonly descriptions: readonly string[];
  /** The baseline's `trust.json` `build.id`, which the candidate's id (a hash of the rendered HTML) is replaced by. */
  readonly buildId: string;
}

const META_TAG = /<meta (?:property="og:|name="twitter:)[^>]*\/?>/g;
const JSON_LD = /<script type="application\/ld\+json">[\s\S]*?<\/script>/g;
const CANONICAL = /<link rel="canonical" href="[^"]+"\s*\/?>/g;
const DESCRIPTION = /<meta name="description" content="[^"]*"\s*\/?>/g;

/** `html` without the tags 0.2.6 added; `keepCanonical` is true for a page whose baseline already had its canonical. */
export function withoutAddedHead(html: string, keepCanonical: boolean, dropDescription: boolean): string {
  let text = html.replace(META_TAG, "").replace(JSON_LD, "");
  if (!keepCanonical) text = text.replace(CANONICAL, "");
  if (dropDescription) text = text.replace(DESCRIPTION, "");
  return text;
}

/**
 * Hashes every public file under `out`, normalizing the engine version stamp in JSON and agent files. With `added`,
 * the 0.2.6 head tags are removed first (see {@link AddedHead}); a canonical the baseline had is kept and compared.
 */
export function snapshotOutput(out: string, engine: string, added?: AddedHead): ReleaseSnapshot {
  const files: Record<string, string> = {};
  const canonicals: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!(dir === out && entry.name === ".mizzen")) walk(path);
      } else {
        const key = relative(out, path).split(sep).join("/");
        const bytes = readFileSync(path);
        if (PLATFORM_BINARY.test(key)) {
          // Pagefind ships its wasm per platform; those bytes are not part of the engine's output contract.
          files[key] = "platform";
        } else if (TEXT.has(key.slice(key.lastIndexOf(".")))) {
          let text = bytes.toString("utf8");
          if (key.endsWith(".html")) {
            const canonical = [...text.matchAll(/<link rel="canonical" href="([^"]+)"/g)];
            if (canonical.length > 1) throw new Error(`${key} has ${canonical.length} canonical links`);
            if (added !== undefined) text = withoutAddedHead(text, added.baseline.canonicals[key] !== undefined, added.descriptions.includes(key));
            if (canonical.length === 1 && (added === undefined || added.baseline.canonicals[key] !== undefined)) {
              canonicals[key] = canonical[0]![1]!;
            }
          } else if (added !== undefined && key === "trust.json") {
            text = text.replace(/("build": \{\s*"algorithm": "sha256",\s*"id": )"[0-9a-f]+"/, `$1"${added.buildId}"`);
          }
          files[key] = sha256(text.replace(/"engine":\s*"[^"]*"/g, '"engine": "<version>"'));
        } else {
          files[key] = createHash("sha256").update(bytes).digest("hex");
        }
      }
    }
  };
  walk(out);
  const redirects = files["_redirects"] === undefined ? "" : readFileSync(join(out, "_redirects"), "utf8");
  const sitemapText = existsSync(join(out, "sitemap.xml")) ? readFileSync(join(out, "sitemap.xml"), "utf8") : "";
  const sitemap = (sitemapText.match(/<loc>([^<]+)<\/loc>/g) ?? []).map((tag) =>
    tag.slice("<loc>".length, -"</loc>".length)
  );
  return { engine, files, canonicals, redirects, sitemap };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The addresses one build publishes: pages, sitemap entries, canonicals, redirect rules, and record URLs. */
export interface UrlSurface {
  /** Every HTML path relative to the output folder. */
  readonly pages: readonly string[];
  /** The absolute URLs in `sitemap.xml`. */
  readonly sitemap: readonly string[];
  /** Each HTML page's canonical link. */
  readonly canonicals: Readonly<Record<string, string>>;
  /** The normalized lines of `_redirects`. */
  readonly redirects: readonly string[];
  /** `collection.record` to its published URL, from `urls.json`. */
  readonly records: Readonly<Record<string, string>>;
}

/** What changed between two URL surfaces. Every list is sorted; an empty diff means the same addresses are served. */
export interface UrlDiff {
  readonly pages: readonly string[];
  readonly sitemap: readonly string[];
  readonly canonicals: readonly string[];
  readonly redirects: readonly string[];
  readonly records: readonly string[];
}

/** Reads the URL surface of a build, reusing the files and links `snapshot` already collected. */
export function readUrlSurface(out: string, snapshot: ReleaseSnapshot): UrlSurface {
  const records: Record<string, string> = {};
  const urlsFile = join(out, "urls.json");
  if (existsSync(urlsFile)) {
    const parsed = JSON.parse(readFileSync(urlsFile, "utf8")) as { collections?: Record<string, Record<string, unknown>> };
    for (const [collection, entries] of Object.entries(parsed.collections ?? {})) {
      for (const [id, url] of Object.entries(entries)) {
        if (typeof url === "string") records[`${collection}.${id}`] = url;
      }
    }
  }
  return {
    pages: Object.keys(snapshot.files).filter((path) => path.endsWith(".html")).sort(),
    sitemap: [...snapshot.sitemap].sort(),
    canonicals: snapshot.canonicals,
    redirects: snapshot.redirects.split("\n").map((line) => line.trim()).filter(Boolean).sort(),
    records,
  };
}

/** Compares two URL surfaces, marking a removed value with `-` and an added one with `+`. */
export function compareUrls(baseline: UrlSurface, candidate: UrlSurface): UrlDiff {
  return {
    pages: addedOrRemoved(baseline.pages, candidate.pages),
    sitemap: addedOrRemoved(baseline.sitemap, candidate.sitemap),
    canonicals: changedValues(baseline.canonicals, candidate.canonicals),
    redirects: addedOrRemoved(baseline.redirects, candidate.redirects),
    records: changedValues(baseline.records, candidate.records),
  };
}

function addedOrRemoved(baseline: readonly string[], candidate: readonly string[]): readonly string[] {
  const removed = baseline.filter((value) => !candidate.includes(value)).map((value) => `-${value}`);
  const added = candidate.filter((value) => !baseline.includes(value)).map((value) => `+${value}`);
  return [...removed, ...added];
}

function changedValues(baseline: Readonly<Record<string, string>>, candidate: Readonly<Record<string, string>>): readonly string[] {
  const keys = [...new Set([...Object.keys(baseline), ...Object.keys(candidate)])].sort();
  return keys.flatMap((key) => {
    const before = baseline[key];
    const after = candidate[key];
    if (before === after) return [];
    if (before === undefined) return [`+${key} ${after}`];
    if (after === undefined) return [`-${key} ${before}`];
    return [`~${key} ${before} -> ${after}`];
  });
}

/** One effective configuration value that differs between the two builds. */
export interface ConfigDifference {
  readonly path: string;
  readonly baseline: string;
  readonly candidate: string;
}

/** Compares the effective configuration from two `build-report.json` files by path. */
export function compareConfig(baseline: unknown, candidate: unknown): readonly ConfigDifference[] {
  const differences: ConfigDifference[] = [];
  const walk = (path: string, before: unknown, after: unknown): void => {
    if (isRecord(before) && isRecord(after)) {
      const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
      for (const key of keys) walk(path === "" ? key : `${path}.${key}`, before[key], after[key]);
      return;
    }
    const left = valueText(before);
    const right = valueText(after);
    if (left !== right) differences.push({ path: path === "" ? "<root>" : path, baseline: left, candidate: right });
  };
  walk("", baseline, candidate);
  return differences;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valueText(value: unknown): string {
  return value === undefined ? "<missing>" : JSON.stringify(value);
}

/** One CLI command run against an installed package. */
export interface CliProbe {
  readonly name: string;
  readonly exit: number;
  readonly output: string;
}

/** The part of a CLI that a compatibility review compares: its inventory and a few fixed probes. */
export interface CliSurface {
  readonly commands: readonly string[];
  readonly options: readonly string[];
  readonly probes: readonly CliProbe[];
}

/** What changed in the CLI inventory and probe results. */
export interface CliDiff {
  readonly commands: { readonly added: readonly string[]; readonly removed: readonly string[] };
  readonly options: { readonly added: readonly string[]; readonly removed: readonly string[] };
  readonly probes: readonly {
    readonly name: string;
    readonly baselineExit: number;
    readonly candidateExit: number;
    readonly output: "same" | "changed";
  }[];
}

/** The commands and long options `mizzen` prints in its usage text. */
export function helpInventory(help: string): { commands: readonly string[]; options: readonly string[] } {
  const commands: string[] = [];
  const options: string[] = [];
  for (const line of help.split("\n")) {
    const option = /^ {2}(--[a-z][a-z0-9-]*)/.exec(line);
    if (option !== null) options.push(option[1]!);
    const command = /^ {2}([a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)*)/.exec(line);
    if (command !== null) commands.push(command[1]!);
  }
  return { commands: [...new Set(commands)].sort(), options: [...new Set(options)].sort() };
}

/** Compares two CLI surfaces. A removed command or option is a break; an added one is reported only. */
export function compareCli(baseline: CliSurface, candidate: CliSurface): CliDiff {
  const probes = baseline.probes.map((probe) => {
    const other = candidate.probes.find((entry) => entry.name === probe.name);
    return {
      name: probe.name,
      baselineExit: probe.exit,
      candidateExit: other?.exit ?? -1,
      output: (other?.output === probe.output ? "same" : "changed") as "same" | "changed",
    };
  });
  return {
    commands: inventoryDiff(baseline.commands, candidate.commands),
    options: inventoryDiff(baseline.options, candidate.options),
    probes,
  };
}

function inventoryDiff(
  baseline: readonly string[],
  candidate: readonly string[],
): { readonly added: readonly string[]; readonly removed: readonly string[] } {
  return {
    added: candidate.filter((value) => !baseline.includes(value)).sort(),
    removed: baseline.filter((value) => !candidate.includes(value)).sort(),
  };
}

/** The package surface a consumer depends on: its export map, shipped schemas, and exported contract names. */
export interface ContractSurface {
  readonly exports: Record<string, unknown>;
  /** Each `schema/*.json` file and the SHA-256 of its bytes. */
  readonly schemas: Readonly<Record<string, string>>;
  /** Every type the package re-exports from `./contracts`. */
  readonly types: readonly string[];
}

/** What changed in the contract surface. */
export interface ContractDiff {
  readonly exports: boolean;
  readonly schemas: { readonly added: readonly string[]; readonly removed: readonly string[]; readonly changed: readonly string[] };
  readonly types: { readonly added: readonly string[]; readonly removed: readonly string[] };
}

/** Reads the contract surface of an installed package. */
export function readContractSurface(packageDir: string): ContractSurface {
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as { exports?: Record<string, unknown> };
  const schemas: Record<string, string> = {};
  const schemaDir = join(packageDir, "schema");
  if (existsSync(schemaDir)) {
    for (const name of readdirSync(schemaDir).filter((entry) => entry.endsWith(".json")).sort()) {
      schemas[name] = createHash("sha256").update(readFileSync(join(schemaDir, name))).digest("hex");
    }
  }
  const declarations = join(packageDir, "dist", "contracts", "index.d.ts");
  const text = existsSync(declarations) ? readFileSync(declarations, "utf8") : "";
  const types = new Set<string>();
  for (const match of text.matchAll(/export type \{([^}]*)\}/g)) {
    for (const name of match[1]!.split(",")) {
      const trimmed = name.trim();
      if (trimmed !== "") types.add(trimmed);
    }
  }
  for (const match of text.matchAll(/export (?:interface|type|class|const|function) ([A-Za-z0-9_]+)/g)) types.add(match[1]!);
  return { exports: manifest.exports ?? {}, schemas, types: [...types].sort() };
}

/** Compares two contract surfaces. A removed type or schema is a break; an added one is reported only. */
export function compareContracts(baseline: ContractSurface, candidate: ContractSurface): ContractDiff {
  const schemaNames = [...new Set([...Object.keys(baseline.schemas), ...Object.keys(candidate.schemas)])].sort();
  return {
    exports: JSON.stringify(baseline.exports) !== JSON.stringify(candidate.exports),
    schemas: {
      added: schemaNames.filter((name) => baseline.schemas[name] === undefined),
      removed: schemaNames.filter((name) => candidate.schemas[name] === undefined),
      changed: schemaNames.filter((name) => baseline.schemas[name] !== undefined && candidate.schemas[name] !== undefined && baseline.schemas[name] !== candidate.schemas[name]),
    },
    types: {
      added: candidate.types.filter((name) => !baseline.types.includes(name)),
      removed: baseline.types.filter((name) => !candidate.types.includes(name)),
    },
  };
}

function run(command: string, args: readonly string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, stdio: ["ignore", "inherit", "inherit"] });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed in ${cwd}`);
}

/** Installs the packages into a new empty project and returns it. */
function project(name: string, specs: readonly string[]): string {
  const dir = join(tempRoot, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: `mizzen-compat-${name}`, private: true }, null, 2)}\n`);
  run("npm", ["install", "--silent", "--no-audit", "--no-fund", ...specs], dir);
  return dir;
}

/** The installed package version, from the package the project installed. */
function installedVersion(dir: string, name: string): string {
  return JSON.parse(readFileSync(join(dir, "node_modules", name, "package.json"), "utf8")).version as string;
}

function buildSite(dir: string, themeName?: string): string {
  const site = join(dir, "site");
  cpSync(fixtureSite, site, { recursive: true });
  if (themeName !== undefined) {
    const config = join(site, "mizzen.yml");
    writeFileSync(config, `theme:\n  name: "${themeName}"\n${readFileSync(config, "utf8")}`);
  }
  const bin = join(dir, "node_modules", "@velella", "mizzen", "bin", "mizzen.js");
  const theme = themeName === undefined ? ["--theme", TEST_THEME] : [];
  run(process.execPath, [bin, "build", "site", "--out", "out", "--diagnose", ...theme], dir);
  return join(dir, "out");
}

/** The effective configuration `build --diagnose` recorded, or undefined for a package without a build report. */
function buildConfig(dir: string): unknown {
  const file = join(dir, "site", ".mizzen", "build-report.json");
  if (!existsSync(file)) return undefined;
  const report = JSON.parse(readFileSync(file, "utf8")) as { config?: unknown };
  return report.config;
}

/** Runs the fixed CLI probes in one installed project and normalizes the project paths out of their output. */
function probeCli(dir: string): CliSurface {
  const bin = join(dir, "node_modules", "@velella", "mizzen", "bin", "mizzen.js");
  const normalize = (text: string): string =>
    text.replaceAll(dir, "<project>").replaceAll(TEST_THEME, "<theme>").replaceAll(tempRoot, "<temp>");
  const help = capture(dir, bin, ["--help"]);
  const inventory = helpInventory(help.output);
  const probes: CliProbe[] = [
    { name: "--help", ...help },
    { name: "agent capabilities", ...normalizeCapabilities(capture(dir, bin, ["agent", "capabilities"])) },
    { name: "check site", ...capture(dir, bin, ["check", "site", "--theme", TEST_THEME, "--format", "json"]) },
    { name: "doctor site", ...capture(dir, bin, ["doctor", "site", "--theme", TEST_THEME, "--format", "json"]) },
    { name: "urls check site", ...capture(dir, bin, ["urls", "check", "site", "--format", "json"]) },
  ];
  return {
    ...inventory,
    probes: probes.map((probe) => ({ ...probe, output: normalize(probe.output) })),
  };
  function capture(cwd: string, executable: string, args: readonly string[]): { readonly exit: number; readonly output: string } {
    const result = spawnSync(process.execPath, [executable, ...args], {
      cwd,
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, NO_COLOR: "1" },
    });
    return { exit: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  }
  function normalizeCapabilities(result: { readonly exit: number; readonly output: string }): { readonly exit: number; readonly output: string } {
    try {
      const value = JSON.parse(result.output) as Record<string, unknown>;
      if (typeof value === "object" && value !== null) value.package = "<version>";
      return { exit: result.exit, output: JSON.stringify(value) };
    } catch {
      return result;
    }
  }
}

let tempRoot = "";
let fixtureSite = "";

function parseArgs(argv: readonly string[]): {
  baseline: string;
  candidate?: string;
  theme: string;
  report?: string;
  writeBaseline?: string;
  skipTheme: boolean;
  fixture: string;
} {
  const options: { baseline: string; candidate?: string; theme: string; report?: string; writeBaseline?: string; skipTheme: boolean; fixture: string } = {
    baseline: "@velella/mizzen@0.2.6",
    theme: "@velella/lateen@0.2.3",
    skipTheme: false,
    fixture: DEFAULT_FIXTURE,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const value = argv[i + 1];
    if (arg === "--skip-theme") options.skipTheme = true;
    else if (arg === "--baseline" && value !== undefined) (options.baseline = value), (i += 1);
    else if (arg === "--candidate" && value !== undefined) (options.candidate = value), (i += 1);
    else if (arg === "--theme" && value !== undefined) (options.theme = value), (i += 1);
    else if (arg === "--report" && value !== undefined) (options.report = value), (i += 1);
    else if (arg === "--write-baseline" && value !== undefined) (options.writeBaseline = value), (i += 1);
    else if (arg === "--fixture" && value !== undefined) (options.fixture = value), (i += 1);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function checksum(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function main(argv: readonly string[]): void {
  const options = parseArgs(argv);
  if (options.writeBaseline === undefined && options.candidate === undefined) {
    process.stderr.write("Usage: release-compat --candidate <tarball> | --write-baseline <file>\n");
    process.exit(1);
  }
  fixtureSite = join(options.fixture, "site");
  tempRoot = mkdtempSync(join(tmpdir(), "mizzen-release-compat-"));
  try {
    const baselineProject = project("baseline", [options.baseline]);
    const baselineVersion = installedVersion(baselineProject, PACKAGE);
    const baselineOut = buildSite(baselineProject);
    const baseline = snapshotOutput(baselineOut, baselineVersion);
    const baselineEvidence = {
      package: options.baseline,
      version: baselineVersion,
      files: Object.keys(baseline.files).length,
      canonicals: Object.keys(baseline.canonicals).length,
      sitemap: baseline.sitemap.length,
    };

    if (options.writeBaseline !== undefined) {
      mkdirSync(dirname(options.writeBaseline), { recursive: true });
      writeFileSync(options.writeBaseline, `${JSON.stringify(baseline, null, 2)}\n`);
      process.stdout.write(`wrote ${options.writeBaseline} from ${options.baseline} (${baselineEvidence.files} files)\n`);
      return;
    }

    const baselineUrls = readUrlSurface(baselineOut, baseline);
    const baselineConfig = buildConfig(baselineProject);
    const baselineContracts = readContractSurface(join(baselineProject, "node_modules", PACKAGE));
    const baselineCli = probeCli(baselineProject);

    const candidatePath = options.candidate!;
    const candidateProject = project("candidate", [candidatePath]);
    const candidateVersion = installedVersion(candidateProject, PACKAGE);
    // A baseline through 0.2.6 predates the head wiring: remove exactly the head tags the candidate adds (see
    // AddedHead); a later baseline is compared exactly.
    const trustId = /"build":\s*\{\s*"algorithm":\s*"sha256",\s*"id":\s*"([0-9a-f]+)"/.exec(
      existsSync(join(baselineOut, "trust.json")) ? readFileSync(join(baselineOut, "trust.json"), "utf8") : "",
    )?.[1];
    const added: AddedHead | undefined = /^0\.2\.[0-6]$/.test(baselineVersion) && trustId !== undefined
      ? { baseline, descriptions: ["index.html"], buildId: trustId }
      : undefined;
    const candidateOut = buildSite(candidateProject);
    const candidate = snapshotOutput(candidateOut, candidateVersion, added);
    const diff = compareSnapshots(baseline, candidate);
    const urls = compareUrls(baselineUrls, readUrlSurface(candidateOut, candidate));
    const configuration = compareConfig(baselineConfig, buildConfig(candidateProject));
    const contracts = compareContracts(baselineContracts, readContractSurface(join(candidateProject, "node_modules", PACKAGE)));
    const cli = compareCli(baselineCli, probeCli(candidateProject));
    const compatibilityProblems = [
      ...cli.commands.removed.map((command) => `CLI command removed: ${command}`),
      ...cli.options.removed.map((option) => `CLI option removed: ${option}`),
      ...contracts.types.removed.map((type) => `contract type removed: ${type}`),
      ...contracts.schemas.removed.map((schema) => `schema removed: ${schema}`),
    ];
    let themeOk = true;
    let themeEvidence: Record<string, unknown> = {};
    if (!options.skipTheme) {
      const baselineThemeProject = project("baseline-theme", [options.baseline, options.theme, "preact"]);
      const baselineThemeOut = buildSite(baselineThemeProject, "@velella/lateen");
      const themeProject = project("theme", [candidatePath, options.theme, "preact"]);
      const themeVersion = installedVersion(themeProject, "@velella/lateen");
      const out = buildSite(themeProject, "@velella/lateen");
      const index = readFileSync(join(out, "index.html"), "utf8");
      const diagram = readFileSync(join(out, "diagrams", "index.html"), "utf8");
      const redirects = readFileSync(join(out, "_redirects"), "utf8");
      const htmlFiles = (dir: string): string[] => {
        const found: string[] = [];
        const walk = (current: string): void => {
          for (const entry of readdirSync(current, { withFileTypes: true })) {
            if (entry.isDirectory()) walk(join(current, entry.name));
            else if (entry.name.endsWith(".html")) found.push(join(current, entry.name));
          }
        };
        walk(dir);
        return found;
      };
      const singleCanonical = htmlFiles(out).every((file) =>
        (readFileSync(file, "utf8").match(/<link rel="canonical"/g) ?? []).length <= 1
      );
      const alternates = (html: string): string[] => html.match(/<link rel="alternate" hreflang="[^>]*>/g) ?? [];
      const baselineIndex = readFileSync(join(baselineThemeOut, "index.html"), "utf8");
      const checks: [string, boolean][] = [
        ["at most one canonical link per page", singleCanonical],
        ["same hreflang set as the baseline", JSON.stringify(alternates(index)) === JSON.stringify(alternates(baselineIndex))],
        ["canonical under base", index.includes('<link rel="canonical" href="https://example.com/catalogue/"/>')],
        ["theme asset under base", /(?:href|src)="\/catalogue\/assets\/theme\//.test(index)],
        ["Mermaid inline SVG", diagram.includes('class="mermaid-diagram"') && !diagram.includes('class="mermaid-fallback"')],
        ["redirects keep base", redirects.includes("https://example.com/catalogue/releases/") && redirects.includes("https://example.com/catalogue/components/")],
      ];
      themeOk = checks.every(([, ok]) => ok);
      themeEvidence = { theme: options.theme, themeVersion, checks: checks.map(([name, ok]) => ({ name, ok })) };
      if (themeOk) process.stdout.write(`theme ${options.theme}: canonical, base assets, Mermaid, and redirects keep the base\n`);
      else process.stderr.write(`theme checks failed: ${checks.filter(([, ok]) => !ok).map(([name]) => name).join(", ")}\n`);
    }

    const evidence = {
      baseline: baselineEvidence,
      candidate: { package: basename(candidatePath), version: candidateVersion, sha256: checksum(candidatePath) },
      compared: {
        files: Object.keys(baseline.files).length,
        canonicals: Object.keys(baseline.canonicals).length,
        redirects: baseline.redirects.split("\n").filter(Boolean).length,
        sitemap: baseline.sitemap.length,
        commands: baselineCli.commands.length,
        contractTypes: baselineContracts.types.length,
        schemas: Object.keys(baselineContracts.schemas).length,
      },
      review: { urls, configuration, cli, contracts },
      differences: diff,
      compatibility: compatibilityProblems,
      theme: themeEvidence,
    };
    if (options.report !== undefined) writeFileSync(options.report, `${JSON.stringify(evidence, null, 2)}\n`);
    process.stdout.write(
      `${options.baseline} vs ${basename(candidatePath)}: ${diff.missing.length} missing, ${diff.changed.length} changed, ` +
        `${diff.added.length} added, ${diff.canonicals.length} canonical, redirects ${diff.redirects ? "changed" : "same"}, ` +
        `${diff.sitemap.length} sitemap; urls ${urls.pages.length} page, ${urls.records.length} record; ` +
        `config ${configuration.length}; cli -${cli.commands.removed.length}/+${cli.commands.added.length} commands; ` +
        `contracts -${contracts.types.removed.length}/+${contracts.types.added.length} types\n`,
    );
    if (compatibilityProblems.length > 0) process.stderr.write(`${compatibilityProblems.join("\n")}\n`);
    if (hasDifferences(diff) || !themeOk || compatibilityProblems.length > 0) {
      if (hasDifferences(diff)) process.stderr.write(`${JSON.stringify(diff, null, 2)}\n`);
      process.exitCode = 1;
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
