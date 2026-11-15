/**
 * Fills a template's front matter from one record: `{field}` in a string value becomes the record's value, so the same
 * template gives every page its own title, description, image, language, and theme keys. `{{` and `}}` are literal
 * braces. The body is never touched: a template's body uses directives.
 *
 * A value that names no field, or is empty once filled, is an error at the template's front matter and is left out, so
 * a page never carries the placeholder or an empty title.
 */
import type { Diagnostic, SourcePos } from "../contracts/index.ts";

/** What the substitution reads. */
export interface FrontMatterFields {
  /** The record's fields, already localized for the page's language. */
  readonly fields: Readonly<Record<string, unknown>>;
  /** The template, relative to the site root, for diagnostics. */
  readonly file: string;
  /** 1-based line of the template the front matter starts on. */
  readonly line: number;
  /** Fields the collection's schema declares, when it has one; a name outside it is unknown. */
  readonly schemaFields?: ReadonlySet<string>;
}

/** The front matter after substitution, and every finding. */
export interface SubstitutedFrontMatter {
  readonly data: Readonly<Record<string, unknown>>;
  readonly diagnostics: readonly Diagnostic[];
}

/** Keys whose value is engine configuration rather than text that names a record field. */
const FIXED = new Set(["layout", "permalink"]);

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The value at a dot-separated path, with own keys only and numeric list indexes. */
function resolveIn(value: unknown, path: string): { readonly found: boolean; readonly value?: unknown } {
  let current: unknown = value;
  for (const segment of path.split(".").map((part) => part.trim()).filter((part) => part !== "")) {
    if (typeof current !== "object" || current === null) return { found: false };
    if (Array.isArray(current)) {
      const index = /^\d+$/.test(segment) ? Number(segment) : -1;
      if (index < 0 || index >= current.length) return { found: false };
      current = current[index];
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return { found: false };
    current = (current as Record<string, unknown>)[segment];
  }
  return { found: true, value: current };
}

function scalar(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return undefined;
}

/** One finding at the template's front matter. */
function finding(id: string, message: string, help: string, ctx: FrontMatterFields): Diagnostic {
  const pos: SourcePos = { file: ctx.file, line: ctx.line, column: 1, endLine: ctx.line, endColumn: 1 };
  return { id, severity: "error", message, pos, help };
}

/** The string with every placeholder filled, and the names it could not fill. */
function substitute(text: string, ctx: FrontMatterFields, missing: string[]): string {
  let out = "";
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === "{" && text[index + 1] === "{") {
      out += "{";
      index += 1;
      continue;
    }
    if (char === "}" && text[index + 1] === "}") {
      out += "}";
      index += 1;
      continue;
    }
    if (char !== "{") {
      out += char;
      continue;
    }
    const close = text.indexOf("}", index + 1);
    if (close < 0) {
      out += char;
      continue;
    }
    const path = text.slice(index + 1, close).trim();
    const found = resolveIn(ctx.fields, path);
    const value = found.found ? scalar(found.value) : undefined;
    if (value === undefined) {
      missing.push(path);
      out += text.slice(index, close + 1);
    } else {
      out += value;
    }
    index = close;
  }
  return out;
}

/** True when the first segment of a path is a field the schema does not declare. */
function unknownToSchema(path: string, ctx: FrontMatterFields): boolean {
  if (ctx.schemaFields === undefined) return false;
  const first = path.split(".")[0]?.trim() ?? "";
  return first !== "" && !ctx.schemaFields.has(first);
}

/**
 * Substitutes every string in `data`, descending into lists and mappings. A placeholder that names no scalar, or names
 * a field the schema does not declare, is an error; so is a string that is empty once filled.
 */
export function substituteFrontMatter(
  data: Readonly<Record<string, unknown>>,
  ctx: FrontMatterFields,
): SubstitutedFrontMatter {
  const diagnostics: Diagnostic[] = [];
  const out: Record<string, unknown> = {};

  const walk = (value: unknown, key: string | undefined): unknown => {
    if (typeof value === "string") {
      if (key !== undefined && FIXED.has(key)) return value;
      const missing: string[] = [];
      const filled = substitute(value, ctx, missing);
      for (const path of missing) {
        diagnostics.push(
          unknownToSchema(path, ctx)
            ? finding(
                "data.frontmatter-unknown-field",
                `The template's front matter names "${path}", which the collection's schema does not declare.`,
                "Use a field the schema declares, or write `{{` for a literal brace.",
                ctx,
              )
            : finding(
                "data.frontmatter-missing-field",
                `The template's front matter names "${path}", which the record does not hold as a scalar.`,
                "Add the field to the record, or remove the placeholder from the template.",
                ctx,
              ),
        );
      }
      if (missing.length > 0) return undefined;
      if (filled.trim() === "") {
        diagnostics.push(
          finding(
            "data.frontmatter-empty",
            `The template's front matter is empty once filled: "${value}".`,
            "Point the value at a field with text, or set a literal value in the template.",
            ctx,
          ),
        );
        return undefined;
      }
      return filled;
    }
    if (Array.isArray(value)) return value.map((item) => walk(item, key));
    if (isMapping(value)) {
      const copy: Record<string, unknown> = {};
      for (const [childKey, childValue] of Object.entries(value)) {
        const filled = walk(childValue, childKey);
        if (filled !== undefined) copy[childKey] = filled;
      }
      return copy;
    }
    return value;
  };

  for (const [key, value] of Object.entries(data)) {
    const filled = walk(value, key);
    if (filled !== undefined) out[key] = filled;
  }
  return { data: out, diagnostics };
}
