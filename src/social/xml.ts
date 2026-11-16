/**
 * A small reader for the SVG a social template is written in. It is not a general XML parser: it finds elements,
 * their attributes, and where each one sits in the text, which is all the template checks and the slot filling need.
 * It never fetches or expands anything, so a template cannot make it reach outside the file.
 */

/** One attribute of an element: its decoded value and where the value sits between the quotes. */
export interface XmlAttribute {
  readonly name: string;
  /** The value with the five predefined entities and numeric references decoded. */
  readonly value: string;
  /** Offset of the first character of the raw value. */
  readonly valueStart: number;
  /** Offset just past the last character of the raw value. */
  readonly valueEnd: number;
}

/** One element, with offsets into the source text. */
export interface XmlElement {
  /** The tag name as written, such as `text` or `svg:text`. */
  readonly name: string;
  readonly attributes: readonly XmlAttribute[];
  /** Offset of the `<` that opens the element. */
  readonly start: number;
  /** Offset just past the element's closing `>`, children included. */
  end: number;
  /** True for `<name ... />`. */
  readonly selfClosing: boolean;
  /** Number of elements this one sits inside. */
  readonly depth: number;
}

/** What {@link readXml} found. */
export interface XmlDocument {
  /** Elements in document order. */
  readonly elements: readonly XmlElement[];
  /** Why the text is not well-formed enough to read, or other markup that a template may not use. Empty when clean. */
  readonly problems: readonly string[];
}

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Decodes the predefined entities and numeric character references; anything else is left as written. */
export function decodeXml(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x")) return safeCodePoint(Number.parseInt(body.slice(2), 16)) ?? whole;
    if (body.startsWith("#")) return safeCodePoint(Number.parseInt(body.slice(1), 10)) ?? whole;
    return ENTITIES[body] ?? whole;
  });
}

function safeCodePoint(value: number): string | undefined {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)
    ? String.fromCodePoint(value)
    : undefined;
}

/** Escapes text for use inside an element or a double-quoted attribute. */
export function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const NAME = /[^\s/>=]+/y;
const SPACE = /\s*/y;

/** Reads `source` into its elements. Text between tags, comments, and processing instructions are skipped. */
export function readXml(source: string): XmlDocument {
  const elements: XmlElement[] = [];
  const problems: string[] = [];
  const open: XmlElement[] = [];
  let pos = 0;

  while (pos < source.length) {
    const lt = source.indexOf("<", pos);
    if (lt === -1) break;
    if (source.startsWith("<!--", lt)) {
      const end = source.indexOf("-->", lt + 4);
      if (end === -1) {
        problems.push("a comment is never closed");
        break;
      }
      pos = end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", lt)) {
      const end = source.indexOf("]]>", lt);
      if (end === -1) {
        problems.push("a CDATA section is never closed");
        break;
      }
      pos = end + 3;
      continue;
    }
    if (source.startsWith("<?", lt)) {
      const end = source.indexOf("?>", lt);
      if (end === -1) {
        problems.push("a processing instruction is never closed");
        break;
      }
      pos = end + 2;
      continue;
    }
    if (source.startsWith("<!", lt)) {
      problems.push("a DOCTYPE or ENTITY declaration is not allowed");
      const end = source.indexOf(">", lt);
      if (end === -1) break;
      pos = end + 1;
      continue;
    }
    if (source[lt + 1] === "/") {
      const end = source.indexOf(">", lt);
      if (end === -1) {
        problems.push("a closing tag is never finished");
        break;
      }
      const name = source.slice(lt + 2, end).trim();
      const top = open.pop();
      if (top === undefined || top.name !== name) {
        problems.push(`the closing tag </${name}> does not match an open element`);
        break;
      }
      top.end = end + 1;
      pos = end + 1;
      continue;
    }

    // An opening tag: name, attributes, then `>` or `/>`.
    NAME.lastIndex = lt + 1;
    const nameMatch = NAME.exec(source);
    if (nameMatch === null) {
      problems.push("a `<` does not start a tag");
      break;
    }
    const name = nameMatch[0];
    let cursor = lt + 1 + name.length;
    const attributes: XmlAttribute[] = [];
    let selfClosing = false;
    let finished = false;
    while (cursor < source.length) {
      SPACE.lastIndex = cursor;
      cursor += SPACE.exec(source)![0].length;
      const ch = source[cursor];
      if (ch === ">") {
        cursor += 1;
        finished = true;
        break;
      }
      if (ch === "/" && source[cursor + 1] === ">") {
        cursor += 2;
        selfClosing = true;
        finished = true;
        break;
      }
      NAME.lastIndex = cursor;
      const attr = NAME.exec(source);
      if (attr === null) break;
      cursor += attr[0].length;
      SPACE.lastIndex = cursor;
      cursor += SPACE.exec(source)![0].length;
      if (source[cursor] !== "=") break;
      cursor += 1;
      SPACE.lastIndex = cursor;
      cursor += SPACE.exec(source)![0].length;
      const quote = source[cursor];
      if (quote !== '"' && quote !== "'") break;
      const close = source.indexOf(quote, cursor + 1);
      if (close === -1) break;
      attributes.push({
        name: attr[0],
        value: decodeXml(source.slice(cursor + 1, close)),
        valueStart: cursor + 1,
        valueEnd: close,
      });
      cursor = close + 1;
    }
    if (!finished) {
      problems.push(`the tag <${name}> is not well-formed`);
      break;
    }
    const element: XmlElement = { name, attributes, start: lt, end: cursor, selfClosing, depth: open.length };
    elements.push(element);
    if (!selfClosing) open.push(element);
    pos = cursor;
  }

  if (problems.length === 0 && open.length > 0) problems.push(`the element <${open[open.length - 1]!.name}> is never closed`);
  if (problems.length === 0 && elements.length === 0) problems.push("there is no SVG element");
  return { elements, problems };
}

/** The value of attribute `name` on `element`, or `undefined`. */
export function attribute(element: XmlElement, name: string): string | undefined {
  return element.attributes.find((attr) => attr.name === name)?.value;
}
