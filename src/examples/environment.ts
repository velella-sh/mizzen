/**
 * The execution-environment lock an executable documentation site pins (#1326).
 *
 * A normal build may not run examples, so the inputs that decide what an example does are recorded once, in
 * `.mizzen-env.json`, and every later run compares itself against that file. The lock names the runtime (the Node
 * version and the engine version), the packages the examples import, the fixtures they read, and the other effective
 * inputs (the timeout, the memory limit, the network policy, and the shell). An example whose inputs are not in the
 * lock, or whose lock entry does not match the host, is reported as `unlocked` rather than silently run against a
 * different environment.
 *
 * The file is deterministic — fixed key order, sorted collections, no timestamps — so the same inputs produce the
 * same bytes and a changed host is a diff a reviewer reads. It lives beside `.mizzen-examples.json` and, like it, is
 * written only by an explicit command, never by a normal build.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Diagnostic } from "../contracts/diagnostic.ts";

/** The lock file the recorder writes at the site root. */
export const EXAMPLES_ENV_FILE = ".mizzen-env.json";

/** The lock format; a file of another version is not trusted. */
export const EXAMPLES_ENV_VERSION = 1;

/** One package an example imports and the version the host provides. */
export interface LockedPackage {
  /** The package name, as it is imported. */
  readonly name: string;
  /** The version the host resolves, or `"builtin"` for a `node:` module. */
  readonly version: string;
}

/** The runtime an example runs under. */
export interface LockedRuntime {
  /** The Node version that ran the examples, such as `v24.22.3`. */
  readonly node: string;
  /** The engine version, from `package.json`. */
  readonly engine: string;
  /** The process platform, such as `darwin` or `linux`. */
  readonly platform: string;
}

/** The effective limits a run applies. */
export interface LockedLimits {
  /** Milliseconds an example may run. */
  readonly timeoutMs: number;
  /** V8 old-space limit in MiB; `0` keeps V8's default. */
  readonly memoryMb: number;
  /** Whether an example may reach the network; the lock records the policy, not a per-example override. */
  readonly network: "deny" | "allow";
  /** The shell an `sh`/`bash` example runs under, such as `bash`. */
  readonly shell: string;
}

/** One entry: the fixture folder an example reads and every file in it, with its SHA-256. */
export interface LockedFixture {
  /** Folder relative to the site root, `/`-separated, or `"."` for the site root. */
  readonly path: string;
  /** SHA-256 over every file's relative path and contents under {@link LockedFixture.path}. */
  readonly sha256: string;
}

/** The lock body. */
export interface ExamplesEnvironment {
  readonly version: typeof EXAMPLES_ENV_VERSION;
  readonly runtime: LockedRuntime;
  /** Packages sorted by name. */
  readonly packages: readonly LockedPackage[];
  /** Fixtures sorted by path. */
  readonly fixtures: readonly LockedFixture[];
  readonly limits: LockedLimits;
}

/** What a comparison against the lock found. */
export type EnvironmentState = "locked" | "missing" | "changed";

/** The result of comparing a host's environment with a lock file. */
export interface EnvironmentCheck {
  readonly state: EnvironmentState;
  /** The lock that was read, when the file exists and parses. */
  readonly environment?: ExamplesEnvironment;
  /** Why the host differs from the lock, when it does. */
  readonly differences: readonly string[];
}

/** A stable digest of a lock body: what `examples record` writes into its evidence. */
export function environmentHash(environment: ExamplesEnvironment): string {
  return createHash("sha256").update(canonicalEnvironment(environment)).digest("hex");
}

/** The lock as the hash sees it: sorted collections, fixed key order, two-space JSON, one trailing line feed. */
export function canonicalEnvironment(environment: ExamplesEnvironment): string {
  const sorted: ExamplesEnvironment = {
    version: environment.version,
    runtime: {
      node: environment.runtime.node,
      engine: environment.runtime.engine,
      platform: environment.runtime.platform,
    },
    packages: [...environment.packages].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    fixtures: [...environment.fixtures].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    limits: {
      timeoutMs: environment.limits.timeoutMs,
      memoryMb: environment.limits.memoryMb,
      network: environment.limits.network,
      shell: environment.limits.shell,
    },
  };
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Reads one lock body, or `undefined` when it is not a complete version 1 lock. */
function parseEnvironment(value: unknown): ExamplesEnvironment | undefined {
  if (!isObject(value) || value.version !== EXAMPLES_ENV_VERSION) return undefined;
  const runtime = value.runtime;
  if (!isObject(runtime)) return undefined;
  const node = stringOf(runtime.node);
  const engine = stringOf(runtime.engine);
  const platform = stringOf(runtime.platform);
  if (node === undefined || engine === undefined || platform === undefined) return undefined;

  const limits = value.limits;
  if (!isObject(limits)) return undefined;
  const timeoutMs = nonNegativeInteger(limits.timeoutMs);
  const memoryMb = nonNegativeInteger(limits.memoryMb);
  const network = limits.network;
  const shell = stringOf(limits.shell);
  if (timeoutMs === undefined || memoryMb === undefined || (network !== "deny" && network !== "allow") || shell === undefined) {
    return undefined;
  }

  if (!Array.isArray(value.packages) || !Array.isArray(value.fixtures)) return undefined;
  const packages: LockedPackage[] = [];
  for (const entry of value.packages) {
    if (!isObject(entry)) return undefined;
    const name = stringOf(entry.name);
    const version = stringOf(entry.version);
    if (name === undefined || version === undefined) return undefined;
    packages.push({ name, version });
  }
  const fixtures: LockedFixture[] = [];
  for (const entry of value.fixtures) {
    if (!isObject(entry)) return undefined;
    const path = stringOf(entry.path);
    const sha256 = typeof entry.sha256 === "string" && /^[0-9a-f]{64}$/.test(entry.sha256) ? entry.sha256 : undefined;
    if (path === undefined || sha256 === undefined) return undefined;
    fixtures.push({ path, sha256 });
  }

  return { version: EXAMPLES_ENV_VERSION, runtime: { node, engine, platform }, packages, fixtures, limits: { timeoutMs, memoryMb, network, shell } };
}

/** Reads the lock at `root`. A missing file is `undefined`; a malformed one throws, so a caller reports it. */
export async function readExamplesEnvironment(root: string): Promise<ExamplesEnvironment | undefined> {
  const contents = await readFile(join(root, EXAMPLES_ENV_FILE), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (contents === undefined) return undefined;
  const parsed = parseEnvironment(JSON.parse(contents));
  if (parsed === undefined) throw new Error(`Expected a complete version ${EXAMPLES_ENV_VERSION} example environment.`);
  return parsed;
}

/** Compares `host` against `lock`, naming every field that differs. Deterministic and order-stable. */
export function compareEnvironments(lock: ExamplesEnvironment, host: ExamplesEnvironment): readonly string[] {
  const differences: string[] = [];
  if (lock.runtime.node !== host.runtime.node) differences.push(`Node is ${host.runtime.node}, the lock has ${lock.runtime.node}`);
  if (lock.runtime.engine !== host.runtime.engine) differences.push(`the engine is ${host.runtime.engine}, the lock has ${lock.runtime.engine}`);
  if (lock.runtime.platform !== host.runtime.platform) differences.push(`the platform is ${host.runtime.platform}, the lock has ${lock.runtime.platform}`);
  if (lock.limits.timeoutMs !== host.limits.timeoutMs) differences.push(`the timeout is ${host.limits.timeoutMs}ms, the lock has ${lock.limits.timeoutMs}ms`);
  if (lock.limits.memoryMb !== host.limits.memoryMb) differences.push(`the memory limit is ${host.limits.memoryMb}MiB, the lock has ${lock.limits.memoryMb}MiB`);
  if (lock.limits.network !== host.limits.network) differences.push(`the network policy is ${host.limits.network}, the lock has ${lock.limits.network}`);
  if (lock.limits.shell !== host.limits.shell) differences.push(`the shell is ${host.limits.shell}, the lock has ${lock.limits.shell}`);

  const locked = new Map(lock.packages.map((entry) => [entry.name, entry.version]));
  const present = new Map(host.packages.map((entry) => [entry.name, entry.version]));
  for (const name of [...new Set([...locked.keys(), ...present.keys()])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const a = locked.get(name);
    const b = present.get(name);
    if (a === b) continue;
    if (a === undefined) differences.push(`package ${name}@${b} is not in the lock`);
    else if (b === undefined) differences.push(`package ${name}@${a} is locked but not installed`);
    else differences.push(`package ${name} is ${b}, the lock has ${a}`);
  }

  const lockedFixtures = new Map(lock.fixtures.map((entry) => [entry.path, entry.sha256]));
  const hostFixtures = new Map(host.fixtures.map((entry) => [entry.path, entry.sha256]));
  for (const path of [...new Set([...lockedFixtures.keys(), ...hostFixtures.keys()])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const a = lockedFixtures.get(path);
    const b = hostFixtures.get(path);
    if (a === b) continue;
    if (a === undefined) differences.push(`fixture ${path} is not in the lock`);
    else if (b === undefined) differences.push(`fixture ${path} is locked but missing`);
    else differences.push(`fixture ${path} changed since the lock`);
  }
  return differences;
}

/** Checks a host environment against the lock at `root`; a missing lock, a changed host, or a read error is reported. */
export async function checkEnvironment(root: string, host: ExamplesEnvironment): Promise<EnvironmentCheck> {
  let lock: ExamplesEnvironment | undefined;
  try {
    lock = await readExamplesEnvironment(root);
  } catch (error) {
    return { state: "changed", differences: [`${EXAMPLES_ENV_FILE} could not be read: ${error instanceof Error ? error.message : String(error)}`] };
  }
  if (lock === undefined) return { state: "missing", differences: [`${EXAMPLES_ENV_FILE} does not exist`] };
  const differences = compareEnvironments(lock, host);
  return { state: differences.length === 0 ? "locked" : "changed", environment: lock, differences };
}

/** Stable id of the finding for a missing or unprepared lock. */
export const EXAMPLE_UNLOCKED_ID = "example-unlocked";

/**
 * The finding that an example run has no prepared environment: either the lock is missing, or the host differs from
 * it. It is an `error`, because a run against an unprepared lock cannot prove what it claims; the message names the
 * first differences so the fix is explicit. The finding has no position: it is about the run, not one fence.
 */
export function exampleUnlocked(check: EnvironmentCheck): Diagnostic {
  if (check.state === "missing") {
    return {
      id: EXAMPLE_UNLOCKED_ID,
      severity: "error",
      message: `No ${EXAMPLES_ENV_FILE} at the site root, so the example environment is not locked.`,
      help: "Run `mizzen examples lock` to record the runtime, packages, fixtures, and limits, then check the file in.",
    };
  }
  const detail = check.differences.slice(0, 3).join("; ");
  const more = check.differences.length > 3 ? ` (and ${check.differences.length - 3} more)` : "";
  return {
    id: EXAMPLE_UNLOCKED_ID,
    severity: "error",
    message: `The example environment differs from ${EXAMPLES_ENV_FILE}: ${detail}${more}.`,
    help: "Run `mizzen examples lock` on the intended host and commit the updated lock, or run on the locked host.",
  };
}
