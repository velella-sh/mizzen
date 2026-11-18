/**
 * Stored machine references: a page identifier (the page's source path), a block identifier, and the reference
 * format version. A reference is written against one build and read against a later one, so resolution follows the
 * block id to where the build put it instead of trusting the recorded URL.
 *
 * A build without `blocks.lock.json` has no block ids and resolves nothing; the lock is what records removals, so an
 * id the lock knows but the build no longer has is `removed`, and one the lock never saw is `unknown`.
 */
import type { BlockReference, Page, ReferenceResolution } from "../contracts/index.ts";
import { isBlockId } from "./id.ts";
import type { BlocksLock } from "./lock.ts";

/** The reference format version this engine writes and reads. */
export const REFERENCE_VERSION = 1;

/** A reference to `block` on the page whose source path is `page`, in the current format. */
export function blockReference(page: string, block: string, build?: string): BlockReference {
  return { version: REFERENCE_VERSION, page, block, ...(build === undefined ? {} : { build }) };
}

/** Why `value` is not a reference this engine reads; `undefined` when it is one. */
export function referenceProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "a reference must be an object";
  const record = value as Record<string, unknown>;
  if (record.version !== REFERENCE_VERSION) return `version must be ${REFERENCE_VERSION}`;
  if (typeof record.page !== "string" || record.page === "") return "page must be a non-empty source path";
  if (typeof record.block !== "string" || !isBlockId(record.block)) return "block must be a block id";
  if (record.build !== undefined && (typeof record.build !== "string" || record.build === "")) {
    return "build must be a non-empty version";
  }
  return undefined;
}

/** True when `value` is a reference this engine reads. */
export function isBlockReference(value: unknown): value is BlockReference {
  return referenceProblem(value) === undefined;
}

/** True when the lock recorded `block` on any page. */
function recorded(block: string, lock: BlocksLock): boolean {
  if (lock.blocks?.[block] !== undefined) return true;
  return Object.values(lock.pages).some((ids) => ids[block] !== undefined);
}

/**
 * Resolves one stored reference against a build: the pages of the current model and the lock earlier builds wrote.
 * The block id is looked up in the built pages, so a changed page URL or a block that moved to another page resolves
 * at the destination the build gave it.
 */
export function resolveReference(
  reference: BlockReference,
  sources: { readonly lock: BlocksLock; readonly pages: readonly Page[] },
): ReferenceResolution {
  const holder = sources.pages.find((page) => page.blocks?.some((block) => block.id === reference.block));
  if (holder !== undefined) {
    return {
      status: "resolved",
      reference,
      url: holder.url,
      source: holder.source.file,
      ...(holder.source.file === reference.page ? {} : { moved: true }),
    };
  }
  return { status: recorded(reference.block, sources.lock) ? "removed" : "unknown", reference };
}

/** Resolves every reference in `references`, in input order. */
export function resolveReferences(
  references: readonly BlockReference[],
  sources: { readonly lock: BlocksLock; readonly pages: readonly Page[] },
): readonly ReferenceResolution[] {
  return references.map((reference) => resolveReference(reference, sources));
}
