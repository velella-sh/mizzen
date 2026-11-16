/**
 * The bounds of the MCP server: where a path may point, how large one answer may be, how long one call may run,
 * and how many calls run at once. Every tool answers through these, so no tool has to remember them.
 */
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** Largest answer, in UTF-8 bytes, before it is cut. */
export const MAX_ANSWER_BYTES = 64 * 1024;
/** Longest one call may run, in milliseconds. */
export const CALL_TIMEOUT_MS = 30_000;
/** Most calls that may run at the same time. */
export const MAX_IN_FLIGHT = 4;
/** Largest `maxTokens` `get_pack` accepts: about what one answer can carry. */
export const MAX_PACK_TOKENS = 12_000;

/** The limits a server runs with; tests lower them. */
export interface Limits {
  readonly maxAnswerBytes: number;
  readonly callTimeoutMs: number;
  readonly maxInFlight: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxAnswerBytes: MAX_ANSWER_BYTES,
  callTimeoutMs: CALL_TIMEOUT_MS,
  maxInFlight: MAX_IN_FLIGHT,
};

/** A refusal the caller can read: it becomes a tool error, never a crash. */
export class McpError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "McpError";
    this.code = code;
  }
}

/** A site-relative path with forward slashes on every platform. */
export function toSitePath(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join("/");
}

/**
 * Resolves `path` (site-relative) to a real absolute path and refuses anything outside `root`: a `..` escape, an
 * absolute path, and a symlink whose target leaves the site. The path need not exist (`mustExist: false`), in which
 * case its nearest existing parent is checked instead.
 */
export async function confine(root: string, path: string, mustExist = true): Promise<string> {
  if (path === "" || path.includes("\0") || isAbsolute(path) || /^[a-zA-Z]:/.test(path)) {
    throw new McpError("path-outside-site", `"${path}" is not a path inside the site.`);
  }
  const realRoot = await realpath(root);
  const lexical = resolve(realRoot, path);
  if (!inside(realRoot, lexical)) {
    throw new McpError("path-outside-site", `"${path}" is outside the site.`);
  }
  let probe = lexical;
  for (;;) {
    try {
      const real = await realpath(probe);
      if (!inside(realRoot, real)) {
        throw new McpError("path-outside-site", `"${path}" resolves outside the site.`);
      }
      return probe === lexical ? real : lexical;
    } catch (err) {
      if (err instanceof McpError) throw err;
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      if (mustExist) throw new McpError("not-found", `"${path}" does not exist in the site.`);
      const parent = resolve(probe, "..");
      if (parent === probe) throw new McpError("path-outside-site", `"${path}" is outside the site.`);
      probe = parent;
    }
  }
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Replaces every absolute folder of this machine in `text` with a site-relative stand-in. */
export function scrub(text: string, folders: readonly string[]): string {
  let out = text;
  for (const folder of [...folders].sort((a, b) => b.length - a.length)) {
    if (folder === "") continue;
    out = out.split(`${folder}${sep}`).join("").split(folder).join(".");
  }
  return out;
}

/** The answer cut to `maxBytes` of UTF-8 on a character boundary, with a note when it was cut. */
export function capAnswer(text: string, maxBytes: number): { readonly text: string; readonly truncated: boolean } {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return { text, truncated: false };
  const note = `\n\n[truncated: the answer was ${bytes} bytes and the limit is ${maxBytes}; narrow the request or page through it]`;
  const room = Math.max(0, maxBytes - Buffer.byteLength(note, "utf8"));
  let cut = Buffer.from(text, "utf8").subarray(0, room).toString("utf8");
  if (cut.endsWith("�")) cut = cut.slice(0, -1);
  return { text: cut + note, truncated: true };
}
