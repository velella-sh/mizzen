/**
 * Reads a VitePress config file as data, never executing it: `skip` hides comments, `valueAt` reads one literal, and
 * `literalObject` reads the exported object. A call, an identifier, or a spread reads as no value, so a config built at
 * runtime leaves the keys this reader cannot see absent.
 */

/** Whitespace and JavaScript comments, which may sit between any two tokens. */
export function skip(text: string, at: number): number {
  let index = at;
  for (;;) {
    while (/\s/.test(text.charAt(index))) index++;
    if (text.startsWith("//", index)) {
      const newline = text.indexOf("\n", index);
      index = newline === -1 ? text.length : newline + 1;
    } else if (text.startsWith("/*", index)) {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 2;
    } else {
      return index;
    }
  }
}

/** A quoted string literal and the offset after it. */
export function quotedAt(text: string, at: number): { readonly value: string; readonly end: number } | undefined {
  const quote = text.charAt(at);
  if (quote !== '"' && quote !== "'" && quote !== "`") return undefined;
  let value = "";
  let index = at + 1;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char === "\\") {
      const next = text.charAt(index + 1);
      value += next === "n" ? "\n" : next === "t" ? "\t" : next === "r" ? "\r" : next;
      index += 2;
      continue;
    }
    if (char === quote) return { value, end: index + 1 };
    if (quote === "`" && char === "$" && text.charAt(index + 1) === "{") return undefined;
    value += char;
    index++;
  }
  return undefined;
}

/** Any literal value; a call or an identifier is skipped and reads as undefined. */
export function valueAt(text: string, at: number): { readonly value: unknown; readonly end: number } | undefined {
  const start = skip(text, at);
  if (text.charAt(start) === "{") return objectAt(text, start);
  if (text.charAt(start) === "[") return arrayAt(text, start);
  const string = quotedAt(text, start);
  if (string !== undefined) return string;
  let index = start;
  let depth = 0;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char === "(" || char === "[" || char === "{") depth++;
    else if (char === ")" || char === "]" || char === "}") {
      if (depth === 0) break;
      depth--;
    } else if (char === "," && depth === 0) break;
    index++;
  }
  return index === start ? undefined : { value: undefined, end: index };
}

/** An object literal's own keys and values; a shorthand property or a spread reads as no value. */
export function objectAt(text: string, at: number): { readonly value: Record<string, unknown>; readonly end: number } | undefined {
  let index = skip(text, at + 1);
  const value: Record<string, unknown> = {};
  while (index < text.length && text.charAt(index) !== "}") {
    let key: string;
    const quoted = quotedAt(text, index);
    if (quoted !== undefined) {
      key = quoted.value;
      index = quoted.end;
    } else {
      const name = /^[A-Za-z_$][\w$]*/.exec(text.slice(index));
      if (name === null) return undefined;
      key = name[0];
      index += key.length;
    }
    index = skip(text, index);
    if (text.charAt(index) !== ":") return undefined;
    const parsed = valueAt(text, index + 1);
    if (parsed === undefined) return undefined;
    value[key] = parsed.value;
    index = skip(text, parsed.end);
    if (text.charAt(index) === ",") index = skip(text, index + 1);
    else if (text.charAt(index) !== "}") return undefined;
  }
  return text.charAt(index) === "}" ? { value, end: index + 1 } : undefined;
}

/** An array literal's values; a hole or spread reads as no value. */
export function arrayAt(text: string, at: number): { readonly value: unknown[]; readonly end: number } | undefined {
  let index = skip(text, at + 1);
  const value: unknown[] = [];
  while (index < text.length && text.charAt(index) !== "]") {
    const parsed = valueAt(text, index);
    if (parsed === undefined) return undefined;
    value.push(parsed.value);
    index = skip(text, parsed.end);
    if (text.charAt(index) === ",") index = skip(text, index + 1);
    else if (text.charAt(index) !== "]") return undefined;
  }
  return text.charAt(index) === "]" ? { value, end: index + 1 } : undefined;
}

/** The object a config file exports, read as data; `undefined` when the file writes anything but literals there. */
export function literalObject(text: string): Record<string, unknown> | undefined {
  const exported = /\b(?:export\s+default|module\.exports\s*=)/.exec(text);
  const from = exported === null ? 0 : exported.index + exported[0].length;
  const at = text.indexOf("{", from);
  if (at === -1) return undefined;
  return objectAt(text, at)?.value;
}
