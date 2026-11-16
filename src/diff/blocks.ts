/**
 * Reports the changed blocks of a changed page, from the Markdown twins of both builds.
 *
 * The twins are compared by heading with `diffMarkdown` (`src/versions/diff.ts`), never as HTML text. A section that
 * only moved is `moved`; one that moved and was also edited is reported twice, once for each. A page whose rendered
 * HTML changed while its twin did not is a render-only change: it has no blocks.
 */
import { diffMarkdown } from "../versions/diff.ts";
import type { Build } from "./builds.ts";
import { twinOf, type PageDelta } from "./pages.ts";
import type { Reader } from "./reader.ts";
import type { Block, ChangedPage } from "./types.ts";

/** Runs of whitespace collapse: a reflowed paragraph is not an edit. */
function normalized(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/** The number of lines of a text, counting a last line without a terminator. */
function lineCount(text: string): number {
  return text === "" ? 1 : text.split(/\r\n|\r|\n/u).length - (/(\r\n|\r|\n)$/u.test(text) ? 1 : 0);
}

/** The blocks of one page's twins; empty when the text did not change or no twin was written. */
export async function blocksOf(base: Build, head: Build, delta: PageDelta, reader: Reader): Promise<Block[]> {
  if (!delta.changes.includes("text")) return [];
  const [before, after] = await Promise.all([
    reader.text(base, twinOf(delta.base)),
    reader.text(head, twinOf(delta.head)),
  ]);
  if (before === undefined || after === undefined) return [];

  const diff = diffMarkdown(before, after);
  const inHead: Block[] = [];
  for (const section of diff.added) {
    inHead.push({ heading: section.heading, id: section.id, kind: "added", range: { ...section.newRange } });
  }
  for (const section of diff.changed) {
    inHead.push({ heading: section.heading, id: section.id, kind: "edited", range: { ...section.newRange } });
  }
  for (const section of diff.moved) {
    inHead.push({ heading: section.heading, id: section.id, kind: "moved", range: { ...section.newRange } });
    if (normalized(section.oldText) !== normalized(section.newText)) {
      inHead.push({ heading: section.heading, id: section.id, kind: "edited", range: { ...section.newRange } });
    }
  }
  const order: Record<string, number> = { added: 0, edited: 1, moved: 2, removed: 3 };
  inHead.sort((a, b) => (a.range?.start ?? 0) - (b.range?.start ?? 0) || (order[a.kind] ?? 0) - (order[b.kind] ?? 0));

  const removed: Block[] = diff.removed.map((section) => ({
    heading: section.heading,
    id: section.id,
    kind: "removed",
    range: { ...section.oldRange },
  }));
  removed.sort((a, b) => (a.range?.start ?? 0) - (b.range?.start ?? 0));
  const blocks = [...inHead, ...removed];

  // Text outside every section (before the first heading) is not a section: say it changed rather than say nothing.
  if (blocks.length === 0 && normalized(before) !== normalized(after)) {
    blocks.push({ heading: null, id: null, kind: "edited", range: { start: 1, end: lineCount(after) } });
  }
  return blocks;
}

/** A changed page as the report lists it. */
export async function changedPage(base: Build, head: Build, delta: PageDelta, reader: Reader): Promise<ChangedPage> {
  return {
    url: delta.head.url,
    source: delta.head.source,
    title: delta.head.title,
    changes: delta.changes,
    renderOnly: delta.changes.length === 1 && delta.changes[0] === "html",
    blocks: await blocksOf(base, head, delta, reader),
  };
}
