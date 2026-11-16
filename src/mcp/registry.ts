/**
 * Discovers tools from a folder, so adding a tool never edits a shared list: every `.ts` or `.js` file in the folder,
 * in file-name order, exports one {@link Tool} (as `tool` or as the default export) whose name is the file name.
 * Input is checked against the tool's schema before its handler runs.
 */
import { Ajv, type ValidateFunction } from "ajv";
import { readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Tool, ToolSetup } from "./tool.ts";

/** A tool file that cannot be used. */
export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

/** The tools of one server, with a validator for each. */
export interface Registry {
  /** Registered tools in name order. */
  readonly tools: readonly Tool[];
  get(name: string): Tool | undefined;
  /** The problems of `input` against the tool's schema, or none. */
  validate(name: string, input: unknown): readonly string[];
}

const ajv = new Ajv({ allErrors: true, strict: false });

/** Builds a registry from already-imported tools. */
export function registryOf(tools: readonly Tool[]): Registry {
  const sorted = [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const validators = new Map<string, ValidateFunction>();
  for (const tool of sorted) validators.set(tool.name, ajv.compile(tool.inputSchema));
  const byName = new Map(sorted.map((tool) => [tool.name, tool] as const));
  return {
    tools: sorted,
    get: (name) => byName.get(name),
    validate(name, input) {
      const validator = validators.get(name);
      if (validator === undefined) return [`unknown tool: ${name}`];
      if (validator(input)) return [];
      return (validator.errors ?? []).map((e) => `${e.instancePath === "" ? "input" : `input${e.instancePath}`} ${e.message ?? "is invalid"}`);
    },
  };
}

/** Loads the tools in `dir`; a file whose export is not a tool named like the file is a {@link RegistryError}. */
export async function loadTools(dir: string, setup: ToolSetup): Promise<Registry> {
  const files = (await readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.(?:ts|js)$/.test(entry.name) && !entry.name.endsWith(".d.ts"))
    .map((entry) => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const tools: Tool[] = [];
  for (const file of files) {
    const mod = (await import(pathToFileURL(join(dir, file)).href)) as Record<string, unknown>;
    const candidate = (mod.tool ?? mod.default) as Partial<Tool> | undefined;
    if (
      candidate === undefined ||
      typeof candidate.name !== "string" ||
      typeof candidate.description !== "string" ||
      typeof candidate.handler !== "function" ||
      typeof candidate.inputSchema !== "object" ||
      candidate.inputSchema === null
    ) {
      throw new RegistryError(`${file} must export a tool: { name, description, inputSchema, handler }.`);
    }
    const expected = basename(file, extname(file));
    if (candidate.name !== expected) {
      throw new RegistryError(`${file} exports a tool named "${candidate.name}"; the name must be "${expected}".`);
    }
    const tool = candidate as Tool;
    if (tool.enabled !== undefined && !tool.enabled(setup)) continue;
    tools.push(tool);
  }
  return registryOf(tools);
}
