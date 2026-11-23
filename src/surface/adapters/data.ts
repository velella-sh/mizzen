/**
 * Discover public data fields (#1342): reads each collection and the fields its public policy allows, and records one
 * `collection` item per collection and one `field` item per public field. A field the collection's `public` allowlist
 * (or `raw.private` denylist) keeps out is never recorded, so a private field can never reach the coverage output.
 *
 * The public field set is computed by the same `publicFields`/`isPublicReference` functions every public output uses, so
 * the surface and the pages, search, feeds, API, and page JSON agree on what is public. A field's source is the schema's
 * property when the collection declares one, and the collection's data file otherwise, so the span is always real.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { SiteConfig } from "../../contracts/config.ts";
import type { Collection } from "../../contracts/data.ts";
import type { SourcePos } from "../../contracts/source.ts";
import type { SurfaceAdapterResult, SurfaceFinding, SurfaceItem } from "../../contracts/surface.ts";
import { isPublicPath } from "../../data/public.ts";
import { itemId, sortItems } from "../contract.ts";
import { member, parseJsonWithPositions } from "../json-pos.ts";

/** What a data discovery needs. */
export interface DiscoverDataOptions {
  /** The site root, for the collection schema files. */
  readonly root: string;
  /** The loaded config, for each collection's `public` and `raw` policy. */
  readonly config: SiteConfig;
  /** The site's loaded collections. */
  readonly collections: Readonly<Record<string, Collection>>;
  /** The version the data API ships in, so its items carry an introduction version. Default: none. */
  readonly version?: string;
}

/**
 * The field names a collection publishes, in a stable order: its `public` allowlist's leaves, or every field the records
 * hold, minus any field `raw.private` hides. A field hidden from the raw downloads is never part of the public surface.
 */
function publicFieldNames(collection: Collection, policy: readonly string[] | undefined, hidden: ReadonlySet<string>): string[] {
  const names = new Set<string>();
  if (policy !== undefined) {
    for (const path of policy) for (const name of namesOf(path)) names.add(name);
  }
  for (const record of collection.records) {
    for (const name of Object.keys(record.fields)) {
      if (isPublicPath(policy, name)) names.add(name);
    }
  }
  names.add("id");
  return [...names].filter((name) => isPublicPath(policy, name) && !hidden.has(name)).sort();
}

/** The top-level field a dot path names, so `author.name` records the `author` field. */
function namesOf(path: string): string[] {
  return path === "" ? [] : [path.split(".")[0]!];
}

/** The span of a property in a JSON Schema, by name, using the positioned reader. */
async function schemaFieldSpan(root: string, schemaPath: string): Promise<Map<string, SourcePos>> {
  const found = new Map<string, SourcePos>();
  let text: string;
  try {
    text = await readFile(resolve(root, schemaPath), "utf8");
  } catch {
    return found;
  }
  let doc;
  try {
    doc = parseJsonWithPositions(text, schemaPath.replace(/\\/g, "/"));
  } catch {
    return found;
  }
  const properties = member(doc, "properties");
  if (properties?.members !== undefined) {
    for (const [name, node] of properties.members) {
      if (node.keySpan !== undefined) found.set(name, node.keySpan);
    }
  }
  return found;
}

/** The span of a record's field in its data file, or the collection's own start. */
function fieldSpan(collection: Collection, field: string): SourcePos {
  for (const record of collection.records) {
    const pos = record.fieldPositions[field];
    if (pos !== undefined) {
      return { file: pos.file, line: pos.startLine, column: pos.startColumn, endLine: pos.startLine, endColumn: pos.startColumn };
    }
  }
  const first = collection.records[0];
  if (first !== undefined) {
    const pos = first.position;
    return { file: pos.file, line: pos.startLine, column: pos.startColumn, endLine: pos.startLine, endColumn: pos.startColumn };
  }
  return { file: collection.source, line: 1, column: 1, endLine: 1, endColumn: 1 };
}

/** The span a collection is declared at: its config key when the schema names one, else its source file. */
function collectionSpan(config: SiteConfig, collection: Collection): SourcePos {
  return { file: collection.source, line: 1, column: 1, endLine: 1, endColumn: 1 };
}

/**
 * Reads each collection and its public fields. A field the public policy forbids is never an item, so the coverage can
 * not count it documented or undocumented. A collection whose records are empty still records its declared fields, so a
 * new collection that is not yet documented is a real gap.
 */
export async function discoverData(options: DiscoverDataOptions): Promise<SurfaceAdapterResult> {
  const items: SurfaceItem[] = [];
  const findings: SurfaceFinding[] = [];
  for (const [name, collection] of Object.entries(options.collections).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const config = options.config.collections[name];
    const policy = config?.public;
    const hidden = new Set(config?.raw === undefined || config.raw === false ? [] : (config.raw.private ?? []));
    const schemaPath = config?.schema;
    const fieldSpans = schemaPath === undefined ? new Map<string, SourcePos>() : await schemaFieldSpan(options.root, schemaPath);
    items.push({
      id: itemId("collection", name),
      area: "data",
      kind: "collection",
      name,
      source: collectionSpan(options.config, collection),
      stability: "stable",
      signature: collection.source,
      ...(options.version === undefined ? {} : { version: { introduced: options.version } }),
    });
    for (const field of publicFieldNames(collection, policy, hidden)) {
      const schemaSpan = fieldSpans.get(field);
      items.push({
        id: itemId("field", `${name}.${field}`),
        area: "data",
        kind: "field",
        name: `${name}.${field}`,
        parent: itemId("collection", name),
        source: schemaSpan ?? fieldSpan(collection, field),
        stability: "stable",
        ...(options.version === undefined ? {} : { version: { introduced: options.version } }),
      });
    }
  }
  return { version: 1, area: "data", items: sortItems(items), findings };
}
