/**
 * Prints a site diff as text, JSON, or Markdown ready for a pull request comment.
 *
 * All three are pure functions of the report: no clock, no environment, and no path of the machine that ran them,
 * because a report holds none. The Markdown is capped: past `maxEntries` rows it says how many it left out, so a
 * large change never overflows a comment.
 */
import type { ChangedPage, FileRef, MovedPage, SiteDiff } from "./types.ts";

export const FORMATS = ["text", "json", "markdown"] as const;
export type DiffFormat = (typeof FORMATS)[number];

/** The hidden line that opens a Markdown report: a workflow finds its own earlier comment by it. */
export const MARKER = "<!-- mizzen-diff -->";

/** Rows of the Markdown tables, all tables together, unless a caller asks for another number. */
export const DEFAULT_MAX_ENTRIES = 50;

/** Blocks listed under one changed page in Markdown before "and n more". */
const MAX_BLOCKS = 5;

export interface MarkdownOptions {
  /** Most rows to print across all tables; the rest are counted in one closing line. */
  readonly maxEntries?: number;
  /** An origin or URL prefix that turns each page URL into a link readers can open, such as a preview site. */
  readonly linkBase?: string;
}

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

/** One sentence of counts, naming only what is not zero. */
export function summaryLine(diff: SiteDiff): string {
  if (diff.identical) return `The builds are identical (${diff.base.hash.slice(0, 12)}).`;
  const { pages, files, records } = diff.summary;
  const parts: string[] = [];
  const count = (n: number, label: string): void => {
    if (n > 0) parts.push(`${n} ${label}`);
  };
  count(pages.added, "added");
  count(pages.removed, "removed");
  count(pages.changed, "changed");
  count(pages.moved, "moved");
  const pagePart = parts.length === 0 ? "no page changes" : `pages: ${parts.join(", ")}`;
  const rest: string[] = [];
  const fileTotal = files.added + files.removed + files.changed;
  if (fileTotal > 0) rest.push(plural(fileTotal, "other file") + " changed");
  const recordTotal = records.added + records.removed + records.changed;
  if (recordTotal > 0) rest.push(plural(recordTotal, "record") + " changed");
  if (diff.summary.renderOnly > 0) rest.push(`${diff.summary.renderOnly} render-only`);
  if (diff.summary.brokenUrls > 0) rest.push(plural(diff.summary.brokenUrls, "broken URL"));
  return [pagePart, ...rest].join("; ") + ".";
}

function blockText(block: ChangedPage["blocks"][number]): string {
  const where = block.range === undefined ? "" : block.range.start === block.range.end ? ` (line ${block.range.start})` : ` (lines ${block.range.start}-${block.range.end})`;
  return `${block.kind} ${block.heading === null ? "text before the first heading" : block.heading}${where}`;
}

function moveText(move: MovedPage): string {
  return `${move.from} -> ${move.to} (same ${move.by}, ${move.redirect ? "redirected" : "no redirect"}${move.changed ? ", changed" : ""})`;
}

function sizeText(file: FileRef): string {
  return file.size === undefined ? "" : ` (${file.size} bytes)`;
}

/** The report as plain text for a terminal. */
export function formatText(diff: SiteDiff): string {
  const lines = [`mizzen diff ${diff.base.hash.slice(0, 12)}..${diff.head.hash.slice(0, 12)}: ${summaryLine(diff)}`];
  if (diff.identical) return `${lines.join("\n")}\n`;
  const section = (title: string, rows: readonly string[]): void => {
    if (rows.length === 0) return;
    lines.push("", `${title}:`, ...rows.map((row) => `  ${row}`));
  };
  section("Added pages", diff.pages.added.map((page) => `${page.url}  ${page.source}`));
  section("Removed pages", diff.pages.removed.map((page) => `${page.url}  ${page.source}`));
  section(
    "Changed pages",
    diff.pages.changed.flatMap((page) => [
      `${page.url}  ${page.source}  [${page.changes.join(", ")}]${page.renderOnly ? " render-only" : ""}`,
      ...page.blocks.map((block) => `  ${blockText(block)}`),
    ]),
  );
  section("Moved pages", diff.pages.moved.map(moveText));
  section("Broken URLs", diff.brokenUrls);
  section("Files", [
    ...diff.files.added.map((file) => `added ${file.name}${sizeText(file)}`),
    ...diff.files.removed.map((file) => `removed ${file.name}${sizeText(file)}`),
    ...diff.files.changed.map((file) => `changed ${file.name}${file.size === undefined ? "" : ` (${file.size.before} -> ${file.size.after} bytes)`}`),
  ]);
  section(
    "Records",
    diff.records.flatMap((collection) => [
      ...collection.added.map((record) => `${collection.collection}: added ${record.id} ${record.url}`),
      ...collection.removed.map((record) => `${collection.collection}: removed ${record.id} ${record.url}`),
      ...collection.changed.map((record) => {
        const fields = record.fields.map((field) => (field.before === undefined ? `${field.name} changed` : `${field.name}: ${JSON.stringify(field.before)} -> ${JSON.stringify(field.after)}`));
        const lists = record.lists.length === 0 ? "" : ` (lists: ${record.lists.join(", ")})`;
        return `${collection.collection}: changed ${record.id} ${record.url} [${fields.join("; ")}]${lists}`;
      }),
    ]),
  );
  return `${lines.join("\n")}\n`;
}

/** The report as JSON, two-space indented, ending with a line feed. */
export function formatJson(diff: SiteDiff): string {
  return `${JSON.stringify(diff, null, 2)}\n`;
}

/** Escapes text for a table cell: nothing the build's content wrote can start a link, a tag, or another cell. */
function cell(text: string): string {
  return text.replace(/[\r\n]+/gu, " ").replace(/[\\`|<>[\]!*_~]/gu, (char) => `\\${char}`);
}

function link(url: string, linkBase: string | undefined): string {
  const label = cell(url);
  if (linkBase === undefined) return label;
  const href = `${linkBase.replace(/\/$/u, "")}${url}`.replace(/[()\s]/gu, (char) => encodeURIComponent(char));
  return `[${label}](${href})`;
}

/** The report as a pull request comment: a summary line, then a table of pages with links. */
export function formatMarkdown(diff: SiteDiff, options: MarkdownOptions = {}): string {
  const out = [MARKER, "### Site diff", "", summaryLine(diff)];
  if (diff.identical) return `${out.join("\n")}\n`;

  const rows: string[] = [];
  const base = options.linkBase;
  for (const page of diff.pages.added) rows.push(`| ${link(page.url, base)} | added | \`${cell(page.source)}\` |`);
  for (const page of diff.pages.removed) rows.push(`| ${cell(page.url)} | removed | \`${cell(page.source)}\` |`);
  for (const page of diff.pages.changed) {
    const shown = page.blocks.slice(0, MAX_BLOCKS).map((block) => cell(blockText(block)));
    if (page.blocks.length > MAX_BLOCKS) shown.push(`and ${page.blocks.length - MAX_BLOCKS} more`);
    const detail = page.renderOnly ? "render-only" : shown.join("<br>") || page.changes.join(", ");
    rows.push(`| ${link(page.url, base)} | changed | ${detail} |`);
  }
  for (const move of diff.pages.moved) {
    rows.push(`| ${cell(move.from)} → ${link(move.to, base)} | moved | ${move.redirect ? "redirected" : "**no redirect**"} |`);
  }
  for (const url of diff.brokenUrls) rows.push(`| ${cell(url)} | broken URL | now answers 404 |`);
  for (const file of diff.files.added) rows.push(`| \`${cell(file.name)}\` | file added | ${cell(file.group)} |`);
  for (const file of diff.files.removed) rows.push(`| \`${cell(file.name)}\` | file removed | ${cell(file.group)} |`);
  for (const file of diff.files.changed) {
    rows.push(`| \`${cell(file.name)}\` | file changed | ${file.size === undefined ? cell(file.group) : `${file.size.before} → ${file.size.after} bytes`} |`);
  }
  for (const collection of diff.records) {
    for (const record of collection.added) rows.push(`| ${cell(collection.collection)}/${cell(record.id)} | record added | ${link(record.url, base)} |`);
    for (const record of collection.removed) rows.push(`| ${cell(collection.collection)}/${cell(record.id)} | record removed | ${cell(record.url)} |`);
    for (const record of collection.changed) {
      const fields = record.fields.map((field) => cell(field.name)).join(", ");
      rows.push(`| ${cell(collection.collection)}/${cell(record.id)} | record changed | ${fields} |`);
    }
  }

  const max = Math.max(0, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
  const shown = rows.slice(0, max);
  if (shown.length > 0) out.push("", "| Page | Change | Details |", "| --- | --- | --- |", ...shown);
  if (rows.length > shown.length) out.push("", `${plural(rows.length - shown.length, "more entry", "more entries")} left out of this comment; run \`mizzen diff --format json\` for the full report.`);
  return `${out.join("\n")}\n`;
}

/** The report in the format asked for. */
export function formatDiff(diff: SiteDiff, format: DiffFormat, options: MarkdownOptions = {}): string {
  if (format === "json") return formatJson(diff);
  if (format === "markdown") return formatMarkdown(diff, options);
  return formatText(diff);
}
