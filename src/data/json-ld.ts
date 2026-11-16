/**
 * Builds a record page's JSON-LD object from the mapping a collection writes under `seo.jsonLd`.
 *
 * The site writes the mapping, so Mizzen ships no list of schema.org types. A string value may name record fields as
 * `{field}` or `{path.to.field}` (`{{` and `}}` are literal braces). A value that is exactly one placeholder keeps the
 * field's own type, so a number stays a number and a list stays a list. A property whose field is missing or empty is
 * dropped, and so is a nested object that held fields and lost them all. Nothing here reads the clock.
 */

/** True when the mapping has a non-empty `@type`, string or list of strings: the one thing a JSON-LD object needs. */
export function hasJsonLdType(mapping: Readonly<Record<string, unknown>>): boolean {
  const type = mapping["@type"];
  if (typeof type === "string") return type.trim() !== "";
  return Array.isArray(type) && type.length > 0 && type.every((item) => typeof item === "string" && item.trim() !== "");
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The value at a dot path of the record's fields: own keys only, numeric segments index a list. */
function lookup(fields: Readonly<Record<string, unknown>>, path: string): unknown {
  let current: unknown = fields;
  for (const segment of path.split(".").map((part) => part.trim())) {
    if (segment === "" || typeof current !== "object" || current === null) return undefined;
    if (Array.isArray(current)) {
      const index = /^\d+$/.test(segment) ? Number(segment) : -1;
      current = current[index];
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function isEmpty(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim() === "") ||
    (Array.isArray(value) && value.length === 0)
  );
}

function scalar(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

const WHOLE = /^\{([^{}]+)\}$/;
const PLACEHOLDER = /\{\{|\}\}|\{([^{}]+)\}/g;

/** What one mapped value became: the value (`undefined` when dropped) and how many fields it read. */
interface Mapped {
  readonly value: unknown;
  readonly dynamic: number;
}

function mapString(text: string, fields: Readonly<Record<string, unknown>>): Mapped {
  const whole = WHOLE.exec(text);
  if (whole !== null) {
    const value = lookup(fields, whole[1]!);
    return isEmpty(value) ? { value: undefined, dynamic: 1 } : { value, dynamic: 1 };
  }
  let dynamic = 0;
  let missing = false;
  const filled = text.replace(PLACEHOLDER, (match, path: string | undefined) => {
    if (path === undefined) return match === "{{" ? "{" : "}";
    dynamic += 1;
    const value = scalar(lookup(fields, path));
    if (value === undefined || value.trim() === "") {
      missing = true;
      return "";
    }
    return value;
  });
  return missing ? { value: undefined, dynamic } : { value: filled, dynamic };
}

function map(value: unknown, fields: Readonly<Record<string, unknown>>): Mapped {
  if (typeof value === "string") return mapString(value, fields);
  if (Array.isArray(value)) {
    let dynamic = 0;
    const items: unknown[] = [];
    for (const item of value) {
      const mapped = map(item, fields);
      dynamic += mapped.dynamic;
      if (mapped.value !== undefined) items.push(mapped.value);
    }
    // A list that read fields and kept nothing is dropped; a literal list stays as written.
    return items.length === 0 && value.length > 0 && dynamic > 0 ? { value: undefined, dynamic } : { value: items, dynamic };
  }
  if (isMapping(value)) {
    let dynamic = 0;
    let kept = 0;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const mapped = map(child, fields);
      dynamic += mapped.dynamic;
      if (mapped.value === undefined) continue;
      out[key] = mapped.value;
      kept += mapped.dynamic;
    }
    // An object that read fields and kept none of them (only its literal `@type` is left) says nothing: drop it.
    return dynamic > 0 && kept === 0 ? { value: undefined, dynamic } : { value: out, dynamic: kept };
  }
  return { value, dynamic: 0 };
}

/**
 * The JSON-LD object of one record: the mapping with its fields filled in and `@context` defaulted to schema.org.
 * Returns `undefined` for a mapping without `@type`, which the SEO check reports as `data.json-ld-type`, and for a
 * record whose mapped fields are all empty.
 */
export function jsonLdFromMapping(
  mapping: Readonly<Record<string, unknown>>,
  fields: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | undefined {
  if (!hasJsonLdType(mapping)) return undefined;
  const mapped = map(mapping, fields);
  if (!isMapping(mapped.value)) return undefined;
  // A record whose every mapped field is empty gets no object at all: a bare `@type` says nothing.
  const { "@context": context, ...rest } = mapped.value;
  return { "@context": typeof context === "string" ? context : "https://schema.org", ...rest };
}
