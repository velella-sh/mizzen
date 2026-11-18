/**
 * Block identifiers: `[a-z0-9][a-z0-9-]{0,63}`, unique in the whole site. A block that declares none gets
 * `b-<10 hex>`, a digest of its page and its Markdown, so the same content on the same page always gets the same id.
 */
import { sha256 } from "../data/lock.ts";

/** The contract every explicit and automatic block id matches. */
export const BLOCK_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** True when `value` is a block id. */
export function isBlockId(value: string): boolean {
  return BLOCK_ID.test(value);
}

/** The automatic id of a block: `b-` and ten hex characters of the block's page and Markdown. */
export function autoBlockId(page: string, markdown: string): string {
  return `b-${sha256(`${page}\u0000${markdown}`).slice(0, 10)}`;
}

/** A block's normalized source: LF line endings and no surrounding whitespace. */
export function blockFingerprint(source: string): string {
  return sha256(source.replace(/\r\n?/g, "\n").trim());
}
