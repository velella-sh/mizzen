/**
 * A small JSON reader that keeps every value's position, for a surface adapter that must point at the line a key is
 * declared on. It reads the same documents `JSON.parse` does, and it reports a position for each object member's key
 * and each value, so a scanner never guesses a line from a text search that a repeated name would confuse.
 */
import type { SourcePos } from "../contracts/source.ts";

/** One parsed JSON value, with the span of the value and, for an object member, the span of its key. */
export interface JsonNode {
  readonly value: unknown;
  /** The span of the value, from its first character to its last. */
  readonly span: SourcePos;
  /** For an object, each member's value by key. For an array, each item in order. */
  readonly members?: ReadonlyMap<string, JsonNode>;
  readonly items?: readonly JsonNode[];
  /** For an object member, the span of its key, which is where a report points. */
  readonly keySpan?: SourcePos;
}

/** A JSON text that is not well formed, with the position where it stopped. */
export class JsonPositionError extends Error {
  readonly pos: SourcePos;

  constructor(message: string, pos: SourcePos) {
    super(message);
    this.name = "JsonPositionError";
    this.pos = pos;
  }
}

/** Reads `text` into a positioned tree. Throws {@link JsonPositionError} on malformed input. */
export function parseJsonWithPositions(text: string, file: string): JsonNode {
  let index = 0;
  let line = 1;
  let column = 1;

  const point = (): { line: number; column: number } => ({ line, column });
  const pos = (start: { line: number; column: number }, end: { line: number; column: number }): SourcePos => ({
    file,
    line: start.line,
    column: start.column,
    endLine: end.line,
    endColumn: Math.max(start.column === 0 ? 1 : end.column - 1, 1),
  });
  const advance = (): string => {
    const ch = text[index] as string;
    index += 1;
    if (ch === "\n") {
      line += 1;
      column = 1;
    } else column += 1;
    return ch;
  };
  const whitespace = (): void => {
    while (index < text.length && " \t\r\n".includes(text[index] as string)) advance();
  };
  const fail = (message: string): never => {
    throw new JsonPositionError(message, { file, line, column, endLine: line, endColumn: column });
  };
  const string = (): string => {
    if (text[index] !== '"') fail("Expected a string");
    advance();
    let out = "";
    while (index < text.length) {
      const ch = advance();
      if (ch === '"') return out;
      if (ch === "\\") {
        const escape = advance();
        if (escape === "n") out += "\n";
        else if (escape === "t") out += "\t";
        else if (escape === "r") out += "\r";
        else if (escape === "b") out += "\b";
        else if (escape === "f") out += "\f";
        else if (escape === "u") {
          const hex = text.slice(index, index + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("Invalid unicode escape");
          for (let i = 0; i < 4; i += 1) advance();
          out += String.fromCharCode(Number.parseInt(hex, 16));
        } else out += escape;
        continue;
      }
      out += ch;
    }
    return fail("Unterminated string");
  };
  const value = (): JsonNode => {
    whitespace();
    const start = point();
    const ch = text[index];
    if (ch === undefined) return fail("Unexpected end of input");
    if (ch === "{") {
      advance();
      const members = new Map<string, JsonNode>();
      whitespace();
      if (text[index] === "}") {
        advance();
        return { value: {}, span: pos(start, point()), members };
      }
      for (;;) {
        whitespace();
        const keyStart = point();
        const key = string();
        const keySpan = pos(keyStart, point());
        whitespace();
        if (text[index] !== ":") fail("Expected a colon");
        advance();
        const child = value();
        members.set(key, { ...child, keySpan });
        whitespace();
        if (text[index] === ",") {
          advance();
          continue;
        }
        if (text[index] === "}") {
          advance();
          break;
        }
        fail("Expected a comma or a closing brace");
      }
      const plain: Record<string, unknown> = {};
      for (const [key, child] of members) plain[key] = child.value;
      return { value: plain, span: pos(start, point()), members };
    }
    if (ch === "[") {
      advance();
      const items: JsonNode[] = [];
      whitespace();
      if (text[index] === "]") {
        advance();
        return { value: [], span: pos(start, point()), items };
      }
      for (;;) {
        items.push(value());
        whitespace();
        if (text[index] === ",") {
          advance();
          continue;
        }
        if (text[index] === "]") {
          advance();
          break;
        }
        fail("Expected a comma or a closing bracket");
      }
      return { value: items.map((item) => item.value), span: pos(start, point()), items };
    }
    if (ch === '"') {
      const parsed = string();
      return { value: parsed, span: pos(start, point()) };
    }
    if (text.startsWith("true", index)) {
      for (let i = 0; i < 4; i += 1) advance();
      return { value: true, span: pos(start, point()) };
    }
    if (text.startsWith("false", index)) {
      for (let i = 0; i < 5; i += 1) advance();
      return { value: false, span: pos(start, point()) };
    }
    if (text.startsWith("null", index)) {
      for (let i = 0; i < 4; i += 1) advance();
      return { value: null, span: pos(start, point()) };
    }
    const number = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(index));
    if (number === null) return fail("Expected a value");
    for (let i = 0; i < number[0].length; i += 1) advance();
    return { value: Number(number[0]), span: pos(start, point()) };
  };

  const root = value();
  whitespace();
  if (index < text.length) fail("Unexpected trailing content");
  return root;
}

/** The member of an object node by key, or undefined for a non-object or an absent key. */
export function member(node: JsonNode | undefined, key: string): JsonNode | undefined {
  return node?.members?.get(key);
}
