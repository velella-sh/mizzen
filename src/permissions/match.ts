/**
 * The small matchers every access decision shares: references, site paths, globs, and network destinations.
 *
 * Matching is case-sensitive and never consult the file system. A reference may be an exact id, a URL, a source
 * path, or a glob (`*` within a segment, `**` across segments, `?` one character). A trailing slash and a leading
 * slash are presentation, not identity, so `/guide/` and `guide.md` still match their exact forms.
 */
import { globToRegExp } from "../stale/covers.ts";

/** Compares strings by code point, never by locale. */
export function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A value without a leading `./` or `/`, and without a trailing `/`. */
export function normalizeReference(value: string): string {
  let out = value.trim().replace(/\\/g, "/");
  while (out.startsWith("./")) out = out.slice(2);
  if (out.startsWith("/")) out = out.slice(1);
  if (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

/** True when `pattern` is a glob rather than one exact reference. */
export function isGlob(pattern: string): boolean {
  return /[*?]/.test(pattern);
}

/** True when one reference names `value`, exactly or as a glob. */
export function referenceMatches(pattern: string, value: string): boolean {
  const target = normalizeReference(value);
  const candidate = normalizeReference(pattern);
  if (candidate === "" || target === "") return false;
  if (isGlob(candidate)) return globToRegExp(candidate).test(target);
  return candidate === target;
}

/** True when one of `references` names `value`. An absent list matches nothing; the caller decides what absent means. */
export function anyReferenceMatches(references: readonly string[] | undefined, value: string): boolean {
  return references !== undefined && references.some((reference) => referenceMatches(reference, value));
}

/** True when every reference in `child` is named by one in `parent`; a parent `**` or `*` covers every child. */
export function referencesWithin(
  parent: readonly string[] | undefined,
  child: readonly string[],
): boolean {
  if (parent === undefined) return true;
  if (parent.includes("*") || parent.includes("**")) return true;
  return child.every((entry) => parent.some((allowed) => referenceCovers(allowed, entry)));
}

/** True when every value `child` can match is also matched by `parent`; an approximation with no file read. */
export function referenceCovers(parent: string, child: string): boolean {
  const allowed = normalizeReference(parent);
  const wanted = normalizeReference(child);
  if (allowed === wanted) return true;
  if (!isGlob(wanted)) return referenceMatches(allowed, wanted);
  if (!isGlob(allowed)) return false;
  if (allowed === "**" || allowed === "*") return true;
  // A child glob is covered only by an identical glob or a broader `**` suffix/prefix.
  return globToRegExp(allowed).test(wanted.replace(/\*/g, "x").replace(/\?/g, "x"));
}

/** True when a site-relative path or glob names `path`. */
export function pathMatches(pattern: string, path: string): boolean {
  return referenceMatches(pattern, path);
}

/**
 * A site-relative write path, or why it cannot be one. The check is lexical: `..` survives no rewrite, a
 * backslash never becomes a separator, and an absolute path or drive letter is refused. Symlinks are checked
 * separately against the resolved file system path.
 */
export function sitePathProblem(path: string): string | undefined {
  const text = path.trim();
  if (text === "") return "it is empty";
  if (text.startsWith("/") || /^[A-Za-z]:/.test(text)) return "it is absolute";
  if (text.includes("\\")) return "it uses a backslash";
  if (text.split("/").some((segment) => segment === ".." || segment === ".")) return "it has a `.` or `..` segment";
  if (text.includes("\u0000")) return "it holds a NUL byte";
  return undefined;
}

/** True when a network pattern names `destination`: exact URL, exact host, a subdomain glob, or `*`. */
export function destinationMatches(pattern: string, destination: string): boolean {
  const allowed = pattern.trim().toLowerCase();
  const target = destination.trim().toLowerCase();
  if (allowed === "*" || allowed === "**") return true;
  if (allowed === target) return true;
  if (!allowed.includes("://") && target.includes("://")) {
    const host = hostOf(target);
    if (host === undefined) return false;
    if (allowed.startsWith("*.")) {
      const suffix = allowed.slice(1);
      return host.endsWith(suffix) && host.length > suffix.length;
    }
    return host === allowed;
  }
  if (isGlob(allowed)) {
    try {
      return globToRegExp(allowed).test(target);
    } catch {
      return false;
    }
  }
  return false;
}

/** The host of an absolute URL, or undefined when it is not one. */
export function hostOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.host.toLowerCase();
  } catch {
    return undefined;
  }
}

/** The destination as a URL with its path and query removed, so an approval never names a secret URL. */
export function destinationOf(url: string): string {
  const host = hostOf(url);
  if (host === undefined) return url.trim();
  try {
    return new URL(url).origin;
  } catch {
    return host;
  }
}
