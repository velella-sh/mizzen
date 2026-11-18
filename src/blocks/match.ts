/**
 * Gives a page's blocks the ids the previous lock recorded, so an edit or a move does not renumber the rest of the site.
 *
 * A declared id always wins and is never handed to another block. A block whose normalized source is unchanged takes
 * its recorded id next, first from the same page and then from any page, which covers reordering and moving a block.
 * On a page whose block count did not change, the blocks still unnamed take the page's remaining recorded ids in source
 * order, so a block edited between two unchanged anchors keeps its id.
 */
import type { Block } from "../contracts/index.ts";
import { recordedAnchors, type BlocksLock, type RecordedBlock } from "./lock.ts";

/** One page's blocks as {@link blocksOf} found them, keyed by the page's file. */
export interface MatchPage {
  readonly file: string;
  readonly blocks: readonly Block[];
}

/** The recorded id of the first unused block with `fingerprint`, preferring the block's own page. */
function byFingerprint(
  recorded: Readonly<Record<string, RecordedBlock>>,
  used: ReadonlySet<string>,
  fingerprint: string,
  file: string,
): string | undefined {
  let elsewhere: string | undefined;
  for (const [id, block] of Object.entries(recorded)) {
    if (used.has(id) || block.fingerprint !== fingerprint) continue;
    if (block.file === file) return id;
    elsewhere ??= id;
  }
  return elsewhere;
}

/** A page's recorded ids in source order, oldest line first, ties by id. */
function recordedOn(previous: BlocksLock, file: string): readonly string[] {
  const lines = previous.pages[file];
  if (lines === undefined) return [];
  return Object.keys(lines).sort((a, b) => lines[a]! - lines[b]! || (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Every page's blocks with the ids the previous lock recorded, or with the id {@link blocksOf} gave them when none fits.
 * An id is assigned at most once; every page appears in the result, even when nothing matched.
 */
export function matchBlockIds(
  previous: BlocksLock,
  pages: readonly MatchPage[],
): Map<string, readonly Block[]> {
  const used = new Set<string>();
  // Declared ids win everywhere, so they are claimed before any block may take one by content.
  for (const page of pages) {
    for (const block of page.blocks) if (block.declared === true) used.add(block.id);
  }
  const recorded = previous.blocks ?? {};

  const matched: (string | undefined)[][] = pages.map((page) =>
    page.blocks.map((block) => {
      if (block.declared === true) return block.id;
      if (block.fingerprint === undefined) return undefined;
      const id = byFingerprint(recorded, used, block.fingerprint, page.file);
      if (id !== undefined) used.add(id);
      return id;
    }),
  );

  // Only an unchanged block count says the remaining old ids line up with the remaining unnamed blocks; otherwise a
  // block was added or removed and guessing would rename a neighbour.
  for (const [index, page] of pages.entries()) {
    const old = recordedOn(previous, page.file);
    if (old.length !== page.blocks.length) continue;
    const unnamed = matched[index]!;
    const remaining = old.filter((id) => !used.has(id));
    for (let i = 0; i < unnamed.length && remaining.length > 0; i += 1) {
      if (unnamed[i] !== undefined) continue;
      const id = remaining.shift()!;
      unnamed[i] = id;
      used.add(id);
    }
  }

  const result = new Map<string, readonly Block[]>();
  for (const [index, page] of pages.entries()) {
    const ids = matched[index]!;
    result.set(
      page.file,
      page.blocks.map((block, i) => {
        const id = ids[i] ?? block.id;
        const renumbered = id === block.id ? block : { ...block, id };
        return { ...renumbered, ...recordedAnchors(recorded[id], block.anchor) };
      }),
    );
  }
  return result;
}
