/**
 * Fits a text into a slot: wraps it to the slot's width, shrinks it within the slot's range, and ends it with an
 * ellipsis when it still does not fit. Widths come from a measuring function the caller gives, never from the system,
 * so the same text and the same fonts always give the same lines.
 */

/** Measures `text` at font size `size`, in the units of the slot's width. */
export type Measure = (text: string, size: number) => number;

/** What to fit and where. */
export interface FitInput {
  /** The text to place; any run of white space is one space. */
  readonly text: string;
  /** Width of the slot's box. */
  readonly width: number;
  /** The largest font size, tried first. */
  readonly maxSize: number;
  /** The smallest font size. */
  readonly minSize: number;
  /** The most lines. */
  readonly maxLines: number;
  /** Measures a string at a size. */
  readonly measure: Measure;
}

/** The lines to draw. */
export interface FitResult {
  /** The lines, in reading order. */
  readonly lines: readonly string[];
  /** The font size they fit at. */
  readonly size: number;
  /** True when the text did not fit even at the smallest size and was cut with an ellipsis. */
  readonly truncated: boolean;
  /** True when the text reads right to left. */
  readonly rtl: boolean;
}

const ELLIPSIS = "…";
const STRONG_RTL = /[֐-ࣿיִ-﷿ﹰ-ﻼ]/u;
const STRONG_LTR = /[A-Za-zÀ-ʸͰ-֏ऀ-῿Ⰰ-﬜]/u;

/** True when the first strongly directional character of `text` is right to left, as the Unicode bidi rule decides. */
export function isRtl(text: string): boolean {
  for (const char of text) {
    if (STRONG_RTL.test(char)) return true;
    if (STRONG_LTR.test(char)) return false;
  }
  return false;
}

/** Breaks `word` into pieces that each fit `width`, never between a character and the marks that follow it. */
function breakWord(word: string, width: number, size: number, measure: Measure): string[] {
  const pieces: string[] = [];
  let current = "";
  for (const char of word) {
    const joins = /^[\p{M}‌‍]$/u.test(char);
    if (current !== "" && !joins && measure(current + char, size) > width) {
      pieces.push(current);
      current = char;
    } else current += char;
  }
  if (current !== "") pieces.push(current);
  return pieces;
}

/** Greedy wrap of `words` at `size`; `fits` is false when a single word is wider than the box. */
function wrap(words: readonly string[], width: number, size: number, measure: Measure): { lines: string[]; fits: boolean } {
  const lines: string[] = [];
  let fits = true;
  let line = "";
  for (const word of words) {
    const candidate = line === "" ? word : `${line} ${word}`;
    if (line === "" || measure(candidate, size) <= width) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
    }
    if (line === word && measure(word, size) > width) fits = false;
  }
  if (line !== "") lines.push(line);
  return { lines, fits };
}

/** `line` shortened, with an ellipsis, until it fits `width`. */
function ellipsize(line: string, width: number, size: number, measure: Measure): string {
  const chars = [...line.trimEnd()];
  while (chars.length > 0 && measure(chars.join("") + ELLIPSIS, size) > width) chars.pop();
  while (chars.length > 0 && /^[\p{M}‌‍]$/u.test(chars[chars.length - 1]!)) chars.pop();
  return chars.join("").trimEnd() + ELLIPSIS;
}

/** Fits `input.text` into its slot. An empty text gives no lines. */
export function fitText(input: FitInput): FitResult {
  const text = input.text.replace(/\s+/g, " ").trim();
  const rtl = isRtl(text);
  if (text === "") return { lines: [], size: input.maxSize, truncated: false, rtl };
  const { width, measure, maxLines } = input;
  const words = text.split(" ");

  for (let size = input.maxSize; size >= input.minSize; size -= 1) {
    const { lines, fits } = wrap(words, width, size, measure);
    if (fits && lines.length <= maxLines) return { lines, size, truncated: false, rtl };
  }

  // Nothing fits at any size: wrap at the smallest, cutting an over-wide word into pieces, and end with an ellipsis.
  const size = input.minSize;
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (measure(word, size) > width) {
      if (line !== "") lines.push(line);
      const pieces = breakWord(word, width, size, measure);
      line = pieces.pop() ?? "";
      lines.push(...pieces);
      continue;
    }
    const candidate = line === "" ? word : `${line} ${word}`;
    if (line === "" || measure(candidate, size) <= width) line = candidate;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") lines.push(line);
  if (lines.length <= maxLines) return { lines, size, truncated: false, rtl };
  const kept = lines.slice(0, maxLines);
  const last = kept.length - 1;
  kept[last] = ellipsize(`${kept[last]!} ${lines.slice(maxLines).join(" ")}`, width, size, measure);
  return { lines: kept, size, truncated: true, rtl };
}
