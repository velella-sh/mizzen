/**
 * The deterministic environment pins of one evaluation case.
 *
 * A run records the engine version, the package it came from, the tool versions, and SHA-256 hashes
 * of the fixture tree, the fixture configuration, the compiled context pack, and the recorded agent
 * output. Two reports are comparable only when every pin agrees; a suite whose engine or tool pins
 * do not match the running adapter invalidates the run instead of comparing it.
 */
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { Site } from "../contracts/content.ts";
import type { CompiledContext } from "../context/types.ts";
import type { EvalCase, EvalCasePins, EvalProblem } from "../contracts/evals.ts";
import type { TaskContract } from "../contracts/task.ts";
import { readBlocksLock } from "../blocks/lock.ts";
import { compileTaskContext } from "../context/compile.ts";
import { sha256 } from "../data/lock.ts";
import { version } from "../index.ts";
import { buildModel } from "../model/build.ts";
import { snapshotIdOf } from "../tasks/snapshot.ts";

/** Folders a build may write; they are never evaluation input. */
const TRANSIENT = new Set([".mizzen", ".tmp", "node_modules", ".git"]);

/** A SHA-256 of one string. */
export function hashText(text: string): string {
  return sha256(text);
}

/** A SHA-256 over every file under `root`, sorted by site-relative path. */
export async function hashTree(root: string): Promise<string> {
  const entries: { readonly path: string; readonly hash: string }[] = [];
  const walk = async (dir: string): Promise<void> => {
    const names = await readdir(dir, { withFileTypes: true });
    names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of names) {
      if (TRANSIENT.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        entries.push({
          path: relative(root, path).split(sep).join("/"),
          hash: createHash("sha256").update(await readFile(path)).digest("hex"),
        });
      }
    }
  };
  await walk(root);
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return sha256(`mizzen-eval-fixture\0${entries.map((entry) => `${entry.path}\0${entry.hash}`).join("\n")}`);
}

/** The site-relative pages a case's task scope names, so the pack is compiled for the case's goal. */
function scopePagesOf(value: EvalCase): readonly string[] {
  const expected = value.expected;
  if (expected === undefined) return [];
  switch (expected.kind) {
    case "discovery":
    case "context":
      return expected.pages;
    case "answer":
      return expected.citations.map((citation) => citation.replace(/:\d+(?::\d+)?$/, ""));
    case "edit":
      return [expected.path];
    case "transaction":
      return expected.attempted;
    case "conflict":
      return expected.overlap;
    default:
      return [];
  }
}

/** The deterministic task a case compiles its pack from. */
export function evalTask(value: EvalCase, fixture: string, config: string): TaskContract {
  const snapshot = {
    content: fixture,
    data: sha256(`eval-data\0${fixture}`),
    config,
    tooling: sha256(`eval-tooling\0${version}`),
  };
  return {
    version: 1,
    idempotencyKey: `eval-${value.id}`,
    goal: value.goal,
    scope: { pages: scopePagesOf(value), blocks: [], collections: [], symbols: [], files: [] },
    snapshot: { ...snapshot, id: snapshotIdOf(snapshot) },
    budget: { contextTokens: value.budget.maxTokens, toolCalls: value.budget.maxToolCalls, timeMs: 300_000 },
    permissions: value.permissions,
    acceptance: value.criteria.map((criterion) => ({
      id: criterion.id,
      statement: criterion.statement,
      review: true as const,
    })),
  };
}

/** What one case run measured before its agent output was scored. */
export interface CaseFacts {
  readonly pins: EvalCasePins;
  readonly compiled?: CompiledContext;
  readonly site?: Site;
  readonly problems: readonly EvalProblem[];
}

/** Resolves a suite-relative path, refusing one that escapes the suite. */
export function casePath(suiteRoot: string, path: string): string {
  const root = resolve(suiteRoot);
  const target = resolve(root, path);
  return target === root || target.startsWith(`${root}${sep}`) ? target : root;
}

/** Hashes one case's fixture, config, pack, and recorded agent output. */
export async function caseFacts(value: EvalCase, suiteRoot: string, site?: Site): Promise<CaseFacts> {
  const fixtureRoot = casePath(suiteRoot, value.fixture);
  const problems: EvalProblem[] = [];
  let fixture = "missing";
  let config = "missing";
  try {
    fixture = await hashTree(fixtureRoot);
    config = hashText(await readFile(join(fixtureRoot, "mizzen.yml"), "utf8"));
  } catch (error) {
    problems.push({
      path: "/fixture",
      code: "eval.fixture-missing",
      message: `${value.fixture}: cannot hash the fixture: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  let agent = "none";
  if (value.inputs?.agent !== undefined) {
    try {
      agent = hashText(await readFile(casePath(suiteRoot, value.inputs.agent), "utf8"));
    } catch (error) {
      problems.push({
        path: "/inputs/agent",
        code: "eval.input-missing",
        message: `${value.inputs.agent}: cannot read the recorded agent output: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  let compiled: CompiledContext | undefined;
  let model = site;
  let pack = "none";
  if (problems.length === 0) {
    try {
      model = model ?? (await buildModel(fixtureRoot)).site;
      const { lock } = await readBlocksLock(fixtureRoot);
      compiled = await compileTaskContext(model, evalTask(value, fixture, config), {
        lock,
        root: fixtureRoot,
        maxTokens: value.budget.maxTokens,
      });
      pack = compiled.cache.key;
    } catch (error) {
      problems.push({
        path: "",
        code: "eval.pack-unavailable",
        message: `${value.id}: cannot compile the case context: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  return {
    pins: { fixture, config, pack, agent },
    ...(compiled === undefined ? {} : { compiled }),
    ...(model === undefined ? {} : { site: model }),
    problems,
  };
}
