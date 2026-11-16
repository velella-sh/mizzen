/**
 * Renders a filled social template to a PNG with `@resvg/resvg-wasm`, as `docs/adr/social-images.md` decided. The
 * renderer is a WebAssembly file, so every operating system runs the same code, and it is given only the fonts the site
 * declared: it has no way to look at the machine's fonts. The PNG that comes out holds the picture and nothing else.
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { LoadedFont } from "./fonts.ts";
import { fitText, type Measure } from "./text.ts";
import { escapeXml } from "./xml.ts";
import { SOCIAL_HEIGHT, SOCIAL_WIDTH, type SlotSpec, type SocialTemplate } from "./template.ts";

type ResvgModule = typeof import("@resvg/resvg-wasm");

let loading: Promise<ResvgModule> | undefined;

/** Loads the renderer once per thread. */
function resvg(): Promise<ResvgModule> {
  loading ??= (async () => {
    const mod = await import("@resvg/resvg-wasm");
    const wasm = createRequire(import.meta.url).resolve("@resvg/resvg-wasm/index_bg.wasm");
    await mod.initWasm(await readFile(wasm));
    return mod;
  })();
  return loading;
}

/** What one slot drew, for a caller that reports on it. */
export interface SlotOutcome {
  /** The slot's field. */
  readonly field: string;
  /** True when the text was cut with an ellipsis. */
  readonly truncated: boolean;
}

/** What the renderer needs of a font: its bytes and its family name. A worker thread gets just these. */
export type RenderFont = Pick<LoadedFont, "bytes" | "family">;

/** A renderer bound to one list of fonts. */
export class SocialRenderer {
  readonly #mod: ResvgModule;
  readonly #fonts: readonly RenderFont[];
  readonly #family: string;
  readonly #widths = new Map<string, number>();

  private constructor(mod: ResvgModule, fonts: readonly RenderFont[]) {
    this.#mod = mod;
    this.#fonts = fonts;
    this.#family = fonts.find((font) => font.family !== "")?.family ?? "";
  }

  /** Loads the renderer and binds it to `fonts`. */
  static async create(fonts: readonly RenderFont[]): Promise<SocialRenderer> {
    return new SocialRenderer(await resvg(), fonts);
  }

  #options(): ConstructorParameters<ResvgModule["Resvg"]>[1] {
    return {
      font: {
        fontBuffers: this.#fonts.map((font) => font.bytes),
        defaultFontFamily: this.#family,
        defaultFontSize: 16,
      },
    };
  }

  /** The width of `text` at `size` in the given font family list, shaped by the renderer itself. */
  measure(text: string, size: number, family: string | undefined): number {
    const key = `${family ?? ""}\u0000${text}`;
    let at100 = this.#widths.get(key);
    if (at100 === undefined) {
      const attribute = family === undefined ? "" : ` font-family="${escapeXml(family)}"`;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="400"><text x="0" y="250" font-size="100"${attribute}>${escapeXml(text)}</text></svg>`;
      const tree = new this.#mod.Resvg(svg, this.#options());
      const box = tree.getBBox();
      // The ink width plus the space on both sides: a slot's box is for the advance, which is a little wider.
      at100 = box === undefined ? text.length * 60 : box.width + 2 * Math.max(0, box.x);
      box?.free();
      tree.free();
      this.#widths.set(key, at100);
    }
    return (at100 * size) / 100;
  }

  /** The measuring function for one slot. */
  measurer(family: string | undefined): Measure {
    return (text, size) => this.measure(text, size, family);
  }

  /** Renders `svg` to PNG bytes, metadata stripped. */
  render(svg: string): Uint8Array {
    const tree = new this.#mod.Resvg(svg, this.#options());
    const image = tree.render();
    const png = image.asPng();
    image.free();
    tree.free();
    return stripPng(png);
  }
}

/** Rounds a coordinate so float noise never reaches the file. */
function num(value: number): string {
  return String(Number(value.toFixed(3)));
}

/** The text elements that draw one slot's lines. */
function drawSlot(slot: SlotSpec, text: string, renderer: SocialRenderer, outcomes: SlotOutcome[]): string {
  const fit = fitText({
    text,
    width: slot.width,
    maxSize: slot.maxSize,
    minSize: slot.minSize,
    maxLines: slot.maxLines,
    measure: renderer.measurer(slot.fontFamily),
  });
  outcomes.push({ field: slot.field, truncated: fit.truncated });
  const anchor =
    slot.align === "center"
      ? { x: slot.x + slot.width / 2, anchor: "middle" }
      : (slot.align === "start") === !fit.rtl
        ? { x: slot.x, anchor: "start" }
        : { x: slot.x + slot.width, anchor: "end" };
  const copied = slot.attributes.map(([name, value]) => ` ${name}="${escapeXml(value)}"`).join("");
  return fit.lines
    .map((line, index) => {
      const y = slot.y + index * fit.size * slot.lineHeight;
      const direction = fit.rtl ? ' direction="rtl"' : "";
      return `<text${copied} font-size="${num(fit.size)}"${direction} text-anchor="${anchor.anchor}" x="${num(anchor.x)}" y="${num(y)}">${escapeXml(line)}</text>`;
    })
    .join("");
}

/**
 * Fills a template's slots with values and returns the finished SVG. A slot whose field has no value is left out.
 *
 * @param values The text of each field by name.
 */
export function fillTemplate(
  template: SocialTemplate,
  values: Readonly<Record<string, string>>,
  renderer: SocialRenderer,
): { readonly svg: string; readonly outcomes: readonly SlotOutcome[] } {
  const outcomes: SlotOutcome[] = [];
  const drawn = template.slots.map((slot) => drawSlot(slot, values[slot.field] ?? "", renderer, outcomes));
  let svg = template.svg;
  for (let index = template.slots.length - 1; index >= 0; index--) {
    const slot = template.slots[index]!;
    svg = svg.slice(0, slot.start) + drawn[index]! + svg.slice(slot.end);
  }
  return { svg, outcomes };
}

/** Renders a template with values to PNG bytes. */
export function renderTemplate(
  template: SocialTemplate,
  values: Readonly<Record<string, string>>,
  renderer: SocialRenderer,
): { readonly png: Uint8Array; readonly outcomes: readonly SlotOutcome[] } {
  const { svg, outcomes } = fillTemplate(template, values, renderer);
  return { png: renderer.render(svg), outcomes };
}

/** The size every image has. */
export const IMAGE_SIZE = { width: SOCIAL_WIDTH, height: SOCIAL_HEIGHT } as const;

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const KEPT_CHUNKS = new Set(["IHDR", "PLTE", "tRNS", "IDAT", "IEND"]);

/**
 * Keeps the chunks a picture needs and drops the rest: no time stamp, no text, no software tag, no color profile. The
 * compressed image data is left as the encoder wrote it.
 */
export function stripPng(png: Uint8Array): Uint8Array {
  const file = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  if (!file.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG file");
  const parts: Buffer[] = [SIGNATURE];
  let at = 8;
  while (at + 12 <= file.length) {
    const length = file.readUInt32BE(at);
    const type = file.toString("latin1", at + 4, at + 8);
    if (KEPT_CHUNKS.has(type)) parts.push(file.subarray(at, at + 12 + length));
    at += 12 + length;
  }
  return new Uint8Array(Buffer.concat(parts));
}
