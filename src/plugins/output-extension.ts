import type { Diagnostic, Output, OutputContext, OutputFile, Site } from "../contracts/index.ts";
import {
  DEFAULT_HOOK_POLICY,
  isHookDeadline,
  resolveHookTimeout,
  runWithinDeadline,
  type HookPolicy,
} from "./policy.ts";

/** A custom output a plugin declares: the plugin that owns it, and the output itself. */
export interface DeclaredOutput {
  /** The plugin's name, for diagnostics. */
  readonly plugin: string;
  /** The declared output; its `name` is unique across the build's outputs. */
  readonly output: Output;
}

/** What {@link runDeclaredOutputs} produced. */
export interface DeclaredOutputs {
  /** The files of the accepted outputs, in declaration order and then each output's own order. */
  readonly files: readonly OutputFile[];
  /** Problems that kept an output or its files out; empty when every declared output was accepted whole. */
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * True for a path an output may write: relative, `/`-separated, and with no empty, `.`, or `..` segment.
 * The outputs layer keeps this rule private (`isInside` in `src/pipeline/build.ts`); this is the plugin-facing copy.
 */
function isInsideOutput(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/.test(path)) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function detailOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Runs the outputs plugins declare on the fixed site model, in declaration order.
 *
 * An output whose name a built-in output or an earlier declaration already uses is reported and skipped, and so is one
 * that throws or misses the policy's deadline; the declarations after it still run. Every file of an accepted output
 * is checked before any of them is returned: a path outside the output folder drops that output whole, so a build
 * never writes part of one.
 */
export async function runDeclaredOutputs(
  declared: readonly DeclaredOutput[],
  site: Site,
  context: OutputContext,
  builtinNames: readonly string[],
  policy: HookPolicy = DEFAULT_HOOK_POLICY,
): Promise<DeclaredOutputs> {
  const timeoutMs = resolveHookTimeout(policy);
  const taken = new Map<string, string>();
  for (const name of builtinNames) taken.set(name, "the build already has");
  const files: OutputFile[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const { plugin, output } of declared) {
    const owner = taken.get(output.name);
    if (owner !== undefined) {
      diagnostics.push({
        id: "output.duplicate-name",
        severity: "error",
        message: `Plugin "${plugin}" declares output "${output.name}", which ${owner}; it is dropped.`,
        help: "Give the output a unique name, or turn the other one off.",
      });
      continue;
    }
    taken.set(output.name, `plugin "${plugin}" already declares`);

    let produced: readonly OutputFile[];
    try {
      produced = await runWithinDeadline(Promise.resolve(output.run(site, context)), timeoutMs);
    } catch (err) {
      if (isHookDeadline(err)) {
        diagnostics.push({
          id: "output.timeout",
          severity: "error",
          message: `Plugin "${plugin}" output "${output.name}" did not finish within ${timeoutMs} ms; it is dropped.`,
          help: "Make the output finish sooner, or raise the deadline of the hook policy.",
        });
      } else {
        diagnostics.push({
          id: "output.failed",
          severity: "error",
          message: `Plugin "${plugin}" output "${output.name}" failed: ${detailOf(err)}.`,
          help: "Fix the output or remove it from the site's code file.",
        });
      }
      continue;
    }

    const bad = produced.find((file) => !isInsideOutput(file.path));
    if (bad !== undefined) {
      diagnostics.push({
        id: "output.bad-path",
        severity: "error",
        message: `Plugin "${plugin}" output "${output.name}" writes "${bad.path}", which is not inside the output folder; the output is dropped.`,
        help: "Use a relative path with `/` separators and no `..`.",
      });
      continue;
    }
    files.push(...produced);
  }
  return { files, diagnostics };
}
