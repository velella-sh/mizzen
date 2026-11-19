/**
 * Check stable references before and after a task (#1185).
 *
 * A snapshot names the URLs the site links to, the block ids it can point at, and the old-path
 * redirects it publishes. Comparing the two snapshots catches the three ways a docs change
 * usually breaks readers:
 *
 * - a URL that no longer appears, unless an explicit policy allows removing it;
 * - a block id that no longer exists, unless the same policy allows it;
 * - a redirect whose target changed, or that disappeared, unless policy allows that exact
 *   change.
 *
 * A URL must be an absolute `http` or `https` address with a host. A redirect key must be a
 * root-relative path without a query, fragment, backslash, or control character. An invalid
 * value is reported on both sides and never passes. The policy is the only way to remove or
 * move a reference: an empty policy therefore fails a task that removes even one.
 */
import type {
  VerificationReferenceIssue,
  VerificationReferenceKind,
  VerificationReferences,
} from "../contracts/verification.ts";

/** The references a site publishes at one point. */
export interface ReferenceSnapshot {
  readonly urls: readonly string[];
  readonly blocks: readonly string[];
  readonly redirects: Readonly<Record<string, string>>;
}

/** The only ways a reference may disappear or move. */
export interface ReferencePolicy {
  /** Removal keys, such as `url:https://example.com`, `block:install`, or `redirect:/old`. */
  readonly allowedRemovals?: readonly string[];
  /** Redirect target changes, such as `{ ref: "redirect:/old", to: "/new" }`. */
  readonly allowedChanges?: readonly { readonly ref: string; readonly to: string }[];
}

/** The stable key a removal policy names. */
export function referenceKey(kind: VerificationReferenceKind, ref: string): string {
  return `${kind}:${ref}`;
}

/** True for an absolute `http` or `https` URL with a host. */
function validUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.host !== "";
  } catch {
    return false;
  }
}

/** True for a root-relative path an old URL can use. */
function validRedirectPath(value: string): boolean {
  if (!value.startsWith("/") || value.includes("\\") || value.includes("?") || value.includes("#")) return false;
  if (/[\u0000-\u001f\u007f]/u.test(value)) return false;
  return !value.split("/").slice(1).some((segment) => segment === "." || segment === "..");
}

/** A sorted, de-duplicated list of strings. */
function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The reference check for two snapshots. */
export function compareReferences(
  before: ReferenceSnapshot,
  after: ReferenceSnapshot,
  policy: ReferencePolicy = {},
): VerificationReferences {
  const issues: VerificationReferenceIssue[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  const invalid: string[] = [];
  const allowedRemovals = new Set(policy.allowedRemovals ?? []);
  const allowedChanges = new Set((policy.allowedChanges ?? []).map((entry) => `${entry.ref}\0${entry.to}`));

  const reportInvalid = (kind: VerificationReferenceKind, ref: string, message: string): void => {
    invalid.push(referenceKey(kind, ref));
    issues.push({ code: "verification.reference-invalid", kind, ref, message });
  };

  for (const url of sorted(before.urls)) {
    if (!validUrl(url)) reportInvalid("url", url, `"${url}" is not an absolute http or https URL.`);
  }
  for (const url of sorted(after.urls)) {
    if (!validUrl(url)) reportInvalid("url", url, `"${url}" is not an absolute http or https URL.`);
  }
  const afterUrls = new Set(after.urls);
  for (const url of sorted(before.urls)) {
    if (afterUrls.has(url) || !validUrl(url)) continue;
    const key = referenceKey("url", url);
    removed.push(key);
    if (!allowedRemovals.has(key)) {
      issues.push({
        code: "verification.reference-removed",
        kind: "url",
        ref: url,
        message: `URL "${url}" was removed without an explicit policy.`,
      });
    }
  }

  const afterBlocks = new Set(after.blocks);
  for (const block of sorted(before.blocks)) {
    if (block.trim() === "") reportInvalid("block", block, "A block reference cannot be empty.");
    if (afterBlocks.has(block)) continue;
    const key = referenceKey("block", block);
    removed.push(key);
    if (!allowedRemovals.has(key)) {
      issues.push({
        code: "verification.reference-removed",
        kind: "block",
        ref: block,
        message: `Block reference "${block}" no longer exists and no policy allows removing it.`,
      });
    }
  }
  for (const block of sorted(after.blocks)) {
    if (block.trim() === "") reportInvalid("block", block, "A block reference cannot be empty.");
  }

  for (const [from, to] of Object.entries(before.redirects).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!validRedirectPath(from)) reportInvalid("redirect", from, `"${from}" is not a root-relative redirect path.`);
    if (!validRedirectPath(to) && !validUrl(to)) {
      reportInvalid("redirect", from, `Redirect "${from}" target "${to}" is not a site path or https URL.`);
    }
  }
  for (const [from, to] of Object.entries(after.redirects).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!validRedirectPath(from)) reportInvalid("redirect", from, `"${from}" is not a root-relative redirect path.`);
    if (!validRedirectPath(to) && !validUrl(to)) {
      reportInvalid("redirect", from, `Redirect "${from}" target "${to}" is not a site path or https URL.`);
    }
    const was = before.redirects[from];
    if (was === undefined || was === to) continue;
    const key = referenceKey("redirect", from);
    changed.push(key);
    if (!allowedChanges.has(`${key}\0${to}`)) {
      issues.push({
        code: "verification.reference-changed",
        kind: "redirect",
        ref: from,
        message: `Redirect "${from}" moved from "${was}" to "${to}" without an explicit policy.`,
      });
    }
  }
  for (const from of sorted(Object.keys(before.redirects))) {
    if (after.redirects[from] !== undefined) continue;
    const key = referenceKey("redirect", from);
    removed.push(key);
    if (!allowedRemovals.has(key)) {
      issues.push({
        code: "verification.reference-removed",
        kind: "redirect",
        ref: from,
        message: `Redirect "${from}" was removed without an explicit policy.`,
      });
    }
  }

  return {
    ok: issues.length === 0,
    removed: sorted(removed),
    changed: sorted(changed),
    invalid: sorted(invalid),
    issues,
  };
}

/** One sentence for a failed reference check. */
export function referencesMessage(references: VerificationReferences): string {
  if (references.ok) return "every URL, block reference, and redirect still resolves.";
  return references.issues.map((issue) => issue.message).join(" ");
}
