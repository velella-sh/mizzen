/**
 * Type-checks JavaScript and TypeScript examples against a fixture's real exports (#1327).
 *
 * A `ts` or `js` example is copied into a temporary folder together with the fixture files it imports by relative path,
 * and compiled there with the installed TypeScript compiler in `--noEmit` mode. A type error is reported at the fence's
 * own source span, not at the temporary file, and the message names the symbol and the line inside the block that
 * produced it, so a reader can go from the finding to the exact line of the example.
 *
 * The check is offline: the compiler reads the block and the fixture files it imports. It never downloads types and
 * never runs the example. A fixture that cannot be resolved is one finding, not a crash, and a missing compiler is one
 * warning rather than a failed build.
 */
import { cp, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { SourcePos } from "../contracts/source.ts";
import type { MarkdownExample } from "../markdown/plugins/example-fence.ts";

/** The stable id of a finding that reports a type error in an example. */
export const EXAMPLE_TYPE_ERROR_ID = "example-type-error";

/** The stable id of a finding that reports an example that could not be type-checked. */
export const EXAMPLE_TYPE_UNCHECKED_ID = "example-type-unchecked";

/** The diagnostic shape this module reports; the caller turns it into the engine's `Diagnostic`. */
export interface ExampleTypeFinding {
  readonly id: typeof EXAMPLE_TYPE_ERROR_ID | typeof EXAMPLE_TYPE_UNCHECKED_ID;
  readonly severity: "error" | "warning";
  /** One visible line, naming the symbol and where in the block the error sits. */
  readonly message: string;
  /** The fence's span in the page's source. */
  readonly pos: SourcePos;
  readonly help?: string;
}

/** One type error the compiler reported. */
export interface TypeProblem {
  /** The temporary file the compiler named. */
  readonly file: string;
  readonly line: number;
  readonly column: number;
  /** `TS2322`, and so on. */
  readonly code: string;
  /** The compiler's message, one line. */
  readonly message: string;
}

/** What {@link typeCheckExample} needs. */
export interface TypeCheckOptions {
  /** The example, with its fence span and language. */
  readonly example: MarkdownExample;
  /** Absolute site root: where `node_modules` is found. */
  readonly root: string;
  /** Absolute source folder, where the fixture files live. */
  readonly sourceDir: string;
  /** The block's file name, so the reported span is the page's file. */
  readonly file: string;
  /** The `tsc` entry to run; default the installed TypeScript. A test passes a stub. */
  readonly tsc?: string;
  /** How long the compiler may run; default 30 seconds. */
  readonly timeoutMs?: number;
}

/** Languages this check compiles; a shell, `output`, or hidden block is not one. */
export function typeCheckable(lang: string, role: string | undefined): boolean {
  if (role === "setup" || role === "teardown" || role === "step") return false;
  const lower = lang.trim().toLowerCase();
  return lower === "ts" || lower === "js" || lower === "mjs" || lower === "tsx" || lower === "jsx";
}

/** The installed `tsc` entry, resolved next to the engine's `node_modules`, so a packed install still finds it. */
export function defaultTypeScript(): string {
  return fileURLToPath(new URL("../../node_modules/typescript/bin/tsc", import.meta.url));
}

/** The `node_modules` folder the engine itself ships with, so the compiler finds `@types/node` in a packed install. */
export function engineModulesDir(): string {
  return fileURLToPath(new URL("../../node_modules", import.meta.url));
}

/** The relative import specifiers a block names, such as `./fixture.ts` or `../lib/index.ts`. */
export function relativeImportsOf(code: string): string[] {
  const found = new Set<string>();
  for (const match of code.matchAll(/\b(?:from|import|require)\s*\(?\s*(["'`])(\.[^"'`]*)\1/g)) {
    if (match[2] !== undefined) found.add(match[2]);
  }
  return [...found].sort();
}

/** Resolves a relative specifier to an existing source file, trying the usual extensions and `index` files. */
async function resolveImport(from: string, specifier: string): Promise<string | undefined> {
  const base = resolve(dirname(from), specifier);
  const candidates = /\.(?:[cm]?[jt]sx?)$/.test(specifier)
    ? [base]
    : [`${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, `${base}.jsx`, join(base, "index.ts"), join(base, "index.js")];
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Try the next spelling.
    }
  }
  return undefined;
}

/** Runs `tsc` with `--noEmit` over `files`, returning its combined output and exit code. */
function runTsc(tsc: string, cwd: string, files: readonly string[], timeoutMs: number): Promise<{ output: string; code: number | null }> {
  return new Promise((settle) => {
    let output = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle({ output, code });
    };
    const child = spawn(
      process.execPath,
      [
        tsc,
        "--ignoreConfig",
        "--noEmit",
        "--pretty",
        "false",
        "--strict",
        "--skipLibCheck",
        "--allowImportingTsExtensions",
        "--module",
        "nodenext",
        "--moduleResolution",
        "nodenext",
        "--target",
        "esnext",
        "--types",
        "node",
        ...files,
      ],
      { cwd, env: { ...process.env, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] },
    );
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.once("error", () => finish(null));
    child.once("close", (code) => finish(code));
  });
}

/** Parses `file(line,column): error TSxxxx: message` lines. Anything else is ignored. */
export function typeProblemsOf(output: string): TypeProblem[] {
  const problems: TypeProblem[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.*)$/.exec(line.trim());
    if (!match) continue;
    problems.push({ file: match[1]!, line: Number(match[2]), column: Number(match[3]), code: match[4]!, message: match[5]! });
  }
  return problems;
}

/** The symbol a message names, in backticks or after `Cannot find name`, or `undefined`. */
export function symbolOf(message: string): string | undefined {
  return /`([^`]+)`/.exec(message)?.[1] ?? /Cannot find name '([^']+)'/.exec(message)?.[1];
}

/** The extension the example is compiled as. */
function extensionOf(lang: string): string {
  const lower = lang.trim().toLowerCase();
  if (lower === "js" || lower === "mjs") return "js";
  if (lower === "jsx") return "jsx";
  if (lower === "tsx") return "tsx";
  return "ts";
}

/** The fence's span in the page's source. */
function spanOf(example: MarkdownExample): Omit<SourcePos, "file"> {
  return { line: example.pos.line, column: example.pos.column, endLine: example.pos.endLine, endColumn: example.pos.endColumn };
}

/** The one finding for a block that could not be checked at all. */
function unchecked(options: TypeCheckOptions, reason: string): ExampleTypeFinding {
  return {
    id: EXAMPLE_TYPE_UNCHECKED_ID,
    severity: "warning",
    message: `${options.example.id} at ${options.file}:${options.example.pos.line} was not type-checked: ${reason}.`,
    pos: { file: options.file, ...spanOf(options.example) },
  };
}

/** True when `path` leaves `root`, for a specifier that tries to escape; such an import is not copied. */
function escapes(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/**
 * Type-checks one example. The block and the fixture files it imports by relative path are copied into a temporary
 * folder that mirrors their paths under `sourceDir`, then compiled there. Every error in the block becomes one finding
 * at the fence; an error in a copied fixture is not the example's finding.
 */
export async function typeCheckExample(options: TypeCheckOptions): Promise<ExampleTypeFinding[]> {
  if (!typeCheckable(options.example.lang, options.example.role)) return [];
  const tsc = options.tsc ?? defaultTypeScript();
  const work = await mkdtemp(join(tmpdir(), "mizzen-typecheck-"));
  try {
    const extension = extensionOf(options.example.lang);
    const blockName = `__mizzen_example__.${extension}`;

    // The block's own folder mirrors its source-relative path, so a relative import lands on the copied fixture too.
    const blockDir = join(work, dirname(options.file.split("\\").join("/")));
    await mkdir(blockDir, { recursive: true });
    const block = join(blockDir, blockName);
    await writeFile(block, options.example.code);

    const sourceDir = resolve(options.sourceDir);
    for (const specifier of relativeImportsOf(options.example.code)) {
      const real = await resolveImport(resolve(sourceDir, options.file), specifier);
      if (real === undefined || escapes(sourceDir, real)) continue;
      const copy = join(work, relative(sourceDir, real).split(sep).join("/"));
      await mkdir(dirname(copy), { recursive: true });
      await cp(real, copy);
    }

    // A package import resolves from the site root, so the temporary folder sees the same installed types. The engine's
    // own `node_modules` backs it up, so `@types/node` is found even for a site that installs nothing. On POSIX a link
    // to a missing target is created without error, so the target is checked first.
    await writeFile(join(work, "package.json"), JSON.stringify({ type: "module" }));
    for (const modules of [join(options.root, "node_modules"), engineModulesDir()]) {
      try {
        if (!(await stat(modules)).isDirectory()) continue;
        await symlink(modules, join(work, "node_modules"), "dir");
        break;
      } catch {
        // Try the next folder; a builtin-only example still checks with no types at all.
      }
    }

    const timeoutMs = options.timeoutMs ?? 30_000;
    const { output, code } = await runTsc(tsc, work, [block], timeoutMs);
    // This compiler reports errors on stdout while still exiting non-zero, so the output decides the findings.
    if (code === null) return [unchecked(options, `the compiler did not finish within ${timeoutMs}ms`)];

    const findings: ExampleTypeFinding[] = [];
    for (const problem of typeProblemsOf(output)) {
      // The compiler names a path relative to its working folder; resolve it before comparing. Only errors in the
      // block itself count: a copied fixture with its own errors is not this example's finding.
      if (resolve(work, problem.file) !== block) continue;
      const symbol = symbolOf(problem.message);
      const line = options.example.pos.line + Math.max(0, problem.line - 1);
      findings.push({
        id: EXAMPLE_TYPE_ERROR_ID,
        severity: "error",
        message: `${options.example.id} at ${options.file}:${line} has a type error${symbol === undefined ? "" : ` on \`${symbol}\``}: ${problem.message} (${problem.code}).`,
        pos: { file: options.file, ...spanOf(options.example) },
        help: "Fix the example so its code type-checks against the fixture's real exports.",
      });
    }
    return findings;
  } catch (error) {
    return [unchecked(options, error instanceof Error ? error.message : String(error))];
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
