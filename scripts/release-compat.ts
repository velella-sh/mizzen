/**
 * Proves a release keeps the published site contract of the previous version.
 *
 * It installs the baseline and the candidate packages into separate empty projects, builds the
 * site fixture with the fixed test theme, and compares every public output byte, the
 * canonical links, the `_redirects` file, and the sitemap URLs. Then it builds the same site with
 * the published theme package and checks the base path, its assets, the canonical links, and a
 * rendered Mermaid diagram.
 *
 * Usage:
 *   node scripts/release-compat.ts --candidate <tarball> [--baseline @velella/mizzen@0.2.4]
 *     [--theme @velella/lateen@0.2.2] [--report compat-report.json] [--skip-theme]
 *   node scripts/release-compat.ts --write-baseline fixtures/compat-0.2.4/baseline.json
 *
 * `--write-baseline` only builds the baseline package and records its snapshot. Do not regenerate
 * the committed baseline to make the test pass: review the difference and record it in the fixture
 * README instead.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DEFAULT_FIXTURE = join(ROOT, "fixtures/compat-0.2.4");
const TEST_THEME = join(ROOT, "fixtures/compat-0.2/theme");
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

/** Hashes every public file under `out`, normalizing the engine version stamp in JSON and agent files. */
export function snapshotOutput(out: string, engine: string): ReleaseSnapshot {
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
          const text = bytes.toString("utf8");
          files[key] = sha256(text.replace(/"engine":\s*"[^"]*"/g, '"engine": "<version>"'));
          if (key.endsWith(".html")) {
            const canonical = /<link rel="canonical" href="([^"]+)"/.exec(text);
            if (canonical !== null) canonicals[key] = canonical[1]!;
          }
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
  run(process.execPath, [bin, "build", "site", "--out", "out", ...theme], dir);
  return join(dir, "out");
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
    baseline: "@velella/mizzen@0.2.4",
    theme: "@velella/lateen@0.2.2",
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
    const baselineVersion = installedVersion(baselineProject, "@velella/mizzen");
    const baseline = snapshotOutput(buildSite(baselineProject), baselineVersion);
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

    const candidatePath = options.candidate!;
    const candidateProject = project("candidate", [candidatePath]);
    const candidateVersion = installedVersion(candidateProject, "@velella/mizzen");
    const candidate = snapshotOutput(buildSite(candidateProject), candidateVersion);
    const diff = compareSnapshots(baseline, candidate);
    let themeOk = true;
    let themeEvidence: Record<string, unknown> = {};
    if (!options.skipTheme) {
      const themeProject = project("theme", [candidatePath, options.theme, "preact"]);
      const themeVersion = installedVersion(themeProject, "@velella/lateen");
      const out = buildSite(themeProject, "@velella/lateen");
      const index = readFileSync(join(out, "index.html"), "utf8");
      const diagram = readFileSync(join(out, "diagrams", "index.html"), "utf8");
      const redirects = readFileSync(join(out, "_redirects"), "utf8");
      const checks: [string, boolean][] = [
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
      candidate: { package: candidatePath, version: candidateVersion, sha256: checksum(candidatePath) },
      compared: {
        files: Object.keys(baseline.files).length,
        canonicals: Object.keys(baseline.canonicals).length,
        redirects: baseline.redirects.split("\n").filter(Boolean).length,
        sitemap: baseline.sitemap.length,
      },
      differences: diff,
      theme: themeEvidence,
    };
    if (options.report !== undefined) writeFileSync(options.report, `${JSON.stringify(evidence, null, 2)}\n`);
    process.stdout.write(
      `${options.baseline} vs ${candidatePath}: ${diff.missing.length} missing, ${diff.changed.length} changed, ` +
        `${diff.added.length} added, ${diff.canonicals.length} canonical, redirects ${diff.redirects ? "changed" : "same"}, ` +
        `${diff.sitemap.length} sitemap differences\n`,
    );
    if (hasDifferences(diff) || !themeOk) {
      if (hasDifferences(diff)) process.stderr.write(`${JSON.stringify(diff, null, 2)}\n`);
      process.exitCode = 1;
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
