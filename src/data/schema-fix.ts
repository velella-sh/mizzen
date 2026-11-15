/**
 * What a schema finding can suggest: `help` in prose for people, and `fix` as a span replacement only when that
 * replacement is safe in the source's own format. Nothing here applies a fix; the diagnostic only carries it.
 *
 * A replacement is written for the format it lands in: a JSON string keeps its quotes, and a YAML string is quoted so
 * `"true"`, `"null"`, or `"1"` stay strings; a CSV cell is always text. A number or boolean is offered only when the
 * caller proves the record still validates with the converted value, so a finding never suggests a fix that would
 * change a value's type or break the file.
 */
import type { DiagnosticFix, RecordPos } from "../contracts/index.ts";

/** The source format a fix is written for. */
export type SourceFormat = "csv" | "json" | "yaml";

/** What a finding suggests, if anything. */
export interface Suggestion {
  /** How to fix the problem, in one sentence. */
  readonly help?: string;
  /** A safe, mechanical repair on the field's span. */
  readonly fix?: DiagnosticFix;
}

/** The inputs a suggestion reads: the failed keyword, the field, the value written, and the schema's shape. */
export interface SuggestionInput {
  /** The JSON Schema keyword that failed. */
  readonly keyword: string;
  /** The top-level field the finding is about; empty when the record itself failed. */
  readonly field: string;
  /** The value the record holds for that field, as the source read it. */
  readonly value?: unknown;
  /** The allowed values, for `enum` and `const`. */
  readonly allowed?: readonly unknown[];
  /** The field names the schema declares, for a near-miss unknown field. */
  readonly knownFields?: readonly string[];
  /** The type the schema expects, for a missing or mistyped field. */
  readonly expectedType?: string;
  /** The format the replacement is written for. */
  readonly format: SourceFormat;
  /** Where the field's value sits, for a value replacement. */
  readonly pos?: RecordPos;
  /** Where the field's key sits, for a rename; never the value's span. */
  readonly keyPos?: RecordPos;
  /** Validates the record with this field set to a candidate value, so a conversion is offered only when it passes. */
  readonly accepts?: (value: unknown) => boolean;
}

/** A token that needs no quoting or escaping in any of the three formats. */
const TOKEN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/** The edit distance between two strings, counted in code points. */
export function editDistance(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  let previous = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 1; i <= left.length; i++) {
    const current = [i, ...Array.from({ length: right.length }, () => 0)];
    for (let j = 1; j <= right.length; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
    }
    previous = current;
  }
  return previous[right.length]!;
}

/** The closest candidate a typo was meant to be; `undefined` when nothing is close enough to suggest safely. */
export function closest(value: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = editDistance(value, candidate);
    // One edit per three characters: "stabel" reaches "stable", two unrelated words do not meet.
    if (distance > Math.max(1, Math.ceil(candidate.length / 3))) continue;
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/** A replacement of one span, when the text is safe and the span is known. */
function spanFix(pos: RecordPos | undefined, text: string): DiagnosticFix | undefined {
  if (pos === undefined || (!TOKEN.test(text) && !/^"[^"\\]*"$/.test(text))) return undefined;
  return {
    file: pos.file,
    line: pos.startLine,
    column: pos.startColumn,
    endLine: pos.endLine,
    endColumn: pos.endColumn,
    text,
  };
}

/**
 * The text that reads back as the string `token` in `format`: JSON and YAML get a quoted string, so a value such as
 * `true`, `null`, or `1` stays text; a CSV cell is text either way, so it stays bare.
 */
function stringText(token: string, format: SourceFormat): string | undefined {
  if (!TOKEN.test(token)) return undefined;
  return format === "csv" ? token : JSON.stringify(token);
}

/** The text that reads back as the key `token` in `format`; a JSON key keeps its quotes. */
function keyText(token: string, format: SourceFormat): string | undefined {
  if (!TOKEN.test(token)) return undefined;
  return format === "json" ? JSON.stringify(token) : token;
}

/** The value a string spells in a format that has typed scalars, or `undefined` when it is not that scalar. */
function convertedValue(value: string, type: string): number | boolean | undefined {
  if (type === "boolean") {
    if (value === "true") return true;
    if (value === "false") return false;
    return undefined;
  }
  if (type === "integer" && /^-?(?:0|[1-9]\d*)$/.test(value)) return Number(value);
  if (type === "number" && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return Number(value);
  return undefined;
}

/** An example value of the type a schema names, for a missing field's help. */
function exampleOf(type: string | undefined): string | undefined {
  switch (type) {
    case "string":
      return "Example";
    case "integer":
    case "number":
      return "1";
    case "boolean":
      return "true";
    case "array":
      return "[]";
    case "object":
      return "{}";
    default:
      return undefined;
  }
}

/** What to suggest for one schema finding. */
export function suggestionFor(input: SuggestionInput): Suggestion {
  const value = input.value;

  if (input.keyword === "enum" || input.keyword === "const") {
    const allowed = (input.allowed ?? []).filter((candidate): candidate is string => typeof candidate === "string");
    if (typeof value !== "string" || allowed.length === 0) return {};
    const match = closest(value, allowed);
    if (match === undefined) return {};
    const text = stringText(match, input.format);
    const fix = text === undefined ? undefined : spanFix(input.pos, text);
    return { help: `Did you mean "${match}"?`, ...(fix === undefined ? {} : { fix }) };
  }

  if (input.keyword === "additionalProperties") {
    const known = input.knownFields ?? [];
    const match = closest(input.field, known);
    if (match === undefined) return {};
    const text = keyText(match, input.format);
    const fix = text === undefined ? undefined : spanFix(input.keyPos, text);
    return { help: `Did you mean "${match}"?`, ...(fix === undefined ? {} : { fix }) };
  }

  if (input.keyword === "required") {
    const example = exampleOf(input.expectedType);
    const named = input.expectedType === undefined ? "" : ` (a ${input.expectedType})`;
    const sample = example === undefined ? "" : `, such as \`${input.field}: ${example}\``;
    return { help: `Add a "${input.field}" field${named}${sample}.` };
  }

  if (input.keyword === "type" && typeof value === "string" && input.expectedType !== undefined) {
    const generic = `Write the value as ${/^[aeiou]/.test(input.expectedType) ? "an" : "a"} ${input.expectedType}.`;
    const converted = convertedValue(value, input.expectedType);
    // A CSV cell is always text, so no cell replacement can turn it into a typed value.
    if (converted === undefined || input.format === "csv") return { help: generic };
    const noun = typeof converted === "boolean" ? "boolean" : "number";
    const help = `Write the ${noun} without quotes: ${String(converted)}.`;
    // The fix is offered only when the whole record validates with the converted value.
    if (input.accepts?.(converted) !== true) return { help };
    const fix = spanFix(input.pos, String(converted));
    return { help, ...(fix === undefined ? {} : { fix }) };
  }

  return {};
}
