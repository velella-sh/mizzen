/**
 * Builds the host side of the example-environment lock (#1326): the runtime, the packages examples import from the
 * site's `package.json`, the fixture folders under the source folder, and the effective limits. Recording and checking
 * both call this, so the two sides of a comparison are made the same way.
 *
 * The scan is offline and deterministic: it reads `package.json`, resolves each dependency's installed version from
 * `node_modules`, and hashes the bytes of every file under a fixture folder. Nothing here runs an example or touches
 * the network.
 */
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { builtinModules } from "node:module";
import { join, resolve } from "node:path";
import { version as engineVersion } from "../index.ts";
import type { ExamplesEnvironment, LockedFixture, LockedLimits, LockedPackage } from "./environment.ts";
import { EXAMPLES_ENV_VERSION } from "./environment.ts";

/** The folder, under the source folder, whose subfolders are examples' fixtures. */
export const FIXTURES_DIR = "fixtures";

/** The limits a lock records when the caller names none. */
export const DEFAULT_LOCKED_LIMITS: LockedLimits = { timeoutMs: 10_000, memoryMb: 0, network: "deny", shell: "bash" };

/** What {@link buildHostEnvironment} needs. */
export interface HostEnvironmentOptions {
  /** Absolute site root: the folder that holds `mizzen.yml` and `package.json`. */
  readonly root: string;
  /** Absolute source folder, where fixtures live. Default: `root`. */
  readonly sourceDir?: string;
  /** Limits to record; default {@link DEFAULT_LOCKED_LIMITS}. */
  readonly limits?: Partial<LockedLimits>;
  /** The runtime identity; default the running Node, engine, and platform. A test passes a fixed value. */
  readonly runtime?: ExamplesEnvironment["runtime"];
}

/** The Node built-in module names, without their `node:` prefix, as a set. */
const BUILTINS = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A dependency version as `package.json` spells it, with the leading range operator removed. */
function bareVersion(range: string): string {
  return range.replace(/^[\^~>=<*\s]+/, "").trim() || range.trim();
}

/** Reads the site's direct dependencies and their installed versions from `node_modules`. */
async function packagesOf(root: string): Promise<LockedPackage[]> {
  let manifest: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
  try {
    manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as typeof manifest;
  } catch {
    return [];
  }
  const names = [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})].sort(byCodePoint);
  const packages: LockedPackage[] = [];
  for (const name of names) {
    // An installed version is what an example actually imports; the declared range is only a fallback.
    let version = bareVersion(manifest.dependencies?.[name] ?? manifest.devDependencies?.[name] ?? "");
    try {
      const installed = JSON.parse(await readFile(join(root, "node_modules", name, "package.json"), "utf8")) as { version?: unknown };
      if (typeof installed.version === "string" && installed.version !== "") version = installed.version;
    } catch {
      // A package that is not installed is still locked at its declared range, so a later install is a difference.
    }
    packages.push({ name, version });
  }
  return packages;
}

/** The import specifiers a Node or TypeScript example names, so a `node:` builtin and a package are locked too. */
export function importSpecifiersOf(code: string): string[] {
  const found = new Set<string>();
  for (const match of code.matchAll(/\b(?:from|import|require)\s*\(?\s*(["'`])([^"'`]+)\1/g)) {
    const specifier = match[2] ?? "";
    // A relative or absolute path is the example's own file, not a locked input.
    if (specifier === "" || specifier.startsWith(".") || specifier.startsWith("/")) continue;
    found.add(specifier);
  }
  return [...found].sort(byCodePoint);
}

/**
 * The package names a run imports: the site's dependencies that an example names, plus every `node:` builtin an
 * example names. A builtin is recorded as `"builtin"`, because its version is the Node version the lock already pins.
 */
export function lockedPackagesFor(code: string, host: readonly LockedPackage[]): LockedPackage[] {
  const byName = new Map(host.map((entry) => [entry.name, entry.version]));
  const packages: LockedPackage[] = [];
  for (const specifier of importSpecifiersOf(code)) {
    const name = specifier.startsWith("node:") ? specifier.replace(/^node:/, "") : specifier;
    if (BUILTINS.has(name)) packages.push({ name: specifier, version: "builtin" });
    else {
      const root = name.startsWith("@") ? name.split("/").slice(0, 2).join("/") : name.split("/")[0]!;
      packages.push({ name: root, version: byName.get(root) ?? "unknown" });
    }
  }
  return packages.sort((a, b) => byCodePoint(a.name, b.name));
}

/** The directories a fixture walk skips, because they hold build output or packages rather than fixture input. */
const SKIP = new Set(["node_modules", ".git", ".mizzen", "dist"]);

/** A deterministic hash of every file under `dir`: each file's `/`-relative path then its bytes, sorted by path. */
async function hashFolder(dir: string): Promise<string> {
  const files: string[] = [];
  async function walk(current: string, rel: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => byCodePoint(a.name, b.name))) {
      if (SKIP.has(entry.name)) continue;
      const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) await walk(join(current, entry.name), path);
      else if (entry.isFile()) files.push(path);
    }
  }
  await walk(dir, "");
  files.sort(byCodePoint);
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(`${file}\0`);
    hash.update(await readFile(join(dir, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** Every subfolder of `sourceDir/fixtures`, hashed and sorted. A missing fixtures folder is no fixtures. */
async function fixturesOf(sourceDir: string): Promise<LockedFixture[]> {
  const root = join(sourceDir, FIXTURES_DIR);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const fixtures: LockedFixture[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP.has(entry.name)) continue;
    fixtures.push({ path: `${FIXTURES_DIR}/${entry.name}`, sha256: await hashFolder(join(root, entry.name)) });
  }
  return fixtures.sort((a, b) => byCodePoint(a.path, b.path));
}

/** Builds the host environment: runtime, packages, fixtures, and limits, ready to write or compare. */
export async function buildHostEnvironment(options: HostEnvironmentOptions): Promise<ExamplesEnvironment> {
  const root = resolve(options.root);
  const sourceDir = resolve(options.sourceDir ?? root);
  const limits: LockedLimits = { ...DEFAULT_LOCKED_LIMITS, ...options.limits };
  return {
    version: EXAMPLES_ENV_VERSION,
    runtime: options.runtime ?? { node: process.version, engine: engineVersion, platform: process.platform },
    packages: await packagesOf(root),
    fixtures: await fixturesOf(sourceDir),
    limits,
  };
}
