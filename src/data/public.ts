/**
 * The public-field policy of a collection: `public` lists the dot paths every public output may publish. The record
 * keeps every field internally, so transforms, joins, permalinks, and sorting still read what the source wrote; the
 * policy is applied where data leaves the engine, never at ingestion.
 *
 * A policy is an allowlist. Entries name leaves (`author.name`) or a whole subtree (`author`), a record's `id` is always
 * public, and an absent policy publishes every field as before. `public: []` therefore publishes only `id`.
 */
import type { DataRecord, Diagnostic, SourcePos } from "../contracts/index.ts";

/** A collection's `public` list; `undefined` means every field is public. */
export type PublicPolicy = readonly string[] | undefined;

/** The value that means "this leaf is not public": distinct from `undefined`, which a field may hold. */
const OMIT = Symbol("omit");

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The segments of a policy entry or field path, without blanks. */
function segmentsOf(path: string): string[] {
  return path
    .split(".")
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "");
}

function policySegments(policy: PublicPolicy): readonly (readonly string[])[] {
  const out: string[][] = [];
  for (const entry of policy ?? []) {
    const segments = segmentsOf(entry);
    if (segments.length > 0) out.push(segments);
  }
  return out;
}

function startsWith(path: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment);
}

/**
 * Whether a public output may read the value at `path`: true for `id`, for a path and its ancestors, and for every
 * path under an allowed one. An ancestor is true so a nested allowlist can still build its container; use
 * {@link isPublicReference} when the whole value would be published.
 */
export function isPublicPath(policy: PublicPolicy, path: string): boolean {
  if (policy === undefined) return true;
  const target = segmentsOf(path);
  if (target.length === 0) return false;
  if (target[0] === "id") return true;
  return policySegments(policy).some(
    (entry) => startsWith(target, entry) || startsWith(entry, target),
  );
}

/**
 * Whether the value at `path` is public in full: the path sits at or under an allowlist entry. Unlike
 * {@link isPublicPath}, an ancestor of a nested entry is false, because publishing it would publish its private
 * siblings too.
 */
export function isPublicReference(policy: PublicPolicy, path: string): boolean {
  if (policy === undefined) return true;
  const target = segmentsOf(path);
  if (target.length === 0) return false;
  if (target[0] === "id") return true;
  return policySegments(policy).some((entry) => startsWith(target, entry));
}

/** Assigns an own enumerable key, so a field named `__proto__` stays data rather than becoming the prototype. */
function put(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

/** Keeps only the entries an object may publish, descending one segment at a time; `OMIT` drops the node. */
function project(value: unknown, entries: readonly (readonly string[])[]): unknown {
  if (Array.isArray(value)) {
    // A list adds no path segment: every item is filtered by the same entries.
    const items = value.map((item) => project(item, entries)).filter((item) => item !== OMIT);
    return items;
  }
  if (!isMapping(value)) return OMIT;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "id") {
      put(out, key, child);
      continue;
    }
    const whole = entries.some((entry) => entry.length === 1 && entry[0] === key);
    if (whole) {
      put(out, key, child);
      continue;
    }
    const below = entries.filter((entry) => entry.length > 1 && entry[0] === key).map((entry) => entry.slice(1));
    if (below.length === 0) continue;
    const projected = project(child, below);
    if (projected !== OMIT) put(out, key, projected);
  }
  return out;
}

/**
 * One record's fields as the public outputs may see them: undeclared leaves are dropped, containers of declared
 * leaves are kept, and `id` always survives. A policy entry that names a scalar the record does not hold simply
 * matches nothing. Without a policy the same object comes back, so an existing site keeps its identity and order.
 */
export function publicFields(
  fields: Readonly<Record<string, unknown>>,
  policy: PublicPolicy,
): Readonly<Record<string, unknown>> {
  if (policy === undefined) return fields;
  const projected = project(fields, policySegments(policy));
  return projected === OMIT ? {} : (projected as Record<string, unknown>);
}

/**
 * A record with its fields and derived values projected through the policy. The id, positions, and dates stay; the
 * internal record the caller holds is never mutated, so a later transform or join still reads every field.
 */
export function publicRecord<T extends {
  readonly fields: Readonly<Record<string, unknown>>;
  readonly derived?: Readonly<Record<string, unknown>> | undefined;
}>(record: T, policy: PublicPolicy): T {
  if (policy === undefined) return record;
  return {
    ...record,
    fields: publicFields(record.fields, policy),
    ...(record.derived === undefined ? {} : { derived: publicFields(record.derived, policy) }),
  };
}

/** The field paths a text names: `{path}` and `{path|slug}` placeholders, and `:field[path]` directives. */
export function publicReferencesIn(text: string): readonly string[] {
  const paths: string[] = [];
  for (const match of text.matchAll(/\{\{|\}\}|\{([^{}]+)\}/g)) {
    const inner = match[1];
    if (inner === undefined) continue;
    const path = (inner.split("|")[0] ?? "").trim();
    if (path !== "") paths.push(path);
  }
  for (const match of text.matchAll(/:field\[([^\]]+)\]/g)) {
    const path = (match[1] ?? "").trim();
    if (path !== "") paths.push(path);
  }
  return [...new Set(paths)];
}

/**
 * Findings for field references a public setting makes that the collection's `public` policy does not allow. One
 * finding per distinct path, at the config key or template line that names it; the build reports them before anything
 * is written, so a private value never reaches an output through a permalink, SEO tag, or directive.
 */
export function publicReferenceDiagnostics(
  collection: string,
  policy: PublicPolicy,
  references: Iterable<string>,
  where: string,
  pos?: SourcePos,
): Diagnostic[] {
  if (policy === undefined) return [];
  const reported = new Set<string>();
  const found: Diagnostic[] = [];
  for (const path of references) {
    if (isPublicReference(policy, path) || reported.has(path)) continue;
    reported.add(path);
    found.push({
      id: "data.public-reference",
      severity: "error",
      message: `The public policy of "${collection}" does not allow "${path}", which ${where} references.`,
      ...(pos === undefined ? {} : { pos }),
      help: `Add "${path}" to \`collections.${collection}.public\`, or stop referencing it from ${where}.`,
    });
  }
  return found;
}
