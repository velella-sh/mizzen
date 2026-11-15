/**
 * RFC 4180 CSV for collections: a required header row, quoted fields, doubled quotes, a BOM, and CRLF or LF line
 * endings. Every row keeps the span it occupies and every cell its own span, so a diagnostic or a record page can
 * point at the exact cell that needs a change.
 *
 * The parser never throws on content: a bad row is one diagnostic and is left out, while the sound rows before and
 * after it still load. A missing or duplicate header, an unclosed quote, and a row whose cell count differs from the
 * header are reported with their position.
 */
import type { Diagnostic, RecordPos } from "../contracts/index.ts";
import { lineIndex, sourcePosOf, spanOf, type LineIndex } from "./positions.ts";

/** One parsed row: the header's fields to their string values, and where the row and each cell sit. */
export interface CsvRow {
  /** Cell values keyed by the header, in header order. */
  readonly fields: Readonly<Record<string, string>>;
  /** The row from its first cell to its last. */
  readonly position: RecordPos;
  /** Where each cell's value sits, keyed by the header. */
  readonly fieldPositions: Readonly<Record<string, RecordPos>>;
}

/** What {@link parseCsv} read. */
export interface CsvResult {
  /** The header cells, in source order; empty when the file has no header. */
  readonly header: readonly string[];
  /** Sound rows, in source order. */
  readonly rows: readonly CsvRow[];
  /** Header and row problems, each with its exact position. */
  readonly diagnostics: readonly Diagnostic[];
}

/** One cell before it is matched to a header. */
interface Cell {
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

/** One parsed row before it is matched to a header. */
interface RawRow {
  readonly cells: readonly Cell[];
  /** True when the row's last quote never closed; such a row is not sound. */
  readonly unclosed: boolean;
}

/** Appends `text` to `out` without a trailing line break, keeping an empty final line out of the rows. */
function splitRows(text: string): { readonly rows: readonly RawRow[]; readonly unclosedQuote?: number } {
  const rows: RawRow[] = [];
  let cells: Cell[] = [];
  let value = "";
  let start = 0;
  let unclosedQuote: number | undefined;
  let inQuotes = false;
  let fieldStart = 0;
  let i = 0;

  const endCell = (end: number): void => {
    cells.push({ value, start, end: end < start ? Math.max(0, start - 1) : end });
    value = "";
  };

  const endRow = (end: number): void => {
    if (cells.length > 0 || value !== "") {
      endCell(end);
      rows.push({ cells, unclosed: false });
    }
    cells = [];
    start = i + 1;
  };

  while (i < text.length) {
    const char = text[i]!;
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          value += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      value += char;
      i += 1;
      continue;
    }

    if (char === '"' && value === "") {
      inQuotes = true;
      if (fieldStart === start) start = i;
      i += 1;
      continue;
    }
    if (char === ",") {
      endCell(i - 1);
      fieldStart = i + 1;
      start = fieldStart;
      i += 1;
      continue;
    }
    if (char === "\r" && text[i + 1] === "\n") {
      endRow(i - 1);
      fieldStart = i + 2;
      start = fieldStart;
      i += 2;
      continue;
    }
    if (char === "\n" || char === "\r") {
      endRow(i - 1);
      fieldStart = i + 1;
      start = fieldStart;
      i += 1;
      continue;
    }
    if (value === "" && fieldStart === start) start = i;
    value += char;
    i += 1;
  }

  if (inQuotes) unclosedQuote = start;

  if (cells.length > 0 || value !== "") {
    endCell(i === 0 ? 0 : i - 1);
    rows.push({ cells, unclosed: unclosedQuote !== undefined });
  } else if (unclosedQuote !== undefined) {
    rows.push({ cells: [], unclosed: true });
  }

  return unclosedQuote === undefined ? { rows } : { rows, unclosedQuote };
}

/** The span of a raw row, from its first cell to its last. */
function rowSpan(index: LineIndex, file: string, row: RawRow): RecordPos {
  const first = row.cells[0];
  const last = row.cells[row.cells.length - 1];
  if (first === undefined || last === undefined) return spanOf(index, file, 0, 0);
  return spanOf(index, file, first.start, last.end + 1);
}

/**
 * Parses CSV text. `file` is the path diagnostics and positions name, relative to the site root.
 */
export function parseCsv(text: string, file: string): CsvResult {
  const source = text.startsWith("﻿") ? text.slice(1) : text;
  const index = lineIndex(source);
  const diagnostics: Diagnostic[] = [];
  const parsed = splitRows(source);

  if (parsed.unclosedQuote !== undefined) {
    diagnostics.push({
      id: "data.csv-unclosed-quote",
      severity: "error",
      message: `A quoted cell in ${file} is never closed.`,
      pos: sourcePosOf(spanOf(index, file, parsed.unclosedQuote, parsed.unclosedQuote + 1)),
      help: "Add the closing quote, or double an inner quote as two quotes.",
    });
  }

  const rows = parsed.rows.filter((row) => !row.unclosed);
  const headerRow = rows.shift();
  if (headerRow === undefined || headerRow.cells.length === 0) {
    diagnostics.push({
      id: "data.csv-missing-header",
      severity: "error",
      message: `CSV collection ${file} has no header row.`,
      pos: sourcePosOf(spanOf(index, file, 0, 0)),
      help: "Put the field names on the first line, separated by commas.",
    });
    return { header: [], rows: [], diagnostics };
  }

  const header: string[] = [];
  const columns: number[] = [];
  for (let cell = 0; cell < headerRow.cells.length; cell++) {
    const value = headerRow.cells[cell]!.value;
    const at = spanOf(index, file, headerRow.cells[cell]!.start, headerRow.cells[cell]!.end + 1);
    if (header.includes(value)) {
      diagnostics.push({
        id: "data.csv-duplicate-header",
        severity: "error",
        message: `CSV collection ${file} names the column "${value}" twice.`,
        pos: sourcePosOf(at),
        help: "Rename one of the two columns, then read the record again.",
      });
      continue;
    }
    header.push(value);
    columns.push(cell);
  }
  if (header.includes("")) {
    diagnostics.push({
      id: "data.csv-empty-header",
      severity: "error",
      message: `CSV collection ${file} has a header cell with no name.`,
      pos: sourcePosOf(spanOf(index, file, headerRow.cells[0]!.start, headerRow.cells[0]!.end + 1)),
      help: "Name every column, or remove the empty one.",
    });
  }

  const records: CsvRow[] = [];
  for (const row of rows) {
    if (row.cells.length !== headerRow.cells.length) {
      diagnostics.push({
        id: "data.csv-row-length",
        severity: "error",
        message: `A row in ${file} has ${row.cells.length} cells; the header has ${headerRow.cells.length}.`,
        pos: sourcePosOf(rowSpan(index, file, row)),
        help: "Add or remove cells so the row matches the header; a cell may be empty.",
      });
      continue;
    }
    const fields: Record<string, string> = {};
    const fieldPositions: Record<string, RecordPos> = {};
    for (let column = 0; column < columns.length; column++) {
      const cell = row.cells[columns[column]!]!;
      fields[header[column]!] = cell.value;
      fieldPositions[header[column]!] = spanOf(index, file, cell.start, cell.end + 1);
    }
    records.push({ fields, position: rowSpan(index, file, row), fieldPositions });
  }

  return { header, rows: records, diagnostics };
}
