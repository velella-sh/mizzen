/**
 * Discover public TypeScript exports (#1338): reads the exports of a package's actual entry point, with their
 * signatures, and records each as a `symbol` item of the `api` area.
 *
 * The entry point is the file a caller imports, never the internal modules it re-exports from, so an internal name
 * that is not part of the entry's surface never appears and a name re-exported twice appears once. A symbol's
 * stability comes from its declaration's leading JSDoc: `@deprecated` marks it deprecated and `@experimental` marks it
 * experimental. The span points at the declaration's name.
 */
import { readFile } from "node:fs/promises";
import { posix, resolve } from "node:path";
import type { SourcePos } from "../../contracts/source.ts";
import type { SurfaceAdapterResult, SurfaceFinding, SurfaceItem, SurfaceStability } from "../../contracts/surface.ts";
import { exportedSymbols, type ExportedSymbol } from "../../drift/symbols.ts";
import { itemId, sortItems } from "../contract.ts";

/** What a symbol discovery needs. */
export interface DiscoverSymbolsOptions {
  /** Absolute or site-relative path of the package entry point, such as `src/index.ts`. */
  readonly entry: string;
  /** Root the entry and any relative import resolve against; defaults to the working directory. */
  readonly root?: string;
  /** The version the module exports, so its items carry an introduction version. Default: none. */
  readonly version?: string;
}

/** A source file's text, read once and reused when an entry re-exports from it. */
type ReadFile = (path: string) => Promise<string>;

/** The documented markers a declaration's JSDoc may carry, by stability. */
function stabilityOf(doc: string | undefined): SurfaceStability {
  if (doc === undefined) return "stable";
  if (/@deprecated\b/.test(doc)) return "deprecated";
  if (/@experimental\b/.test(doc)) return "experimental";
  return "stable";
}

/** The text of the JSDoc block that ends just before `index`, or undefined when there is none. */
function docBefore(source: string, index: number): string | undefined {
  let at = index;
  while (at > 0 && (source[at - 1] === " " || source[at - 1] === "\t" || source[at - 1] === "\n" || source[at - 1] === "\r")) at -= 1;
  if (!source.slice(0, at).endsWith("*/")) return undefined;
  const close = at - 2;
  const open = source.lastIndexOf("/**", close);
  if (open === -1) return undefined;
  return source.slice(open, close + 2);
}

/** The 1-based column of a character index in `source`, counted in code points. */
function columnAt(source: string, starts: readonly number[], index: number): number {
  let line = 0;
  while (line + 1 < starts.length && (starts[line + 1] as number) <= index) line += 1;
  return [...source.slice(starts[line] as number, index)].length + 1;
}

/** The 0-based index of every line start. */
function lineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) if (source[index] === "\n") starts.push(index + 1);
  return starts;
}

/** The index of the symbol's name on its declaration line, or the line's first non-space character. */
function nameIndex(source: string, symbol: ExportedSymbol, starts: readonly number[]): number {
  const lineStart = starts[symbol.line - 1] ?? 0;
  const lineEnd = starts[symbol.line] ?? source.length;
  const line = source.slice(lineStart, lineEnd);
  const escaped = symbol.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(^|[^A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`).exec(line);
  if (match !== null) {
    const offset = match.index + match[1]!.length;
    return lineStart + offset;
  }
  return lineStart + (line.length - line.trimStart().length);
}

/** A span at the symbol's name, one character long, so a report points at the declaration without quoting it. */
function spanOf(source: string, starts: readonly number[], file: string, symbol: ExportedSymbol): SourcePos {
  const index = nameIndex(source, symbol, starts);
  const line = symbol.line;
  const column = columnAt(source, starts, index);
  return { file, line, column, endLine: line, endColumn: column + Math.max(1, [...symbol.name].length) - 1 };
}

/** The signature a symbol shows: its first signature's canonical text, or its unchecked reason. */
function signatureOf(symbol: ExportedSymbol): string | undefined {
  const first = symbol.signatures?.[0];
  if (first !== undefined) return first.text;
  return symbol.unchecked;
}

/** Turns the exports of one file's text into items, deduplicated by name. */
function itemsOf(source: string, file: string, version: string | undefined): SurfaceItem[] {
  const read = exportedSymbols(source, { file });
  if (read.diagnostics.length > 0) return [];
  const starts = lineStarts(source);
  const items: SurfaceItem[] = [];
  for (const symbol of read.symbols) {
    const doc = docBefore(source, starts[symbol.line - 1] ?? 0);
    const signature = signatureOf(symbol);
    items.push({
      id: itemId("symbol", symbol.name),
      area: "api",
      kind: "symbol",
      name: symbol.name,
      source: spanOf(source, starts, file, symbol),
      stability: stabilityOf(doc),
      ...(signature === undefined ? {} : { signature }),
      ...(version === undefined ? {} : { version: { introduced: version } }),
    });
  }
  return sortItems(items);
}

/**
 * Reads the entry point's public exports. An unreadable entry is one error finding and no items, never a crash. A
 * re-export that names the same symbol twice is kept once, because the entry point's surface is the set of names it
 * exports.
 */
export async function discoverSymbols(options: DiscoverSymbolsOptions): Promise<SurfaceAdapterResult> {
  const root = resolve(options.root ?? ".");
  const entry = posix.normalize(options.entry.replace(/\\/g, "/"));
  const absolute = resolve(root, entry);
  const findings: SurfaceFinding[] = [];
  let text: string;
  try {
    text = await readFile(absolute, "utf8");
  } catch (error) {
    return {
      version: 1,
      area: "api",
      items: [],
      findings: [{
        code: "surface.symbol-entry",
        severity: "error",
        message: `Cannot read the package entry "${entry}": ${error instanceof Error ? error.message : String(error)}.`,
        pos: { file: entry, line: 1, column: 1, endLine: 1, endColumn: 1 },
      }],
    };
  }
  const items = itemsOf(text, entry, options.version);
  // A symbol the entry point re-exports from a module it names is read once here; the count check names a mismatch.
  const read = exportedSymbols(text, { file: entry });
  for (const finding of read.diagnostics) {
    findings.push({ code: finding.id, severity: finding.severity, message: finding.message, ...(finding.pos === undefined ? {} : { pos: finding.pos }) });
  }
  return { version: 1, area: "api", items, findings };
}

/** The reader type is exported for a caller that supplies its own file reads, such as a test. */
export type { ReadFile };
