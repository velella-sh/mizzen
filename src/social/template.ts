/**
 * Social image templates: an SVG file `_templates/social/<name>.svg` in the source folder, with text slots named by
 * field. A template is a fixed 1200 by 630 picture; a `<text data-slot="title">` element is a slot the page's own field
 * fills. A template that could reach outside the site, run code, or change size is refused, and each reason is reported.
 *
 * Slot attributes: `x` and `y` (the box's left edge and the first line's baseline), `data-width` (the box's width),
 * `font-size` (the largest size), `data-min-size` (the smallest, default the largest), `data-max-lines` (default 1),
 * `data-line-height` (a ratio, default 1.25), and `data-align` (`start`, `center`, or `end`, default `start`, where
 * `start` means the side the text is read from). Every other attribute, such as `fill` or `font-family`, is copied
 * onto the lines drawn. The element's own text is a placeholder and is replaced.
 */
import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import type { Diagnostic, Page, SiteConfig, SourcePos } from "../contracts/index.ts";
import { attribute, readXml, type XmlElement } from "./xml.ts";

/** The width every template must have; it is the size Open Graph readers expect. */
export const SOCIAL_WIDTH = 1200;
/** The height every template must have. */
export const SOCIAL_HEIGHT = 630;

/** Where a template lives under the source folder. */
export const TEMPLATE_FOLDER = "_templates/social";

/** One text slot of a template. */
export interface SlotSpec {
  /** The field that fills it: `title`, `description`, `site`, or any front matter key. */
  readonly field: string;
  /** Left edge of the box. */
  readonly x: number;
  /** Baseline of the first line. */
  readonly y: number;
  /** Width of the box. */
  readonly width: number;
  /** The largest font size. */
  readonly maxSize: number;
  /** The smallest font size. */
  readonly minSize: number;
  /** The most lines. */
  readonly maxLines: number;
  /** Line height as a multiple of the font size. */
  readonly lineHeight: number;
  /** Which side of the box the text sits on. */
  readonly align: "start" | "center" | "end";
  /** Every other attribute of the slot's element, as written in the template, to copy onto each line. */
  readonly attributes: readonly (readonly [string, string])[];
  /** The font family list the slot draws with, from its `font-family`, or `undefined` for the site's first font. */
  readonly fontFamily: string | undefined;
  /** Offset of the slot element in {@link SocialTemplate.svg}. */
  readonly start: number;
  /** Offset just past the slot element. */
  readonly end: number;
}

/** A template that passed every check. */
export interface SocialTemplate {
  /** The name the config or a page gave. */
  readonly name: string;
  /** Path of the file relative to the site root, using `/`. */
  readonly file: string;
  /** The SVG with every referenced image inlined as a data URI, so nothing is read again at render time. */
  readonly svg: string;
  /** The text slots in document order. */
  readonly slots: readonly SlotSpec[];
  /** A hash of {@link SocialTemplate.svg}, for the cache key. */
  readonly hash: string;
}

/** The outcome of reading one template. */
export type TemplateResult =
  | { readonly ok: true; readonly template: SocialTemplate }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

/** The name pattern for a template: no path separator, so a name can only ever name a file in the folder. */
export const TEMPLATE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const FORBIDDEN_ELEMENTS = new Set(["script", "foreignObject", "iframe", "object", "embed", "audio", "video", "animate", "animateTransform", "animateMotion", "set"]);
const IMAGE_TYPES: Readonly<Record<string, string>> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/;
const SLOT_FIELD = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
/** A `url(` that is not a reference to an element in the same file. */
const EXTERNAL_URL = /url\(\s*(?!["']?#)/i;

/** The name of the template a page uses, `undefined` for none, or the reason the name is not usable. */
export function templateNameFor(config: SiteConfig, page: Page): { readonly name: string | undefined; readonly invalid?: string } {
  if (config.social === undefined) return { name: undefined };
  const own = page.frontMatter.social;
  if (own === false) return { name: undefined };
  if (own === undefined) return { name: config.social.template };
  if (typeof own !== "string" || !TEMPLATE_NAME.test(own)) {
    return { name: undefined, invalid: `The \`social\` front matter value ${JSON.stringify(own)} is not a template name.` };
  }
  return { name: own };
}

/** Line and column (1-based) of `offset` in `text`. */
function lineColumn(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let last = -1;
  for (let i = text.indexOf("\n"); i !== -1 && i < offset; i = text.indexOf("\n", i + 1)) {
    line += 1;
    last = i;
  }
  return { line, column: offset - last };
}

function number(element: XmlElement, name: string): number | undefined {
  const raw = attribute(element, name);
  if (raw === undefined || !/^\s*-?\d+(\.\d+)?(px)?\s*$/.test(raw)) return undefined;
  return Number.parseFloat(raw);
}

function whole(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value);
}

/**
 * Reads and checks one template, inlining the images it names.
 *
 * @param root Absolute site root; an image may not resolve outside it.
 * @param sourceDir Absolute source folder that holds `_templates/`.
 * @param name The template's name.
 */
export async function loadTemplate(root: string, sourceDir: string, name: string): Promise<TemplateResult> {
  const path = join(sourceDir, TEMPLATE_FOLDER, `${name}.svg`);
  const file = relative(root, path).split(sep).join("/");
  const at: SourcePos = { file, line: 1, column: 1, endLine: 1, endColumn: 1 };
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch {
    return {
      ok: false,
      diagnostics: [
        {
          id: "social.template-missing",
          severity: "error",
          message: `The social image template "${name}" has no file: ${file} could not be read.`,
          pos: at,
          help: `Add the file under \`${TEMPLATE_FOLDER}/\` in the source folder, or name a template that exists.`,
        },
      ],
    };
  }
  source = source.replace(/\r\n?/g, "\n");
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);

  const diagnostics: Diagnostic[] = [];
  const reject = (offset: number, message: string, help?: string): void => {
    const { line, column } = lineColumn(source, offset);
    diagnostics.push({
      id: "social.template-invalid",
      severity: "error",
      message: `The social image template "${name}" ${message}`,
      pos: { file, line, column, endLine: line, endColumn: column },
      ...(help === undefined ? {} : { help }),
    });
  };

  const doc = readXml(source);
  for (const problem of doc.problems) reject(0, `cannot be read: ${problem}.`);
  if (doc.problems.length > 0) return { ok: false, diagnostics };

  const svg = doc.elements[0]!;
  if (svg.name !== "svg") reject(svg.start, `must start with an <svg> element, not <${svg.name}>.`);
  const width = number(svg, "width");
  const height = number(svg, "height");
  if (width !== SOCIAL_WIDTH || height !== SOCIAL_HEIGHT) {
    reject(svg.start, `must be ${String(SOCIAL_WIDTH)} by ${String(SOCIAL_HEIGHT)}: set width="${String(SOCIAL_WIDTH)}" and height="${String(SOCIAL_HEIGHT)}" on the <svg> element.`);
  }
  const viewBox = attribute(svg, "viewBox");
  if (viewBox !== undefined && viewBox.trim().split(/[\s,]+/).join(" ") !== `0 0 ${String(SOCIAL_WIDTH)} ${String(SOCIAL_HEIGHT)}`) {
    reject(svg.start, `has a viewBox that is not "0 0 ${String(SOCIAL_WIDTH)} ${String(SOCIAL_HEIGHT)}".`);
  }

  const slots: SlotSpec[] = [];
  /** Attribute values to replace with a data URI, as [start, end, text]. */
  const inlined: [number, number, string][] = [];

  for (const element of doc.elements) {
    const local = element.name.includes(":") ? element.name.slice(element.name.indexOf(":") + 1) : element.name;
    if (FORBIDDEN_ELEMENTS.has(local)) {
      reject(element.start, `uses <${local}>, which a template may not contain.`, "Remove it: a template is a still picture with text slots.");
    }
    for (const attr of element.attributes) {
      if (/^on/i.test(attr.name)) reject(element.start, `has the event attribute ${attr.name}, which a template may not contain.`);
      if (attr.name === "style" || attr.name === "fill" || attr.name === "stroke" || attr.name === "filter" || attr.name === "mask" || attr.name === "clip-path") {
        if (EXTERNAL_URL.test(attr.value) || /javascript:/i.test(attr.value)) {
          reject(element.start, `has a ${attr.name} that refers to something outside the file.`);
        }
      }
      if (/^(xlink:)?href$/.test(attr.name) && local !== "image") {
        if (!attr.value.startsWith("#")) reject(element.start, `has ${attr.name}="${attr.value}" on <${local}>; only a link to an element in the same file is allowed.`);
      }
    }
    if (local === "style") {
      const body = source.slice(element.start, element.end);
      if (/@import/i.test(body) || EXTERNAL_URL.test(body)) reject(element.start, "has a <style> that imports or links something outside the file.");
    }
    if (local === "image") {
      const href = attribute(element, "href") ?? attribute(element, "xlink:href");
      const attr = element.attributes.find((a) => a.name === "href" || a.name === "xlink:href");
      if (href === undefined || attr === undefined) {
        reject(element.start, "has an <image> with no href.");
        continue;
      }
      if (href.startsWith("data:")) {
        if (!DATA_IMAGE.test(href)) reject(element.start, "has an <image> whose data URI is not a base64 PNG, JPEG, GIF, or WebP.");
        continue;
      }
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(href) || href.startsWith("//") || href.includes("\\") || isAbsolute(href)) {
        reject(element.start, `has an <image> that points outside the site (${href}).`, "Use a path inside the site, such as images/logo.png, or an inline data URI.");
        continue;
      }
      const type = IMAGE_TYPES[href.slice(href.lastIndexOf(".")).toLowerCase()];
      if (type === undefined) {
        reject(element.start, `has an <image> that is not a PNG, JPEG, GIF, or WebP file (${href}).`);
        continue;
      }
      const target = href.startsWith("/") ? resolve(sourceDir, href.slice(1)) : resolve(dirname(path), href);
      let real: string;
      try {
        real = await realpath(target);
      } catch {
        reject(element.start, `has an <image> whose file does not exist (${href}).`);
        continue;
      }
      let realRoot: string;
      try {
        realRoot = await realpath(root);
      } catch {
        realRoot = root;
      }
      const inside = relative(realRoot, real);
      if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
        reject(element.start, `has an <image> that points outside the site root (${href}).`, "Move the file inside the site, or use an inline data URI.");
        continue;
      }
      const bytes = await readFile(real);
      inlined.push([attr.valueStart, attr.valueEnd, `data:${type};base64,${bytes.toString("base64")}`]);
    }
    if (local === "text" && attribute(element, "data-slot") !== undefined) {
      const field = attribute(element, "data-slot")!;
      const x = number(element, "x");
      const y = number(element, "y");
      const slotWidth = number(element, "data-width");
      const maxSize = number(element, "font-size") ?? 48;
      const minSize = number(element, "data-min-size") ?? maxSize;
      const maxLines = number(element, "data-max-lines") ?? 1;
      const lineHeight = number(element, "data-line-height") ?? 1.25;
      const align = attribute(element, "data-align") ?? "start";
      if (!SLOT_FIELD.test(field)) reject(element.start, `has a slot named "${field}", which is not a field name.`);
      else if (!whole(x) || !whole(y) || !whole(slotWidth) || slotWidth <= 0) {
        reject(element.start, `has the slot "${field}" without numeric x, y, and a positive data-width.`);
      } else if (maxSize <= 0 || minSize <= 0 || minSize > maxSize) {
        reject(element.start, `has the slot "${field}" whose data-min-size is not between 0 and its font-size.`);
      } else if (!Number.isInteger(maxLines) || maxLines < 1 || lineHeight <= 0) {
        reject(element.start, `has the slot "${field}" with a data-max-lines that is not a whole number of at least 1, or a bad data-line-height.`);
      } else if (align !== "start" && align !== "center" && align !== "end") {
        reject(element.start, `has the slot "${field}" with a data-align that is not start, center, or end.`);
      } else {
        slots.push({
          field,
          x,
          y,
          width: slotWidth,
          maxSize,
          minSize,
          maxLines,
          lineHeight,
          align,
          fontFamily: attribute(element, "font-family"),
          attributes: element.attributes
            .filter((a) => !/^(x|y|dy|dx|text-anchor|font-size|direction)$/.test(a.name) && !a.name.startsWith("data-"))
            .map((a) => [a.name, a.value] as const),
          start: element.start,
          end: element.end,
        });
      }
    }
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };

  // Replace image paths with their bytes, last first so earlier offsets stay true. Slot offsets move with them.
  let text = source;
  const shifted = slots.map((slot) => ({ ...slot }));
  for (const [from, to, data] of [...inlined].sort((a, b) => b[0] - a[0])) {
    text = text.slice(0, from) + data + text.slice(to);
    const delta = data.length - (to - from);
    for (const slot of shifted) {
      if (slot.start > from) (slot as { start: number }).start += delta;
      if (slot.end > from) (slot as { end: number }).end += delta;
    }
  }
  return {
    ok: true,
    template: { name, file, svg: text, slots: shifted, hash: createHash("sha256").update(text).digest("hex") },
  };
}
