/**
 * What a schema finding can suggest: `help` in prose for people, and `fix` as a span replacement only when the
 * replacement is safe in every source format. Nothing here applies a fix; the diagnostic only carries it.
 *
 * A replacement is offered only when the new text is a bare token that reads the same in YAML, JSON, and CSV: a
 * word for YAML and CSV, or a quoted-safe number. A quoted, escaped, or nested value gets prose instead, so an
 * applied fix can never change a value's meaning.
 */
import type { DiagnosticFix, RecordPos } from "../contracts/index.ts";

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
  /** Where the field's value sits, when it has a place. */
  readonly pos?: RecordPos;
}

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

/** A replacement for a value's span when `text` is a bare token that no source format would read differently. */
function tokenFix(token: string, pos: RecordPos | undefined): DiagnosticFix | undefined {
  if (pos === undefined || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(token)) return undefined;
  return {
    file: pos.file,
    line: pos.startLine,
    column: pos.startColumn,
    endLine: pos.endLine,
    endColumn: pos.endColumn,
    text: token,
  };
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
    const fix = tokenFix(match, input.pos);
    return { help: `Did you mean "${match}"?`, ...(fix === undefined ? {} : { fix }) };
  }

  if (input.keyword === "additionalProperties") {
    const known = input.knownFields ?? [];
    const match = closest(input.field, known);
    return match === undefined ? {} : { help: `Did you mean "${match}"?` };
  }

  if (input.keyword === "required") {
    const example = exampleOf(input.expectedType);
    const named = input.expectedType === undefined ? "" : ` (a ${input.expectedType})`;
    const sample = example === undefined ? "" : `, such as \`${input.field}: ${example}\``;
    return { help: `Add a "${input.field}" field${named}${sample}.` };
  }

  if (input.keyword === "type" && typeof value === "string" && input.expectedType !== undefined) {
    const wantsNumber = input.expectedType === "number" || input.expectedType === "integer";
    if (wantsNumber && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
      const fix = tokenFix(value, input.pos);
      return { help: `Write the number without quotes: ${value}.`, ...(fix === undefined ? {} : { fix }) };
    }
    if (input.expectedType === "boolean" && (value === "true" || value === "false")) {
      const fix = tokenFix(value, input.pos);
      return { help: `Write the boolean without quotes: ${value}.`, ...(fix === undefined ? {} : { fix }) };
    }
    return { help: `Write the value as ${/^[aeiou]/.test(input.expectedType) ? "an" : "a"} ${input.expectedType}.` };
  }

  return {};
}
