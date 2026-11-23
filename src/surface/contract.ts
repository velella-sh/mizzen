/**
 * The runtime half of the surface contract: the finite lists a validator and a writer share, the shape check that
 * rejects an adapter's whole result when it is not the contract, and the stable ordering helpers.
 *
 * `validateAdapterResult` never returns partial data. An item with a missing field, an unknown area or kind, a
 * non-positive span, or a duplicate id fails the whole result, so a coverage number is only ever computed from items an
 * adapter actually produced.
 */
import type { SourcePos } from "../contracts/source.ts";
import type {
  SurfaceAdapterProblem,
  SurfaceAdapterResult,
  SurfaceArea,
  SurfaceItem,
  SurfaceItemKind,
  SurfaceStability,
} from "../contracts/surface.ts";

/** The areas a report lists, in order. */
export const SURFACE_AREAS: readonly SurfaceArea[] = ["api", "cli", "config", "openapi", "data", "version"];

/** Every item kind. */
export const SURFACE_ITEM_KINDS: readonly SurfaceItemKind[] = [
  "symbol",
  "command",
  "argument",
  "flag",
  "config-key",
  "operation",
  "parameter",
  "response",
  "collection",
  "field",
  "version",
];

/** Every stability value. */
export const SURFACE_STABILITIES: readonly SurfaceStability[] = ["stable", "experimental", "deprecated", "removed"];

/** One stable identity for an item: `<kind>:<name>`. */
export function itemId(kind: SurfaceItemKind, name: string): string {
  return `${kind}:${name}`;
}

/** Compares by code point, never by locale, so an order is the same on every platform. */
export function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The report order of items: area, then id. */
export function sortItems(items: readonly SurfaceItem[]): SurfaceItem[] {
  return [...items].sort((a, b) => byCodePoint(a.area, b.area) || byCodePoint(a.id, b.id));
}

/** A structural failure of an adapter's result. Thrown by {@link requireAdapterResult}, never by the parser. */
export class SurfaceContractError extends Error {
  readonly problems: readonly SurfaceAdapterProblem[];

  constructor(problems: readonly SurfaceAdapterProblem[]) {
    super(problems.map((problem) => problem.message).join("\n"));
    this.name = "SurfaceContractError";
    this.problems = problems;
  }
}

/** True for a positive whole number, the only value a span line or column may hold. */
function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/** True for a span whose four numbers are positive and whose end is at or after its start. */
function validSpan(value: unknown): value is SourcePos {
  if (value === null || typeof value !== "object") return false;
  const span = value as Partial<SourcePos>;
  if (typeof span.file !== "string" || span.file === "") return false;
  if (!positive(span.line) || !positive(span.column) || !positive(span.endLine) || !positive(span.endColumn)) return false;
  return span.endLine > span.line || (span.endLine === span.line && span.endColumn >= span.column);
}

/** Every problem with one item, empty when it is the shape the contract reads. */
function itemProblems(item: unknown, index: number): SurfaceAdapterProblem[] {
  const where = `items[${index}]`;
  if (item === null || typeof item !== "object") {
    return [{ code: "surface.invalid-item", message: `${where} is not an object.` }];
  }
  const value = item as Partial<SurfaceItem>;
  const problems: SurfaceAdapterProblem[] = [];
  if (typeof value.id !== "string" || value.id === "") {
    problems.push({ code: "surface.invalid-item", message: `${where}.id must be a non-empty string.` });
  }
  if (!SURFACE_AREAS.includes(value.area as SurfaceArea)) {
    problems.push({ code: "surface.invalid-item", message: `${where}.area must be one of ${SURFACE_AREAS.join(", ")}.` });
  }
  if (!SURFACE_ITEM_KINDS.includes(value.kind as SurfaceItemKind)) {
    problems.push({ code: "surface.invalid-item", message: `${where}.kind must be one of ${SURFACE_ITEM_KINDS.join(", ")}.` });
  }
  if (typeof value.name !== "string" || value.name === "") {
    problems.push({ code: "surface.invalid-item", message: `${where}.name must be a non-empty string.` });
  }
  if (!SURFACE_STABILITIES.includes(value.stability as SurfaceStability)) {
    problems.push({ code: "surface.invalid-item", message: `${where}.stability must be one of ${SURFACE_STABILITIES.join(", ")}.` });
  }
  if (!validSpan(value.source)) {
    problems.push({ code: "surface.invalid-span", message: `${where}.source must be a positive span whose end is at or after its start.` });
  }
  if (value.signature !== undefined && typeof value.signature !== "string") {
    problems.push({ code: "surface.invalid-item", message: `${where}.signature must be a string when present.` });
  }
  if (value.parent !== undefined && (typeof value.parent !== "string" || value.parent === "")) {
    problems.push({ code: "surface.invalid-item", message: `${where}.parent must be a non-empty string when present.` });
  }
  if (value.version !== undefined) {
    const version = value.version as { introduced?: unknown };
    if (version === null || typeof version !== "object" || typeof version.introduced !== "string" || version.introduced === "") {
      problems.push({ code: "surface.invalid-version", message: `${where}.version.introduced must be a non-empty string.` });
    }
  }
  return problems;
}

/**
 * Why an adapter's result is not the contract, empty when it is. The version, area, and item shape are checked, and a
 * duplicate id is refused because a report keys every match by id.
 */
export function adapterResultProblems(value: unknown): readonly SurfaceAdapterProblem[] {
  if (value === null || typeof value !== "object") {
    return [{ code: "surface.invalid-result", message: "The adapter result is not an object." }];
  }
  const result = value as Partial<SurfaceAdapterResult>;
  const problems: SurfaceAdapterProblem[] = [];
  if (result.version !== 1) {
    problems.push({ code: "surface.unsupported-version", message: `The adapter result version must be 1, not ${JSON.stringify(result.version)}.` });
  }
  if (!SURFACE_AREAS.includes(result.area as SurfaceArea)) {
    problems.push({ code: "surface.invalid-area", message: `The adapter area must be one of ${SURFACE_AREAS.join(", ")}, not ${JSON.stringify(result.area)}.` });
  }
  if (!Array.isArray(result.items)) {
    problems.push({ code: "surface.invalid-result", message: "The adapter items must be a list." });
  } else {
    const seen = new Set<string>();
    result.items.forEach((item, index) => {
      problems.push(...itemProblems(item, index));
      const id = (item as Partial<SurfaceItem> | null)?.id;
      if (typeof id === "string" && id !== "") {
        if (seen.has(id)) problems.push({ code: "surface.duplicate-id", message: `items[${index}].id "${id}" appears twice.` });
        seen.add(id);
      }
    });
  }
  if (!Array.isArray(result.findings)) {
    problems.push({ code: "surface.invalid-result", message: "The adapter findings must be a list." });
  }
  return problems;
}

/**
 * Returns the result when it is the contract, and throws {@link SurfaceContractError} with every problem when it is not.
 * A caller that catches it gets no items at all, never the valid prefix.
 */
export function validateAdapterResult(value: unknown): SurfaceAdapterResult {
  const problems = adapterResultProblems(value);
  if (problems.length > 0) throw new SurfaceContractError(problems);
  return value as SurfaceAdapterResult;
}
