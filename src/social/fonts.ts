/**
 * The fonts social images are drawn with. A site declares font files in `social.fonts`; nothing else is ever used, so a
 * machine's installed fonts cannot change an image. A file is read as `.ttf`, `.otf`, or `.woff` (a `.woff` is unwrapped
 * to a plain font in memory). Each font's character map is read so a slot whose text has a character no declared font
 * draws can be reported before it is drawn as a blank.
 */
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { inflateSync } from "node:zlib";
import type { Diagnostic } from "../contracts/index.ts";

/** One declared font, ready to hand to the renderer. */
export interface LoadedFont {
  /** The path as the config wrote it. */
  readonly path: string;
  /** The font as a plain `sfnt` file. */
  readonly bytes: Uint8Array;
  /** A hash of the file as it is on disk. */
  readonly hash: string;
  /** The font's family name, or `""` when it names none. */
  readonly family: string;
  /** True when the font draws `codePoint`. */
  covers(codePoint: number): boolean;
}

/** The declared fonts of a site. */
export interface FontSet {
  /** The fonts that loaded, in declared order. */
  readonly fonts: readonly LoadedFont[];
  /** One hash of every declared font file and its path, for the cache key. */
  readonly key: string;
  /** What went wrong with a font file; the fonts that loaded are still in {@link FontSet.fonts}. */
  readonly diagnostics: readonly Diagnostic[];
}

/** Code points that join, direct, or space text and need no glyph of their own. */
function needsNoGlyph(codePoint: number): boolean {
  return (
    codePoint <= 0x20 ||
    (codePoint >= 0x7f && codePoint <= 0xa0) ||
    codePoint === 0x200b ||
    codePoint === 0x200c ||
    codePoint === 0x200d ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069) ||
    codePoint === 0xfeff
  );
}

/** Unwraps a WOFF 1 file to the plain `sfnt` font it holds. */
function unwrapWoff(file: Buffer): Buffer {
  const count = file.readUInt16BE(12);
  const flavor = file.readUInt32BE(4);
  const header = Buffer.alloc(12 + 16 * count);
  header.writeUInt32BE(flavor, 0);
  header.writeUInt16BE(count, 4);
  let power = 1;
  let log = 0;
  while (power * 2 <= count) {
    power *= 2;
    log += 1;
  }
  header.writeUInt16BE(power * 16, 6);
  header.writeUInt16BE(log, 8);
  header.writeUInt16BE(count * 16 - power * 16, 10);
  const parts: Buffer[] = [header];
  let offset = header.length;
  for (let index = 0; index < count; index++) {
    const entry = 44 + index * 20;
    const start = file.readUInt32BE(entry + 4);
    const compressed = file.readUInt32BE(entry + 8);
    const length = file.readUInt32BE(entry + 12);
    let table = file.subarray(start, start + compressed);
    if (compressed < length) table = inflateSync(table);
    if (table.length !== length) throw new Error("a table has the wrong length");
    const slot = 12 + index * 16;
    file.copy(header, slot, entry, entry + 4);
    header.writeUInt32BE(file.readUInt32BE(entry + 16), slot + 4);
    header.writeUInt32BE(offset, slot + 8);
    header.writeUInt32BE(length, slot + 12);
    const padding = (4 - (length % 4)) % 4;
    parts.push(table, Buffer.alloc(padding));
    offset += length + padding;
  }
  return Buffer.concat(parts);
}

interface Table {
  readonly offset: number;
  readonly length: number;
}

function tables(font: Buffer): Map<string, Table> {
  const out = new Map<string, Table>();
  const count = font.readUInt16BE(4);
  for (let index = 0; index < count; index++) {
    const entry = 12 + index * 16;
    out.set(font.toString("latin1", entry, entry + 4), { offset: font.readUInt32BE(entry + 8), length: font.readUInt32BE(entry + 12) });
  }
  return out;
}

/** The code point ranges, merged and sorted, that the font's best Unicode map covers. */
function coverage(font: Buffer, cmap: Table): readonly (readonly [number, number])[] {
  const base = cmap.offset;
  const count = font.readUInt16BE(base + 2);
  let best: { offset: number; rank: number } | undefined;
  for (let index = 0; index < count; index++) {
    const record = base + 4 + index * 8;
    const platform = font.readUInt16BE(record);
    const encoding = font.readUInt16BE(record + 2);
    const offset = base + font.readUInt32BE(record + 4);
    const format = font.readUInt16BE(offset);
    let rank = 0;
    if (platform === 3 && encoding === 10 && format === 12) rank = 4;
    else if (platform === 0 && format === 12) rank = 3;
    else if (platform === 3 && encoding === 1 && format === 4) rank = 2;
    else if (platform === 0 && format === 4) rank = 1;
    if (rank > (best?.rank ?? 0)) best = { offset, rank };
  }
  if (best === undefined) return [];
  const ranges: [number, number][] = [];
  const at = best.offset;
  if (font.readUInt16BE(at) === 12) {
    const groups = font.readUInt32BE(at + 12);
    for (let index = 0; index < groups; index++) {
      const group = at + 16 + index * 12;
      ranges.push([font.readUInt32BE(group), font.readUInt32BE(group + 4)]);
    }
  } else {
    const segments = font.readUInt16BE(at + 6) / 2;
    const ends = at + 14;
    const starts = ends + segments * 2 + 2;
    const deltas = starts + segments * 2;
    const offsets = deltas + segments * 2;
    for (let segment = 0; segment < segments; segment++) {
      const end = font.readUInt16BE(ends + segment * 2);
      const start = font.readUInt16BE(starts + segment * 2);
      const rangeOffset = font.readUInt16BE(offsets + segment * 2);
      if (start === 0xffff) continue;
      if (rangeOffset === 0) {
        ranges.push([start, end]);
        continue;
      }
      // Glyph ids come from an array: a code point whose entry is 0 has no glyph.
      for (let code = start; code <= end; code++) {
        const glyph = offsets + segment * 2 + rangeOffset + (code - start) * 2;
        if (glyph + 2 <= font.length && font.readUInt16BE(glyph) !== 0) ranges.push([code, code]);
      }
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

/** The family name from the `name` table: the typographic family when there is one, else the family. */
function familyName(font: Buffer, name: Table | undefined): string {
  if (name === undefined) return "";
  const base = name.offset;
  const count = font.readUInt16BE(base + 2);
  const storage = base + font.readUInt16BE(base + 4);
  let found: { id: number; text: string } | undefined;
  for (let index = 0; index < count; index++) {
    const record = base + 6 + index * 12;
    const platform = font.readUInt16BE(record);
    const id = font.readUInt16BE(record + 6);
    if (id !== 1 && id !== 16) continue;
    const length = font.readUInt16BE(record + 8);
    const start = storage + font.readUInt16BE(record + 10);
    let text: string;
    if (platform === 3 || platform === 0) {
      const raw = Buffer.from(font.subarray(start, start + length));
      text = raw.swap16().toString("utf16le");
    } else if (platform === 1) text = font.toString("latin1", start, start + length);
    else continue;
    if (found === undefined || (id === 16 && found.id !== 16)) found = { id, text };
  }
  return found?.text ?? "";
}

function covers(ranges: readonly (readonly [number, number])[], codePoint: number): boolean {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const [start, end] = ranges[mid]!;
    if (codePoint < start) high = mid - 1;
    else if (codePoint > end) low = mid + 1;
    else return true;
  }
  return false;
}

function fail(path: string, id: string, message: string, help: string): Diagnostic {
  return { id, severity: "error", message: `The social image font "${path}" ${message}`, help };
}

/**
 * Reads every font the site declares. A file that is missing, outside the site, or not a usable font is reported and
 * left out; the others still load. Nothing is looked up by name on the machine.
 *
 * @param root Absolute site root; a font path is relative to it and may not leave it.
 * @param declared The `social.fonts` list.
 */
export async function loadFonts(root: string, declared: readonly string[]): Promise<FontSet> {
  const fonts: LoadedFont[] = [];
  const diagnostics: Diagnostic[] = [];
  const key = createHash("sha256");
  for (const path of declared) {
    key.update(`${path}\0`);
    const target = resolve(root, path);
    const inside = relative(root, target);
    if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
      diagnostics.push(fail(path, "social.font-outside", "is outside the site root.", "Declare a font file inside the site."));
      continue;
    }
    let real: string;
    let file: Buffer;
    try {
      real = await realpath(target);
      const realRoot = await realpath(root);
      const realInside = relative(realRoot, real);
      if (realInside === ".." || realInside.startsWith(`..${sep}`) || isAbsolute(realInside)) {
        diagnostics.push(fail(path, "social.font-outside", "resolves to a file outside the site root.", "Declare a font file inside the site."));
        continue;
      }
      file = await readFile(real);
    } catch {
      diagnostics.push(fail(path, "social.font-missing", "could not be read.", "Fix the path in `social.fonts`, or remove it. No system font is used instead."));
      continue;
    }
    key.update(createHash("sha256").update(file).digest());
    const hash = createHash("sha256").update(file).digest("hex");
    const signature = file.length >= 4 ? file.toString("latin1", 0, 4) : "";
    let sfnt: Buffer;
    try {
      if (signature === "wOF2") {
        diagnostics.push(fail(path, "social.font-format", "is a WOFF2 file, which images cannot draw.", "Use a `.ttf`, `.otf`, or `.woff` file of the same font."));
        continue;
      }
      if (signature === "wOFF") sfnt = unwrapWoff(file);
      else if (signature === "\u0000\u0001\u0000\u0000" || signature === "OTTO" || signature === "true") sfnt = file;
      else {
        diagnostics.push(fail(path, "social.font-format", "is not a TrueType, OpenType, or WOFF font.", "Use a `.ttf`, `.otf`, or `.woff` file."));
        continue;
      }
      const table = tables(sfnt);
      const cmap = table.get("cmap");
      if (cmap === undefined) throw new Error("it has no character map");
      const ranges = coverage(sfnt, cmap);
      fonts.push({
        path,
        bytes: new Uint8Array(sfnt),
        hash,
        family: familyName(sfnt, table.get("name")),
        covers: (codePoint) => covers(ranges, codePoint),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      diagnostics.push(fail(path, "social.font-format", `could not be read as a font (${reason}).`, "Use an undamaged `.ttf`, `.otf`, or `.woff` file."));
    }
  }
  return { fonts, key: key.digest("hex"), diagnostics };
}

/**
 * The characters of `text` that no font draws, each once, in order of first use. A space, a line break, and the
 * invisible joiners and direction marks need no glyph and are never listed.
 */
export function missingCharacters(fonts: readonly LoadedFont[], text: string): string[] {
  const missing: string[] = [];
  for (const char of text) {
    const codePoint = char.codePointAt(0)!;
    if (needsNoGlyph(codePoint) || missing.includes(char)) continue;
    if (!fonts.some((font) => font.covers(codePoint))) missing.push(char);
  }
  return missing;
}
