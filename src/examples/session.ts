/**
 * The bounded runner an executable example runs in (#1328, #1334).
 *
 * It runs a whole session of Node or shell blocks — not one block at a time — so several fences can share state in the
 * declared order (#1330), and it enforces the same limits for every block: a wall-clock timeout, a V8 old-space limit,
 * the working folder, and a denied network. A violation is classified, not just reported as a failure, so a reader can
 * tell a timeout from a memory blow-up, a refused command, and a write that escaped the folder.
 *
 * The runner is a process sandbox, not an OS sandbox: it uses a fresh temporary folder, a scrubbed environment, and a
 * killed process group, and where the host offers `sandbox-exec` or `bwrap` it confines writes too. The result carries
 * `sandboxed` so nothing claims isolation the platform did not provide. Output is capped per stream, and a block that
 * floods it is killed. The run is total: a failing, noisy, refused, or hanging block is a result, never a throw.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DEFAULT_TIMEOUT_MS, MAX_OUTPUT_BYTES } from "../pipeline/examples/run-node.ts";
import { deniedCommand, planSandbox, sandboxAvailable, type SandboxPlan } from "../pipeline/examples/run-shell.ts";

/** A block's language decides how it is run: a Node module, a TypeScript file, or a shell script. */
export type BlockLang = "js" | "ts" | "bash";

/** Which violation, if any, stopped a run. */
export type ViolationKind = "none" | "timeout" | "memory" | "output" | "network" | "filesystem" | "command";

/** One block to run in a session. */
export interface SessionBlock {
  /** The block's stable id, so a result names it. */
  readonly id: string;
  /** Its language, already narrowed to a runnable one. */
  readonly lang: BlockLang;
  /** The code as it will run: an imported snippet's text, or the fence's own. */
  readonly code: string;
}

/** The limits a session applies to every block. */
export interface SessionLimits {
  /** Milliseconds each block may run. */
  readonly timeoutMs: number;
  /** V8 old-space limit in MiB; `0` keeps V8's default. */
  readonly memoryMb: number;
  /** Whether the blocks may reach the network. */
  readonly network: "deny" | "allow";
}

/** What one block did. */
export interface BlockResult {
  readonly id: string;
  readonly lang: BlockLang;
  /** True only when the block exited on its own with code 0 and broke no limit. */
  readonly ok: boolean;
  /** The exit code, or `null` when the block timed out, was refused, or could not start. */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Which limit, if any, stopped the block. */
  readonly violation: ViolationKind;
  /** True when the host confined writes; false means only the process sandbox applied. */
  readonly sandboxed: boolean;
  /** Why the runner refused the block before it ran, when it did. */
  readonly refused?: string;
}

/** What a whole session did. */
export interface SessionResult {
  readonly blocks: readonly BlockResult[];
  /** The folder the session ran in; already removed when the session returns. */
  readonly sandboxed: boolean;
}

/** What {@link runSession} needs. */
export interface RunSessionOptions {
  /** The blocks, in declared order. */
  readonly blocks: readonly SessionBlock[];
  /** The folder to copy fixture files into before the first block; optional. */
  readonly fixtures?: Readonly<Record<string, string | Uint8Array>>;
  /** The limits; a caller passes the locked limits so a run matches the lock. */
  readonly limits: Partial<SessionLimits>;
  /** Stop before the next block when this one fails; a runbook sets it. Default `true`. */
  readonly stopOnFailure?: boolean;
}

/** The message appended to a stream cut at {@link MAX_OUTPUT_BYTES}. */
const TRUNCATION = "\n[output truncated]\n";

/** A byte stream captured up to a fixed budget. */
interface Collector {
  push(chunk: Buffer): void;
  text(): string;
  full(): boolean;
}

function collector(budget = MAX_OUTPUT_BYTES): Collector {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  return {
    push(chunk) {
      if (truncated) return;
      const room = budget - size;
      if (chunk.length > room) {
        if (room > 0) chunks.push(chunk.subarray(0, room));
        size = budget;
        truncated = true;
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    },
    text() {
      const body = Buffer.concat(chunks, size).toString("utf8");
      return truncated ? body + TRUNCATION : body;
    },
    full() {
      return truncated;
    },
  };
}

/** Kills a child's whole process group, so a command the block started dies with it. */
function killGroup(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone; `close` settles the run.
  }
}

/** Classifies a completed block's stderr: a memory or network violation is named from the runtime's own message. */
export function classify(stderr: string, timedOut: boolean, outputLimited: boolean): ViolationKind {
  if (timedOut) return "timeout";
  if (outputLimited) return "output";
  if (/heap out of memory|Allocation failed|Reached heap limit/i.test(stderr)) return "memory";
  if (/network access is disabled|EAI_AGAIN|ENETUNREACH|getaddrinfo/i.test(stderr)) return "network";
  if (/EACCES|EPERM|operation not permitted|read-only file system/i.test(stderr)) return "filesystem";
  return "none";
}

/** The shell binary for a `bash` block, falling back to a bare name on a minimal image. */
function shellOf(): { command: string; args: (code: string) => string[] } {
  return { command: "/bin/bash", args: (code) => ["-c", code] };
}

/** The Node preload that makes the network throw before a block runs. */
const DENY_NETWORK = `import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import dns from "node:dns";
const deny = () => { throw new Error("network access is disabled for this example"); };
globalThis.fetch = deny;
net.connect = net.createConnection = deny;
http.request = http.get = deny;
https.request = https.get = deny;
tls.connect = deny;
dns.lookup = dns.resolve = deny;
syncBuiltinESMExports();
`;

/** The file a Node or TypeScript block is written to. */
function fileOf(lang: BlockLang): string {
  return lang === "ts" ? "main.ts" : "main.mjs";
}

/** The environment a block runs with: an allow-list, `HOME`/`TMPDIR` inside the folder, and the memory limit. */
function environment(root: string, memoryMb: number): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: join(root, "home"),
    TMPDIR: join(root, "tmp"),
    NODE_V8_COVERAGE: join(root, "tmp"),
    ...(memoryMb === 0 ? {} : { NODE_OPTIONS: `--max-old-space-size=${memoryMb}` }),
    LANG: "C.UTF-8",
    NO_COLOR: "1",
  };
}

/** Runs one block in `root`, collecting both streams and enforcing the timeout and output cap. */
function runChild(
  plan: SandboxPlan,
  root: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; outputLimited: boolean; error?: string }> {
  return new Promise((settle) => {
    const stdout = collector();
    const stderr = collector();
    let timedOut = false;
    let outputLimited = false;
    let error: string | undefined;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle({ exitCode, stdout: stdout.text(), stderr: stderr.text(), timedOut, outputLimited, ...(error === undefined ? {} : { error }) });
    };
    let child: ChildProcess;
    try {
      child = spawn(plan.command, [...plan.args], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason);
      finish(null);
      return;
    }
    const stop = (reason: "timeout" | "output"): void => {
      if (settled || timedOut || outputLimited) return;
      if (reason === "timeout") timedOut = true;
      else outputLimited = true;
      clearTimeout(timer);
      killGroup(child);
    };
    timer = setTimeout(() => stop("timeout"), timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      if (stdout.full()) stop("output");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
      if (stderr.full()) stop("output");
    });
    child.once("error", (reason) => {
      error = reason.message;
      finish(null);
    });
    child.once("close", (code) => finish(code));
  });
}

/**
 * Runs a session: a fresh folder, the fixtures copied in, then each block in order in the same folder and environment,
 * so state a block writes is there for the next. A block that fails stops the session before the next one when
 * `stopOnFailure` is set (the runbook default); a plain multi-block example also stops, because a later block that
 * depends on state cannot be trusted after a failure.
 */
export async function runSession(options: RunSessionOptions): Promise<SessionResult> {
  const limits: SessionLimits = {
    timeoutMs: options.limits.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    memoryMb: options.limits.memoryMb ?? 0,
    network: options.limits.network ?? "deny",
  };
  if (!Number.isFinite(limits.timeoutMs) || limits.timeoutMs <= 0) {
    throw new RangeError(`timeoutMs must be a positive number of milliseconds, not ${String(limits.timeoutMs)}.`);
  }
  const stopOnFailure = options.stopOnFailure ?? true;
  const root = await realpath(await mkdtemp(join(tmpdir(), "mizzen-session-")));
  const results: BlockResult[] = [];
  let sandboxed = false;
  try {
    await Promise.all([mkdir(join(root, "home"), { recursive: true }), mkdir(join(root, "tmp"), { recursive: true })]);
    for (const [path, contents] of Object.entries(options.fixtures ?? {})) {
      const target = join(root, path);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, contents);
    }
    if (limits.network === "deny") await writeFile(join(root, "deny-network.mjs"), DENY_NETWORK);
    await writeFile(join(root, "package.json"), '{\n  "type": "module"\n}\n');

    for (const block of options.blocks) {
      const denied = deniedCommand(block.code, block.lang === "bash" ? "shell" : "node");
      if (denied !== undefined) {
        results.push({ id: block.id, lang: block.lang, ok: false, exitCode: null, stdout: "", stderr: `The block was not run: it uses the denied command "${denied}".\n`, violation: "command", sandboxed: false, refused: denied });
        if (stopOnFailure) break;
        continue;
      }

      let plan: SandboxPlan;
      if (block.lang === "bash") {
        const shell = shellOf();
        plan = await planSandbox(shell.command, shell.args(block.code), root);
      } else {
        const file = fileOf(block.lang);
        await writeFile(join(root, file), block.code);
        const preload = limits.network === "deny" ? ["--import", "./deny-network.mjs"] : [];
        plan = await planSandbox(process.execPath, [...preload, file], root);
      }
      sandboxed = plan.sandboxed;

      const outcome = await runChild(plan, root, environment(root, limits.memoryMb), limits.timeoutMs);
      await plan.cleanup();
      const violation = outcome.error === undefined ? classify(outcome.stderr, outcome.timedOut, outcome.outputLimited) : "none";
      const stderr = outcome.error === undefined ? outcome.stderr : `${outcome.error}\n`;
      const ok = outcome.exitCode === 0 && outcome.error === undefined && violation === "none";
      results.push({ id: block.id, lang: block.lang, ok, exitCode: outcome.exitCode, stdout: outcome.stdout, stderr, violation, sandboxed: plan.sandboxed });
      if (!ok && stopOnFailure) break;
    }
    return { blocks: results, sandboxed };
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

/** True when the host offers an OS sandbox; a caller reports the honest isolation state once per run. */
export function sessionSandboxAvailable(): boolean {
  return sandboxAvailable();
}
