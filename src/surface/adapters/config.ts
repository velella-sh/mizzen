/**
 * Discover public configuration (#1340): reads every key of `schema/config.schema.json`, its type, its default, and
 * its deprecation status from the schema, and checks the top-level defaults against the real resolver
 * (`loadConfigText`), so a documented default the resolver does not apply is a finding rather than a guessed item.
 *
 * The item's source span points at the key's own line and column in the schema file, because the schema is the public
 * statement of the key.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import type { SourcePos } from "../../contracts/source.ts";
import type { SurfaceAdapterResult, SurfaceFinding, SurfaceItem, SurfaceStability } from "../../contracts/surface.ts";
import { loadConfigText } from "../../config/load.ts";
import { itemId, sortItems } from "../contract.ts";
import { member, parseJsonWithPositions, type JsonNode } from "../json-pos.ts";

/** The schema the loader compiles, at the package's `schema/config.schema.json`. */
const CONFIG_SCHEMA = fileURLToPath(new URL("../../../schema/config.schema.json", import.meta.url));

/** What a config discovery needs. */
export interface DiscoverConfigOptions {
  /** Absolute or site-relative path of the config schema; defaults to this package's. */
  readonly schema?: string;
  /** The version the config ships in, so its items carry an introduction version. Default: none. */
  readonly version?: string;
}

/** The type name a schema node declares, for the item's signature. */
function typeOf(node: JsonNode): string {
  const type = member(node, "type")?.value;
  if (typeof type === "string") return type;
  if (Array.isArray(type)) return type.join(" | ");
  if (member(node, "enum") !== undefined) return "enum";
  if (member(node, "$ref") !== undefined) return "ref";
  if (member(node, "oneOf") !== undefined) return "oneOf";
  if (member(node, "anyOf") !== undefined) return "anyOf";
  if (member(node, "allOf") !== undefined) return "allOf";
  if (member(node, "properties") !== undefined) return "object";
  if (member(node, "items") !== undefined) return "array";
  return "unknown";
}

/** The stability a schema node declares: `deprecated: true` marks it deprecated. */
function stabilityOf(node: JsonNode): SurfaceStability {
  return member(node, "deprecated")?.value === true ? "deprecated" : "stable";
}

/** One key to record: its dot path, its schema node, and the key's own span. */
interface KeyEntry {
  readonly path: string;
  readonly node: JsonNode;
  readonly parent?: string;
}

/** Every config key, walking `properties` recursively, with each key's span taken from its object member. */
function configKeys(root: JsonNode): KeyEntry[] {
  const entries: KeyEntry[] = [];
  const walk = (node: JsonNode, path: string, parent: string | undefined): void => {
    entries.push({ path, node, ...(parent === undefined ? {} : { parent }) });
    const properties = member(node, "properties");
    if (properties?.members === undefined) return;
    for (const [name, child] of properties.members) {
      const childPath = path === "" ? name : `${path}.${name}`;
      walk(child, childPath, path === "" ? undefined : path);
    }
  };
  const properties = member(root, "properties");
  if (properties?.members !== undefined) {
    for (const [name, child] of properties.members) walk(child, name, undefined);
  }
  return entries;
}

/** A config object that exercises the resolver with no key set, for comparing its defaults. */
function resolvedDefaults(): Record<string, unknown> {
  const { config } = loadConfigText("title: surface default probe\n", "mizzen.yml", "surface");
  return config as unknown as Record<string, unknown>;
}

/** True when the resolver agrees with the schema for a top-level key's declared default. */
function defaultAgrees(path: string, node: JsonNode, resolved: Record<string, unknown>): boolean {
  if (path.includes(".")) return true;
  // A key the schema gives no default is one the resolver may compute (`dir` from `lang`); there is nothing to compare.
  if (member(node, "default") === undefined) return true;
  const declared = member(node, "default")!.value;
  return JSON.stringify(resolved[path]) === JSON.stringify(declared);
}

/** The span a key is declared at: its own key position, so a report points at the key, not the value. */
function keySpan(node: JsonNode, file: string, fallbackLine: number): SourcePos {
  return node.keySpan ?? { file, line: fallbackLine, column: 1, endLine: fallbackLine, endColumn: 1 };
}

/**
 * Reads the config schema's public keys with their types and defaults, and checks the resolver against it. A schema
 * that does not parse or compile is one error finding and no items, never a partial report.
 */
export async function discoverConfig(options: DiscoverConfigOptions = {}): Promise<SurfaceAdapterResult> {
  const file = options.schema === undefined ? CONFIG_SCHEMA : resolve(options.schema);
  const display = options.schema === undefined ? "schema/config.schema.json" : options.schema;
  const text = await readFile(file, "utf8");
  let root: JsonNode;
  try {
    root = parseJsonWithPositions(text, display);
  } catch (error) {
    return {
      version: 1,
      area: "config",
      items: [],
      findings: [{
        code: "surface.config-schema",
        severity: "error",
        message: `Cannot parse ${display}: ${error instanceof Error ? error.message : String(error)}.`,
      }],
    };
  }
  const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;
  try {
    new Ajv2020({ strict: true, allErrors: true }).compile(root.value as object);
  } catch (error) {
    return { version: 1, area: "config", items: [], findings: [{ code: "surface.config-schema", severity: "error", message: `The config schema does not compile: ${error instanceof Error ? error.message : String(error)}.` }] };
  }

  const entries = configKeys(root);
  const resolved = resolvedDefaults();
  const findings: SurfaceFinding[] = [];
  const items: SurfaceItem[] = entries.map((entry) => ({
    id: itemId("config-key", entry.path),
    area: "config",
    kind: "config-key",
    name: entry.path,
    ...(entry.parent === undefined ? {} : { parent: itemId("config-key", entry.parent) }),
    source: keySpan(entry.node, display, root.span.line),
    stability: stabilityOf(entry.node),
    signature: typeOf(entry.node),
    ...(options.version === undefined ? {} : { version: { introduced: options.version } }),
  }));

  for (const entry of entries) {
    if (!defaultAgrees(entry.path, entry.node, resolved)) {
      findings.push({
        code: "config.default-drift",
        severity: "warning",
        message: `\`${entry.path}\` defaults to ${JSON.stringify(member(entry.node, "default")?.value)} in the schema but the resolver produces ${JSON.stringify(resolved[entry.path])}.`,
        pos: keySpan(entry.node, display, root.span.line),
      });
    }
  }

  return { version: 1, area: "config", items: sortItems(items), findings };
}
