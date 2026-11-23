/**
 * Discover OpenAPI operations (#1341): reads one pinned OpenAPI 3.0/3.1 document through the same reader the reference
 * pages use, records each operation, its parameters, and its responses with the operation's own `operationId` as a
 * stable identity, and keeps `deprecated` on the operation and every parameter. The document is never fetched: it is a
 * file the site owns, so the ids do not change because a path or a method changed.
 *
 * An item's span is the operation's own line in the document. A response has no id of its own in OpenAPI, so its item
 * id is `<operationId>:<status>`, which is stable while the operation keeps its id.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { SourcePos } from "../../contracts/source.ts";
import type { SurfaceAdapterResult, SurfaceFinding, SurfaceItem, SurfaceStability } from "../../contracts/surface.ts";
import { readApiReference, type ApiOperation } from "../../api-reference/read.ts";
import { itemId, sortItems } from "../contract.ts";
import { member, parseJsonWithPositions } from "../json-pos.ts";

/** What an OpenAPI discovery needs. */
export interface DiscoverOpenApiOptions {
  /** The pinned document, relative to the site root. */
  readonly source: string;
  /** Root the document resolves against; defaults to the working directory. */
  readonly root?: string;
  /** The version the API ships in, so its items carry an introduction version. Default: none. */
  readonly version?: string;
}

/** The stability an operation shows: `deprecated` when the document marks it so. */
function stabilityOf(deprecated: boolean): SurfaceStability {
  return deprecated ? "deprecated" : "stable";
}

/** The items for one operation: the operation, its parameters, and its responses, all pointing at `span`. */
function itemsOf(operation: ApiOperation, span: SourcePos, version: string | undefined): SurfaceItem[] {
  const items: SurfaceItem[] = [];
  items.push({
    id: itemId("operation", operation.id),
    area: "openapi",
    kind: "operation",
    name: operation.id,
    source: span,
    stability: stabilityOf(operation.deprecated),
    signature: `${operation.method.toUpperCase()} ${operation.path}`,
    ...(version === undefined ? {} : { version: { introduced: version } }),
  });
  for (const parameter of operation.parameters) {
    items.push({
      id: itemId("parameter", `${operation.id}:${parameter.in}:${parameter.name}`),
      area: "openapi",
      kind: "parameter",
      name: `${parameter.in}.${parameter.name}`,
      parent: itemId("operation", operation.id),
      source: span,
      stability: stabilityOf(parameter.deprecated),
      signature: `${parameter.name} in ${parameter.in}${parameter.required ? " (required)" : ""}`,
      ...(version === undefined ? {} : { version: { introduced: version } }),
    });
  }
  for (const response of operation.responses) {
    items.push({
      id: itemId("response", `${operation.id}:${response.status}`),
      area: "openapi",
      kind: "response",
      name: response.status,
      parent: itemId("operation", operation.id),
      source: span,
      stability: "stable",
      signature: response.description === "" ? response.status : `${response.status} ${response.description}`,
      ...(version === undefined ? {} : { version: { introduced: version } }),
    });
  }
  return items;
}

/** A one-line span at the document's start, for a document whose positions the reader does not carry. */
function documentStart(file: string) {
  return { file, line: 1, column: 1, endLine: 1, endColumn: 1 };
}

/**
 * The line each operation's `operationId` is written on, keyed by the id. The document is YAML or JSON; a JSON
 * document is read with positions, and a YAML document is scanned line by line for its `operationId:` keys, which is
 * exact because the reader already rejects a duplicate id.
 */
function operationLines(text: string, file: string): Map<string, { line: number; column: number; length: number }> {
  const lines = new Map<string, { line: number; column: number; length: number }>();
  try {
    const root = parseJsonWithPositions(text, file);
    const paths = member(root, "paths");
    if (paths?.members !== undefined) {
      for (const pathItem of paths.members.values()) {
        if (pathItem.members === undefined) continue;
        for (const operation of pathItem.members.values()) {
          const idNode = member(operation, "operationId");
          if (typeof idNode?.value === "string" && idNode.keySpan !== undefined) {
            lines.set(idNode.value, {
              line: idNode.keySpan.line,
              column: idNode.keySpan.column,
              length: idNode.keySpan.endColumn - idNode.keySpan.column + 1,
            });
          }
        }
      }
    }
  } catch {
    // Not JSON: scan the YAML text. `operationId: <id>` is unambiguous because the reader refuses a duplicate id.
    for (const [index, line] of text.split("\n").entries()) {
      const match = /^(\s*)operationId:\s*["']?([A-Za-z0-9][A-Za-z0-9._-]*)["']?\s*$/.exec(line);
      if (match === null) continue;
      const id = match[2]!;
      if (!lines.has(id)) lines.set(id, { line: index + 1, column: match[1]!.length + 1, length: line.trimEnd().length - match[1]!.length });
    }
  }
  return lines;
}

/**
 * Reads the pinned document into operations, parameters, and responses. A document the reader rejects yields one error
 * finding and no items, because a reference is never half-written and neither is the surface it declares.
 */
export async function discoverOpenApi(options: DiscoverOpenApiOptions): Promise<SurfaceAdapterResult> {
  const root = resolve(options.root ?? ".");
  const file = options.source.replace(/\\/g, "/");
  let text: string;
  try {
    text = await readFile(resolve(root, file), "utf8");
  } catch (error) {
    return {
      version: 1,
      area: "openapi",
      items: [],
      findings: [{
        code: "surface.openapi-source",
        severity: "error",
        message: `Cannot read the OpenAPI document "${file}": ${error instanceof Error ? error.message : String(error)}.`,
        pos: documentStart(file),
      }],
    };
  }
  const read = readApiReference(text, file);
  if (read.document === undefined) {
    return {
      version: 1,
      area: "openapi",
      items: [],
      findings: read.diagnostics.map((finding): SurfaceFinding => ({
        code: finding.id,
        severity: finding.severity,
        message: finding.message,
        ...(finding.pos === undefined ? {} : { pos: finding.pos }),
      })),
    };
  }
  const lines = operationLines(text, file);
  const items: SurfaceItem[] = [];
  for (const operation of read.document.operations) {
    const line = lines.get(operation.id);
    const span = line === undefined
      ? documentStart(file)
      : { file, line: line.line, column: line.column, endLine: line.line, endColumn: line.column + Math.max(1, line.length - 1) };
    items.push(...itemsOf(operation, span, options.version));
  }
  return {
    version: 1,
    area: "openapi",
    items: sortItems(items),
    findings: read.diagnostics.map((finding): SurfaceFinding => ({
      code: finding.id,
      severity: finding.severity,
      message: finding.message,
      ...(finding.pos === undefined ? {} : { pos: finding.pos }),
    })),
  };
}
