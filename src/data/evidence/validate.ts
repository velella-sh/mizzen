/**
 * Validates the evidence a collection keeps beside its fields: a mapping from a top-level field name to one claim or a
 * list of claims. A claim has a stable `id`, a readable `title`, and a `url`; every other key is private and is left
 * out of the public result.
 *
 * A broken claim is a diagnostic with the span of the value that caused it, never a throw. The public {@link
 * EvidenceClaims} keeps only sound claims, so a later stage can render one without checking it again. A collection
 * without evidence never calls this, and a record whose evidence field is absent returns no claims and no findings.
 */
import { isMap, isSeq, type Node, type Pair } from "yaml";
import type { DataRecord, Diagnostic, SourcePos } from "../../contracts/index.ts";
import { keyText, mappingPairs, nodePos, sourcePosOf, type LineIndex } from "../positions.ts";

/** One public claim: the three keys every output carries, in this order. */
export interface EvidenceClaim {
  /** Stable id, unique within one field's list. */
  readonly id: string;
  /** Readable label for the source. */
  readonly title: string;
  /** Absolute `https:` address or a root-relative path. */
  readonly url: string;
}

/** Public claims keyed by the top-level field they back, in record field order; a field with no sound claim is absent. */
export type EvidenceClaims = Readonly<Record<string, readonly EvidenceClaim[]>>;

/** What every finding in this file names. */
interface Context {
  readonly collection: string;
  readonly record: DataRecord;
  readonly field: string;
  readonly index: LineIndex;
  readonly file: string;
  readonly diagnostics: Diagnostic[];
}

/** The span of a node, or `fallback` when the parser gave no value node. */
function posOf(context: Context, node: Node | null | undefined, fallback: SourcePos): SourcePos {
  if (node === null || node === undefined || typeof node !== "object") return fallback;
  return sourcePosOf(nodePos(context.index, context.file, node));
}

/** The span of a pair's value, or its key when the value is empty. */
function pairPos(context: Context, pair: Pair<unknown, unknown> | undefined, fallback: SourcePos): SourcePos {
  if (pair === undefined) return fallback;
  const value = pair.value as Node | null;
  return posOf(context, value === null ? (pair.key as Node) : value, fallback);
}

/** The text of a scalar node; `undefined` for a missing value or any non-string. */
function textOf(node: Node | null | undefined): string | undefined {
  if (node === null || node === undefined || typeof node !== "object") return undefined;
  const value = (node as { readonly value?: unknown }).value;
  return typeof value === "string" ? value : undefined;
}

/** The first pair with this key, so a claim reads the key it is documented to read. */
function pairOf(pairs: readonly Pair<unknown, unknown>[], key: string): Pair<unknown, unknown> | undefined {
  for (const pair of pairs) {
    if (keyText(pair) === key) return pair;
  }
  return undefined;
}

/** The value node of a pair, or `undefined` when it has none. */
function valueOf(pair: Pair<unknown, unknown> | undefined): Node | null | undefined {
  return pair?.value as Node | null | undefined;
}

/** An absolute `https:` URL with a host, or a single-slash root-relative path. */
function isEvidenceUrl(url: string): boolean {
  if (url.startsWith("/")) return !url.startsWith("//");
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname !== "";
  } catch {
    return false;
  }
}

/** A readable position for a message that names where an earlier claim sat. */
function where(pos: SourcePos): string {
  return `${pos.file}:${pos.line}:${pos.column}`;
}

/** The finding for an id or title that is missing, empty, or not a string. */
function missingText(context: Context, key: string, pos: SourcePos): void {
  context.diagnostics.push({
    id: "data.evidence-claim",
    severity: "error",
    message: `Evidence for field "${context.field}" of record "${context.record.id}" in "${context.collection}" must have a non-empty string \`${key}\`.`,
    pos,
    help: `Add a readable \`${key}\` to every claim for \`${context.field}\`.`,
  });
}

/**
 * Checks one claim mapping. A sound claim is returned for publication; a broken one adds its findings and is left
 * out. `seen` holds the ids already accepted for this field, so a repeat is reported and dropped.
 */
function claimOf(
  context: Context,
  node: Node,
  backed: string,
  seen: Map<string, SourcePos>,
): EvidenceClaim | undefined {
  const position = posOf(context, node, sourcePosOf(context.record.position));
  if (!isMap(node)) {
    context.diagnostics.push({
      id: "data.evidence-claim",
      severity: "error",
      message: `Evidence for field "${backed}" of record "${context.record.id}" in "${context.collection}" must be a claim mapping.`,
      pos: position,
      help: "Write each claim as `id`, `title`, and `url` pairs.",
    });
    return undefined;
  }

  const pairs = mappingPairs(node);
  const idPair = pairOf(pairs, "id");
  const titlePair = pairOf(pairs, "title");
  const urlPair = pairOf(pairs, "url");
  const id = textOf(valueOf(idPair));
  const title = textOf(valueOf(titlePair));
  const url = textOf(valueOf(urlPair));
  let sound = true;

  if (id === undefined || id === "") {
    missingText(context, "id", pairPos(context, idPair, position));
    sound = false;
  }
  if (title === undefined || title === "") {
    missingText(context, "title", pairPos(context, titlePair, position));
    sound = false;
  }
  if (url === undefined || url === "") {
    context.diagnostics.push({
      id: "data.evidence-url",
      severity: "error",
      message: `Evidence for field "${backed}" of record "${context.record.id}" in "${context.collection}" must have a non-empty string \`url\`.`,
      pos: pairPos(context, urlPair, position),
      help: "Use an absolute `https:` URL or a root-relative path such as `/reports/2026-03.json`.",
    });
    sound = false;
  } else if (!isEvidenceUrl(url)) {
    context.diagnostics.push({
      id: "data.evidence-url",
      severity: "error",
      message: `Evidence for field "${backed}" of record "${context.record.id}" in "${context.collection}" has the disallowed url "${url}".`,
      pos: pairPos(context, urlPair, position),
      help: "Use an absolute `https:` URL or a root-relative path such as `/reports/2026-03.json`.",
    });
    sound = false;
  }

  if (!sound || id === undefined || id === "") return undefined;
  const idPos = pairPos(context, idPair, position);
  const first = seen.get(id);
  if (first !== undefined) {
    context.diagnostics.push({
      id: "data.evidence-duplicate-id",
      severity: "error",
      message: `Evidence for field "${backed}" of record "${context.record.id}" in "${context.collection}" repeats id "${id}", first used at ${where(first)}.`,
      pos: idPos,
      help: `Give each claim for \`${backed}\` its own id.`,
    });
    return undefined;
  }
  seen.set(id, idPos);
  return { id, title: title!, url: url! };
}

/**
 * Validates one record's evidence field. `node` is the parsed value of the top-level field the collection names, and
 * `index` belongs to the same source text, so every finding carries the exact span of the claim, key, or URL at fault.
 *
 * A missing evidence field is the normal case: no claims and no findings. An empty mapping, or a field with an empty
 * list, is the same. Sound claims come back keyed by the field they back, in the record's field order.
 */
export function validateEvidence(
  collection: string,
  record: DataRecord,
  field: string,
  node: Node | undefined,
  index: LineIndex,
  diagnostics: Diagnostic[],
): EvidenceClaims {
  if (record.fields[field] === undefined) return {};
  const context: Context = { collection, record, field, index, file: record.position.file, diagnostics };
  const fallback = sourcePosOf(record.fieldPositions[field] ?? record.position);

  if (node === undefined || node === null || !isMap(node)) {
    diagnostics.push({
      id: "data.evidence-shape",
      severity: "error",
      message: `Evidence field "${field}" of record "${record.id}" in "${collection}" must be a mapping of field names to claims.`,
      pos: posOf(context, node, fallback),
      help: `Write \`${field}:\` followed by \`<field>: <claim>\` entries.`,
    });
    return {};
  }

  const found = new Map<string, EvidenceClaim[]>();
  for (const pair of mappingPairs(node)) {
    const backed = keyText(pair);
    if (backed === undefined || !Object.hasOwn(record.fields, backed)) {
      diagnostics.push({
        id: "data.evidence-field",
        severity: "error",
        message:
          backed === undefined
            ? `Evidence field "${field}" of record "${record.id}" in "${collection}" has a key that is not a field name.`
            : `Evidence field "${field}" of record "${record.id}" in "${collection}" names "${backed}", which is not a top-level field of the record.`,
        pos: posOf(context, pair.key as Node, fallback),
        help: "Point each evidence entry at one of the record's own top-level fields.",
      });
      continue;
    }

    const value = pair.value as Node | null;
    const claims: EvidenceClaim[] = [];
    const seen = new Map<string, SourcePos>();
    if (isSeq(value)) {
      for (const item of value.items) {
        const claim = claimOf(context, item as Node, backed, seen);
        if (claim !== undefined) claims.push(claim);
      }
    } else if (isMap(value)) {
      const claim = claimOf(context, value, backed, seen);
      if (claim !== undefined) claims.push(claim);
    } else {
      diagnostics.push({
        id: "data.evidence-shape",
        severity: "error",
        message: `Evidence for field "${backed}" of record "${record.id}" in "${collection}" must be a claim or a list of claims.`,
        pos: posOf(context, value === null ? (pair.key as Node) : value, fallback),
        help: "Write one claim mapping, or a list of claim mappings.",
      });
      continue;
    }
    if (claims.length > 0) found.set(backed, claims);
  }

  const claims: Record<string, readonly EvidenceClaim[]> = {};
  for (const backed of Object.keys(record.fields)) {
    const list = found.get(backed);
    if (list !== undefined) {
      Object.defineProperty(claims, backed, { value: list, writable: true, enumerable: true, configurable: true });
    }
  }
  return claims;
}
