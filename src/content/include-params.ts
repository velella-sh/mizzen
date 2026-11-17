import type { Diagnostic, SourcePos } from "../contracts/index.ts";

/**
 * Parameters of a shared fragment. A fragment declares `params` in its front matter, `{{name}}` in its body takes a
 * value from the include's braces, and a declared name is replaced once, left to right, so a value that itself holds
 * `{{name}}` stays literal. A fragment without a declaration keeps today's behavior: extra attributes are ignored and
 * every `{{...}}` stays as written.
 */

/** A parameter default: text, or `null` when the call site must supply the value. */
export type IncludeParamDefault = string | null;

/** What a fragment declares, in declaration order, and what is wrong with the declaration. */
export interface IncludeParamDeclaration {
  /** Parameter name → default; empty when the fragment takes no parameters. */
  readonly params: ReadonlyMap<string, IncludeParamDefault>;
  /** Findings in the fragment's own front matter. */
  readonly diagnostics: readonly Diagnostic[];
}

/** The values one directive supplies, and the findings at its line. */
export interface IncludeParamValues {
  /** Parameter name → value, defaults included; a missing required parameter is absent. */
  readonly values: ReadonlyMap<string, string>;
  /** Findings at the directive line. */
  readonly diagnostics: readonly Diagnostic[];
}

/** `{{name}}`, with optional spaces inside the braces. */
const PLACEHOLDER = /\{\{[ \t]*([A-Za-z][A-Za-z0-9_.-]*)[ \t]*\}\}/g;

/** The grammar of a declared name, the same as a code placeholder's. */
const NAME = /^[A-Za-z][A-Za-z0-9_.-]*$/;

/** Attributes of a directive that are never parameter values. */
const RESERVED = new Set(["path", "lines"]);

/** A finding that fails the build. */
function problem(id: string, message: string, pos: SourcePos, help?: string): Diagnostic {
  return { id, severity: "error", message, pos, ...(help === undefined ? {} : { help }) };
}

/** Where a declaration sits in the raw front matter, 1-based, for diagnostics. */
interface ParamLines {
  /** Line of the `params:` key, when there is one. */
  readonly params?: number;
  /** Parameter name → line that declares it. */
  readonly keys: ReadonlyMap<string, number>;
  /** The raw lines, so a finding can span the declaring line. */
  readonly lines: readonly string[];
}

/** Locates `params:` and its indented keys in the fragment's front matter. */
function paramLinesOf(source: string): ParamLines {
  const lines = source.split(/\r?\n/);
  const keys = new Map<string, number>();
  const empty: ParamLines = { keys, lines };
  if (lines[0]?.trim() !== "---") return empty;
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "---") {
      close = i;
      break;
    }
  }
  if (close === -1) return empty;
  let params = -1;
  for (let i = 1; i < close; i++) {
    if (/^params[ \t]*:/.test(lines[i]!)) {
      params = i;
      break;
    }
  }
  if (params === -1) return empty;
  for (let i = params + 1; i < close; i++) {
    const text = lines[i]!;
    if (text.trim() === "" || text.trimStart().startsWith("#")) continue;
    // A top-level key starts the next block, so `params` has ended.
    if (!/^[ \t]/.test(text)) break;
    const match = /^[ \t]+(.*?)[ \t]*:(?:[ \t]|$)/.exec(text);
    const name = match?.[1]?.trim();
    if (name !== undefined && name !== "") keys.set(name, i + 1);
  }
  return { params: params + 1, keys, lines };
}

/** A diagnostic on one declaration line; `line` is 1-based. */
function declarationProblem(
  lines: ParamLines,
  display: string,
  line: number,
  id: string,
  message: string,
): Diagnostic {
  return problem(id, message, {
    file: display,
    line,
    column: 1,
    endLine: line,
    endColumn: Math.max(1, lines.lines[line - 1]?.length ?? 0),
  });
}

/**
 * Reads the `params` block of a fragment from its parsed front matter. `source` is the whole file, so a finding can
 * point at the line that declares the name. `params` absent, `null`, or empty means the fragment takes no parameters.
 */
export function includeParamsOf(
  data: Readonly<Record<string, unknown>>,
  source: string,
  display: string,
): IncludeParamDeclaration {
  const none: IncludeParamDeclaration = { params: new Map(), diagnostics: [] };
  if (!Object.hasOwn(data, "params")) return none;
  const value = data["params"];
  if (value === null || value === undefined) return none;
  const lines = paramLinesOf(source);
  const block = lines.params ?? 1;
  const params = new Map<string, IncludeParamDefault>();
  const diagnostics: Diagnostic[] = [];
  if (typeof value !== "object" || Array.isArray(value)) {
    diagnostics.push(
      declarationProblem(lines, display, block, "include.param-invalid", "`params` must be a mapping of parameter names to default strings."),
    );
    return { params, diagnostics };
  }
  for (const [name, fallback] of Object.entries(value as Record<string, unknown>)) {
    const line = lines.keys.get(name) ?? block;
    if (RESERVED.has(name)) {
      diagnostics.push(
        declarationProblem(lines, display, line, "include.param-reserved", `\`${name}\` is reserved and cannot be a parameter.`),
      );
      continue;
    }
    if (!NAME.test(name)) {
      diagnostics.push(
        declarationProblem(lines, display, line, "include.param-invalid", `\`${name}\` is not a valid parameter name.`),
      );
      continue;
    }
    if (fallback === null || fallback === undefined) {
      params.set(name, null);
    } else if (typeof fallback === "string" && !/[\r\n]/.test(fallback)) {
      params.set(name, fallback);
    } else {
      diagnostics.push(
        declarationProblem(
          lines,
          display,
          line,
          "include.param-invalid",
          `The default for \`${name}\` must be a single-line string, or empty to require a value.`,
        ),
      );
      params.set(name, null);
    }
  }
  return { params, diagnostics };
}

/**
 * Binds one directive's attributes to a declaration. `path` and `lines` are not values. A fragment without declared
 * parameters ignores extra attributes; a strict one reports each unknown name and each required name it was not
 * given.
 */
export function bindIncludeParams(
  declaration: IncludeParamDeclaration,
  attributes: Readonly<Record<string, string>>,
  pos: SourcePos,
): IncludeParamValues {
  const values = new Map<string, string>();
  const diagnostics: Diagnostic[] = [];
  if (declaration.params.size > 0) {
    for (const [name, text] of Object.entries(attributes)) {
      if (RESERVED.has(name)) continue;
      if (declaration.params.has(name)) {
        values.set(name, text);
      } else {
        diagnostics.push(
          problem("include.param-unknown", `\`${name}\` names no parameter of this fragment.`, pos, "Declare it in the fragment's front matter, or remove the attribute."),
        );
      }
    }
  }
  for (const [name, fallback] of declaration.params) {
    if (values.has(name)) continue;
    if (fallback !== null) {
      values.set(name, fallback);
    } else {
      diagnostics.push(
        problem(
          "include.param-missing",
          `The include has no value for \`${name}\`, which has no default.`,
          pos,
          `Pass \`${name}="..."\` in the directive's braces, or give it a default in the fragment.`,
        ),
      );
    }
  }
  return { values, diagnostics };
}

/**
 * Replaces the declared parameters of one piece of text. An undeclared name stays as written. A backslash escapes the
 * braces: an odd run keeps the run and the placeholder, an even run leaves half of it and substitutes.
 */
export function substituteIncludeParams(text: string, values: ReadonlyMap<string, string>): string {
  if (values.size === 0 || !text.includes("{{")) return text;
  let out = "";
  let last = 0;
  for (const match of text.matchAll(PLACEHOLDER)) {
    const value = values.get(match[1]!);
    if (value === undefined) continue;
    const at = match.index ?? 0;
    let start = at;
    while (start > last && text.charAt(start - 1) === "\\") start--;
    const run = at - start;
    out += text.slice(last, start);
    out += run % 2 === 1 ? "\\".repeat(run) + match[0] : "\\".repeat(run >> 1) + value;
    last = at + match[0].length;
  }
  return last === 0 ? text : out + text.slice(last);
}
