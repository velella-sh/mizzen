/**
 * The safe-value half of a trace: what may be written, what must be redacted, and the derived hashes.
 *
 * A trace never stores an input body; it stores the SHA-256 of the canonical input. Anything that
 * points at a result is a reference: a site-relative path, a content hash, or an `https:` URL. An
 * absolute path, a home directory, a Windows drive, a traversal segment, or a URL with credentials
 * is refused rather than written. Free text that survives (a reason or a goal) goes through
 * {@link redactText}, so a machine-local path or a credential cannot leak through prose either.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "../data/lock.ts";

/** Hashing of one canonical input. The input itself is not kept. */
export function inputHashOf(input: unknown): string {
  return createHash("sha256").update(`mizzen-trace-input\0${canonicalJson(input)}`).digest("hex");
}

/** The receipt id: the kind and the reference, in a fixed order. */
export function receiptIdOf(kind: string, reference: string): string {
  return createHash("sha256").update(`mizzen-trace-receipt\0${kind}\0${reference}`).digest("hex");
}

/** True when `value` names a machine-local location rather than a site-relative reference. */
export function isLocalPath(value: string): boolean {
  const text = value.trim();
  if (text === "") return false;
  if (text.startsWith("~/") || text.startsWith("~\\")) return true;
  if (text.startsWith("file:")) return true;
  if (/^[A-Za-z]:[\\/]/.test(text)) return true;
  if (/^\\\\/.test(text)) return true;
  if (text.startsWith("/")) return true;
  return text.split(/[\\/]+/).includes("..");
}

/** Credential shapes a reference must not carry. */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /^[a-z][a-z0-9+.-]*:\/\/[^/\s]*@/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{12,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\b(?:api[_-]?key|token|secret|password|passwd)\s*[:=]\s*\S{8,}/i,
];

/** True when `value` looks like it carries a credential. */
export function hasCredential(value: string): boolean {
  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value));
}

/** Why a reference cannot be written, or `undefined` when it is safe. */
export function referenceProblem(value: string): string | undefined {
  if (value.trim() === "") return "a reference cannot be empty";
  if (value !== value.trim()) return "a reference cannot start or end with whitespace";
  if (/[\u0000-\u001f\u007f]/.test(value)) return "a reference cannot contain a control character";
  if (isLocalPath(value)) return "a reference cannot name an absolute or machine-local path";
  if (hasCredential(value)) return "a reference cannot carry a credential";
  if (value.startsWith("//") || value.includes("\\")) return "a reference uses forward slashes and no host prefix";
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^https:\/\//i.test(value)) {
    return "a reference URL must use https";
  }
  return undefined;
}

/** What a redaction replaced. */
const REDACTIONS: readonly { readonly pattern: RegExp; readonly replacement: string }[] = [
  { pattern: /\bfile:\/\/[^\s"'`]+/gi, replacement: "[redacted-path]" },
  { pattern: /(?:\/Users|\/home|\/private\/var|\/var\/folders)\/[^\s"'`)]+/g, replacement: "[redacted-path]" },
  { pattern: /\b[A-Za-z]:\\[^\s"'`)]+/g, replacement: "[redacted-path]" },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, replacement: "Bearer [redacted-credential]" },
  { pattern: /\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{12,}/g, replacement: "[redacted-credential]" },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, replacement: "[redacted-credential]" },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replacement: "[redacted-credential]" },
  { pattern: /^([a-z][a-z0-9+.-]*:\/\/)[^/\s@]*@/i, replacement: "$1[redacted-credential]@" },
  { pattern: /\b(?:api[_-]?key|token|secret|password|passwd)\s*[:=]\s*\S{8,}/gi, replacement: "[redacted-credential]" },
];

/** Replaces every machine-local path and credential in free text with a stable marker. */
export function redactText(value: string): string {
  let text = value;
  for (const { pattern, replacement } of REDACTIONS) text = text.replace(pattern, replacement);
  return text;
}

/** The keys a request must not use to pass private model reasoning. */
export const PRIVATE_REASONING_KEYS = [
  "chainOfThought",
  "chain_of_thought",
  "cot",
  "reasoning",
  "thinking",
  "thoughts",
] as const;

/** True when a value carries a private-reasoning key at any depth. */
export function hasPrivateReasoning(value: unknown, depth = 0): boolean {
  if (depth > 20) return false;
  if (Array.isArray(value)) return value.some((entry) => hasPrivateReasoning(entry, depth + 1));
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).some(
    (key) => (PRIVATE_REASONING_KEYS as readonly string[]).includes(key) || hasPrivateReasoning(record[key], depth + 1),
  );
}
