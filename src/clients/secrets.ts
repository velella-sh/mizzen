/**
 * The privacy boundary around client configuration. A generated configuration holds no secret: it
 * names a command and arguments only. When a caller does hold a token or header, it is written as
 * an environment reference (`${NAME}`) and resolved at the one authorized boundary, the launch;
 * everything printed, logged, or traced goes through the same redaction.
 */
import { redactText } from "../trace/safe.ts";

/** The fixed replacement for a secret value; it never carries a length or a prefix of the value. */
export const CLIENT_REDACTED = "[redacted]";

const SECRET_KEY = /(?:^|[-_.])(?:token|secret|password|passwd|api[-_]?key|authorization|cookie|credential|private[-_]?key)(?:$|[-_.])/i;

/** An environment reference for `name`, which only uppercase names may use. */
export function envReference(name: string): string {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) throw new Error(`${JSON.stringify(name)} is not an environment variable name.`);
  return `\${${name}}`;
}

function isReference(value: string): boolean {
  return /^\$\{[A-Z_][A-Z0-9_]*\}$/.test(value);
}

/** Free text with credentials and machine-local paths replaced; deterministic and idempotent. */
export function redactClientText(text: string): string {
  return redactText(text);
}

/**
 * A configuration value safe to print, log, or trace: a secret-named key and any credential-shaped
 * string are replaced, while an environment reference is kept because it names no value.
 */
export function redactClientConfig<T>(value: T): T {
  const walk = (input: unknown, key: string | undefined): unknown => {
    if (typeof input === "string") return key !== undefined && SECRET_KEY.test(key) && !isReference(input) ? CLIENT_REDACTED : redactClientText(input);
    if (Array.isArray(input)) return input.map((entry) => walk(entry, undefined));
    if (typeof input === "object" && input !== null) {
      const out: Record<string, unknown> = {};
      for (const name of Object.keys(input).sort()) out[name] = walk((input as Record<string, unknown>)[name], name);
      return out;
    }
    return input;
  };
  return walk(value, undefined) as T;
}

export interface EnvResolution {
  /** The text with every allowed reference resolved; an unavailable allowed name stays as it was. */
  readonly text: string;
  /** Allowed names the environment did not hold, in reference order. */
  readonly missing: readonly string[];
}

/**
 * Resolves `${NAME}` only for names the caller explicitly allows, at the launch boundary. Every
 * other reference is left untouched, so a printed configuration can never resolve a secret.
 */
export function resolveEnvReferences(text: string, env: Readonly<Record<string, string | undefined>>, allowed: readonly string[]): EnvResolution {
  const names = new Set(allowed);
  const missing: string[] = [];
  const resolved = text.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (whole: string, name: string) => {
    if (!names.has(name)) return whole;
    const value = env[name];
    if (value === undefined) {
      if (!missing.includes(name)) missing.push(name);
      return whole;
    }
    return value;
  });
  return { text: resolved, missing };
}
