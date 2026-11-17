/**
 * Resolves the public TypeScript name a documentation claim points at.
 *
 * A direct export is the declaration in the cited file. A local re-export is followed through its
 * `from` specifier, so an entry file can re-export a function, a type, or a whole module and the claim
 * still sees the declaration it came from. Only local TypeScript files are followed: a package,
 * a path outside the site root, a missing module, or a readable declaration the scanner cannot explain
 * is an unsupported shape rather than a guess. A star re-export cycle adds no new names, so a name the
 * cycle does not provide is removed rather than unsupported. A name two star re-exports both provide
 * is ambiguous, because neither one is the public API.
 *
 * The entry and every followed module are read inside `root` and never outside it, including through a
 * symbolic link. A file the scanner cannot parse is unsupported with the scanner's reason, never
 * reported as missing. The result depends only on the files and the requested name.
 */
import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { exportedSymbols, type ExportedSymbol } from "./symbols.ts";

/** Where a public name's declaration was found, or why it was not. */
export type ContractResolution =
  | {
      readonly state: "resolved";
      /** File that declares the name, relative to the root. */
      readonly file: string;
      /** The declaration, with overloads merged and their declaration lines kept. */
      readonly symbol: ExportedSymbol;
    }
  | {
      readonly state: "missing";
      /** Entry file the claim cited, relative to the root. */
      readonly file: string;
      /** Name no public export provides. */
      readonly name: string;
    }
  | {
      readonly state: "ambiguous";
      /** Entry file the claim cited, relative to the root. */
      readonly file: string;
      /** Name more than one star re-export provides. */
      readonly name: string;
      /** Every local module that exports the name, in code-point order. */
      readonly candidates: readonly string[];
    }
  | {
      readonly state: "unsupported";
      /** Entry file the claim cited, relative to the root. */
      readonly file: string;
      /** Name whose declaration could not be read. */
      readonly name: string;
      /** Why the API cannot be read. */
      readonly reason: string;
    };

/** Options of {@link resolveContractSymbol}. */
export interface ResolveOptions {
  /** Site root that relative paths and local re-export specifiers resolve from. */
  readonly root: string;
}

/** One file resolved inside the root, with the path a report shows. */
interface Located {
  readonly real: string;
  readonly display: string;
}

/** A file's exported names and the local modules it re-exports them from. */
interface SourceInfo extends Located {
  readonly symbols: readonly ExportedSymbol[];
  readonly edges: readonly ExportEdge[];
}

/** A top-level `export ... from` a name can be followed through; absent for local lists. */
type ExportEdge =
  | { readonly exported: "*"; readonly from: string }
  | { readonly exported: string; readonly imported: string; readonly from: string };

/** Where the files of one resolution live. */
interface Site {
  readonly root: string;
  readonly rootReal: string;
}

/** A TypeScript source file, including `.d.ts`, `.mts`, `.cts`, and `.tsx`. */
const TYPESCRIPT = /\.(?:ts|mts|cts|tsx)$/i;

/** A JavaScript specifier a TypeScript import may stand for. */
const JAVASCRIPT = /\.(?:js|mjs|cjs|jsx)$/i;

/**
 * Resolves `name` from `file` to the TypeScript declaration that provides it. `file` is absolute or
 * relative to `options.root`; every followed re-export stays inside the root. Reads files and never
 * writes them.
 */
export async function resolveContractSymbol(
  file: string,
  name: string,
  options: ResolveOptions,
): Promise<ContractResolution> {
  const site: Site = { root: resolve(options.root), rootReal: await realpathOr(resolve(options.root)) };
  const entry = await locateEntry(file, site);
  if ("reason" in entry) return { state: "unsupported", file: displayOf(file, site), name, reason: entry.reason };
  return resolveIn(entry, name, new Set(), site);
}

/** Reads one file, follows its explicit or star re-export, and falls back to the public export. */
async function resolveIn(
  file: Located,
  name: string,
  seen: ReadonlySet<string>,
  site: Site,
): Promise<ContractResolution> {
  if (seen.has(file.real)) {
    // A star cycle has already exposed every local name it can; repeating it adds none.
    return { state: "missing", file: file.display, name };
  }

  const loaded = await load(file);
  if ("reason" in loaded) return { state: "unsupported", file: file.display, name, reason: loaded.reason };

  const explicit = loaded.edges.find(
    (edge): edge is Extract<ExportEdge, { readonly imported: string }> =>
      "imported" in edge && edge.exported === name,
  );
  if (explicit !== undefined) {
    return follow(file, name, explicit.imported, explicit.from, seen, site);
  }

  const declared = loaded.symbols.filter((symbol) => symbol.name === name);
  if (declared.length > 0) return declaredResult(file, name, declared);

  const stars = loaded.edges.filter(
    (edge): edge is Extract<ExportEdge, { readonly exported: "*" }> => edge.exported === "*",
  );
  if (stars.length > 0 && name !== "default") return starResult(file, name, stars, seen, site);

  return { state: "missing", file: file.display, name };
}

/** Follows one local `export { name as alias } from "..."` to the name in its target. */
async function follow(
  file: Located,
  publicName: string,
  imported: string,
  specifier: string,
  seen: ReadonlySet<string>,
  site: Site,
): Promise<ContractResolution> {
  const target = await locateModule(specifier, file, site);
  if ("reason" in target) {
    return { state: "unsupported", file: file.display, name: publicName, reason: target.reason };
  }

  const result = await resolveIn(target, imported, extend(seen, file.real), site);
  if (result.state === "resolved") return result;
  if (result.state === "missing") return { state: "missing", file: file.display, name: publicName };
  if (result.state === "ambiguous") {
    return { state: "ambiguous", file: file.display, name: publicName, candidates: result.candidates };
  }
  return { state: "unsupported", file: file.display, name: publicName, reason: result.reason };
}

/** Resolves a name one or more `export * from "..."` entries provide. */
async function starResult(
  file: Located,
  name: string,
  stars: readonly Extract<ExportEdge, { readonly exported: "*" }>[],
  seen: ReadonlySet<string>,
  site: Site,
): Promise<ContractResolution> {
  const candidates: Array<{ readonly display: string; readonly result: ContractResolution }> = [];
  const targets = new Set<string>();

  for (const star of stars) {
    const target = await locateModule(star.from, file, site);
    if ("reason" in target) {
      candidates.push({
        display: star.from,
        result: { state: "unsupported", file: star.from, name, reason: target.reason },
      });
      continue;
    }
    if (targets.has(target.real)) continue;
    targets.add(target.real);

    const result = await resolveIn(target, name, extend(seen, file.real), site);
    if (result.state !== "missing") candidates.push({ display: target.display, result });
  }

  if (candidates.length === 0) return { state: "missing", file: file.display, name };
  const first = candidates[0] as { readonly display: string; readonly result: ContractResolution };
  if (candidates.length === 1) {
    if (first.result.state === "resolved") return first.result;
    if (first.result.state === "missing") return { state: "missing", file: file.display, name };
    if (first.result.state === "ambiguous") {
      return { state: "ambiguous", file: file.display, name, candidates: first.result.candidates };
    }
    return { state: "unsupported", file: file.display, name, reason: first.result.reason };
  }

  return {
    state: "ambiguous",
    file: file.display,
    name,
    candidates: candidates.map((candidate) => candidate.display).sort(byCodePoint),
  };
}

/** Turns the declarations of one public name into a resolved symbol, or names why it has no API. */
function declaredResult(file: Located, name: string, declared: readonly ExportedSymbol[]): ContractResolution {
  const signatures = declared.flatMap((symbol) => symbol.signatures ?? []);
  if (signatures.length > 0) {
    const first = declared[0] as ExportedSymbol;
    const unchecked = declared.find((symbol) => symbol.unchecked !== undefined)?.unchecked;
    return {
      state: "resolved",
      file: file.display,
      symbol: {
        name: first.name,
        kind: first.kind,
        line: first.line,
        signatures,
        ...(unchecked === undefined ? {} : { unchecked }),
      },
    };
  }
  const reason = declared.find((symbol) => symbol.unchecked !== undefined)?.unchecked;
  return {
    state: "unsupported",
    file: file.display,
    name,
    reason: reason ?? `"${name}" has no comparable signature`,
  };
}

/** Resolves the entry file itself, refusing anything outside the root. */
async function locateEntry(file: string, site: Site): Promise<Located | { readonly reason: string }> {
  const absolute = isAbsolute(file) ? resolve(file) : resolve(site.root, file);
  const display = displayOf(file, site);
  let real: string;
  try {
    real = await realpath(absolute);
  } catch {
    return { reason: `Cannot read "${display}".` };
  }
  if (!within(site.rootReal, real)) return { reason: `"${display}" resolves outside the site root.` };
  if (!TYPESCRIPT.test(real)) return { reason: `"${display}" is not a TypeScript file.` };
  return { real, display: toPosix(relative(site.rootReal, real)) };
}

/** Resolves one relative re-export specifier to a TypeScript file inside the root. */
async function locateModule(
  specifier: string,
  from: Located,
  site: Site,
): Promise<Located | { readonly reason: string }> {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
    return { reason: `The re-export target "${specifier}" is not a local module.` };
  }

  const base = resolve(dirname(from.real), specifier);
  for (const candidate of moduleCandidates(base, specifier)) {
    let real: string;
    try {
      real = await realpath(candidate);
    } catch {
      continue;
    }
    if (!within(site.rootReal, real)) {
      return { reason: `The re-export target "${specifier}" resolves outside the site root.` };
    }
    if (!TYPESCRIPT.test(real)) continue;
    return { real, display: toPosix(relative(site.rootReal, real)) };
  }
  return { reason: `The re-export target "${specifier}" cannot be read.` };
}

/** The files a TypeScript module specifier may mean, in resolution order. */
function moduleCandidates(base: string, specifier: string): readonly string[] {
  if (TYPESCRIPT.test(specifier)) return [base];
  const javascript = JAVASCRIPT.exec(specifier);
  if (javascript !== null) {
    const stem = base.slice(0, -javascript[0].length);
    switch (javascript[0].toLowerCase()) {
      case ".js":
        return [`${stem}.ts`, `${stem}.tsx`];
      case ".mjs":
        return [`${stem}.mts`];
      case ".cjs":
        return [`${stem}.cts`];
      default:
        return [`${stem}.tsx`];
    }
  }
  if (/\.[^/.]+$/.test(specifier)) return [];
  return [
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    `${base}.cts`,
    resolve(base, "index.ts"),
    resolve(base, "index.tsx"),
    resolve(base, "index.mts"),
    resolve(base, "index.cts"),
  ];
}

/** Reads and scans one file, or explains why its API cannot be read. */
async function load(file: Located): Promise<SourceInfo | { readonly reason: string }> {
  let text: string;
  try {
    text = await readFile(file.real, "utf8");
  } catch {
    return { reason: `Cannot read "${file.display}".` };
  }

  const scanned = exportedSymbols(text, { file: file.display });
  const syntax = scanned.diagnostics[0];
  if (syntax !== undefined) return { reason: syntax.message };

  let edges: readonly ExportEdge[];
  try {
    edges = exportEdgesOf(text);
  } catch {
    return { reason: `Cannot read the re-export list of "${file.display}".` };
  }
  return { ...file, symbols: scanned.symbols, edges };
}

/** Reads every top-level `export ... from` without treating strings, comments, or nested blocks as code. */
function exportEdgesOf(source: string): readonly ExportEdge[] {
  const edges: ExportEdge[] = [];
  let depth = 0;
  let index = 0;

  while (index < source.length) {
    const ch = source[index] as string;
    const next = source[index + 1];

    if (ch === "/" && next === "/") {
      index = endOfLineComment(source, index);
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      index = endOfString(source, index, ch);
      continue;
    }
    if (ch === "`") {
      index = endOfTemplate(source, index);
      continue;
    }
    if (ch === "/" && isRegexStart(source, index)) {
      index = endOfRegex(source, index);
      continue;
    }
    if (ch === "{") {
      depth += 1;
      index += 1;
      continue;
    }
    if (ch === "}") {
      if (depth > 0) depth -= 1;
      index += 1;
      continue;
    }
    if (isIdentifierStart(ch)) {
      const start = index;
      index = endOfIdentifier(source, index);
      if (depth === 0 && source.slice(start, index) === "export" && isStatementStart(source, start)) {
        index = scanExport(source, index, edges);
      }
      continue;
    }
    index += 1;
  }

  return edges;
}

/** Reads one export after its keyword and records the `from` edges it writes. */
function scanExport(source: string, afterExport: number, edges: ExportEdge[]): number {
  let index = skipTrivia(source, afterExport);

  const first = readIdentifier(source, index);
  if (first !== null && first.name === "type") {
    const after = skipTrivia(source, first.end);
    if (source[after] === "{" || source[after] === "*") index = after;
  }

  if (source[index] === "*") {
    const afterStar = skipTrivia(source, index + 1);
    const as = readIdentifier(source, afterStar);
    if (as !== null && as.name === "as") return afterStar;
    const from = readFrom(source, afterStar);
    if (from === null) return index + 1;
    edges.push({ exported: "*", from: from.specifier });
    return from.end;
  }

  if (source[index] !== "{") return afterExport;
  const close = endOfBraces(source, index);
  const from = readFrom(source, close);
  if (from === null) return close;
  for (const specifier of exportSpecifiers(source, index, close)) {
    edges.push({ exported: specifier.exported, imported: specifier.imported, from: from.specifier });
  }
  return from.end;
}

/** Reads `from "module"` after an export list or star, or null when the export is local. */
function readFrom(source: string, index: number): { readonly specifier: string; readonly end: number } | null {
  const from = readIdentifier(source, skipTrivia(source, index));
  if (from === null || from.name !== "from") return null;
  const start = skipTrivia(source, from.end);
  const quote = source[start];
  if (quote !== '"' && quote !== "'") return null;
  const end = endOfString(source, start, quote);
  return { specifier: source.slice(start + 1, end - 1), end };
}

/** Reads the `local as exported` pairs in an export list. */
function exportSpecifiers(
  source: string,
  open: number,
  close: number,
): readonly { readonly imported: string; readonly exported: string }[] {
  const specifiers: Array<{ readonly imported: string; readonly exported: string }> = [];
  const limit = close > open + 1 && source[close - 1] === "}" ? close - 1 : close;
  let index = open + 1;

  while (index < limit) {
    index = skipTrivia(source, index);
    if (index >= limit) break;
    if (source[index] === ",") {
      index += 1;
      continue;
    }

    const maybeType = readIdentifier(source, index);
    if (maybeType !== null && maybeType.name === "type") {
      const after = skipTrivia(source, maybeType.end);
      const next = readIdentifier(source, after);
      if (next !== null && next.name !== "as") index = after;
    }

    const local = readModuleName(source, index);
    if (local === null) break;
    index = skipTrivia(source, local.end);

    let exported = local;
    const as = readIdentifier(source, index);
    if (as !== null && as.name === "as") {
      const alias = readModuleName(source, skipTrivia(source, as.end));
      if (alias === null) break;
      exported = alias;
      index = skipTrivia(source, alias.end);
    }

    specifiers.push({ imported: local.name, exported: exported.name });
    if (source[index] === ",") index += 1;
  }

  return specifiers;
}

/** The index just after the `}` that closes the `{` at `open`. */
function endOfBraces(source: string, open: number): number {
  let index = open + 1;
  let depth = 1;
  while (index < source.length) {
    const ch = source[index] as string;
    if (ch === "/" && source[index + 1] === "/") {
      index = endOfLineComment(source, index);
      continue;
    }
    if (ch === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      index = endOfString(source, index, ch);
      continue;
    }
    if (ch === "`") {
      index = endOfTemplate(source, index);
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  return source.length;
}

/** The real path, or the path itself when it does not resolve (a missing root, for example). */
async function realpathOr(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/** True when `target` is `base` or inside it. */
function within(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** The path a result shows, relative to the root when the input is inside it. */
function displayOf(file: string, site: Site): string {
  const absolute = isAbsolute(file) ? resolve(file) : resolve(site.root, file);
  const rel = toPosix(relative(site.root, absolute));
  return rel === "" || rel.startsWith("../") ? toPosix(file) : rel;
}

/** A path with `/` separators, so a report looks the same on every platform. */
function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

/** Adds one file to the chain a resolution has already followed. */
function extend(seen: ReadonlySet<string>, file: string): ReadonlySet<string> {
  const next = new Set(seen);
  next.add(file);
  return next;
}

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** An identifier or a quoted module name. */
interface Identifier {
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

/** Reads an identifier at `index`. */
function readIdentifier(source: string, index: number): Identifier | null {
  const ch = source[index];
  if (ch === undefined || !isIdentifierStart(ch)) return null;
  const end = endOfIdentifier(source, index);
  return { name: source.slice(index, end), start: index, end };
}

/** Reads an identifier or a quoted name in an export list. */
function readModuleName(source: string, index: number): Identifier | null {
  const ch = source[index];
  if (ch === '"' || ch === "'") {
    const end = endOfString(source, index, ch);
    return { name: source.slice(index + 1, end - 1), start: index, end };
  }
  return readIdentifier(source, index);
}

/** True for the start of an identifier. */
function isIdentifierStart(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return ch === "_" || ch === "$" || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code > 127;
}

/** True for the continuation of an identifier. */
function isIdentifierPart(ch: string): boolean {
  return isIdentifierStart(ch) || (ch >= "0" && ch <= "9");
}

/** Number of code units in an identifier starting at `index`. */
function endOfIdentifier(source: string, index: number): number {
  let end = index + 1;
  while (end < source.length && isIdentifierPart(source[end] as string)) end += 1;
  return end;
}

/** True when an `export` word sits where a statement may start. */
function isStatementStart(source: string, index: number): boolean {
  let lineStart = index;
  while (lineStart > 0 && source[lineStart - 1] !== "\n" && source[lineStart - 1] !== "\r") lineStart -= 1;
  let onlyTriviaOnLine = true;
  for (let at = lineStart; at < index; at += 1) {
    if (!isWhitespace(source[at] as string)) {
      onlyTriviaOnLine = false;
      break;
    }
  }
  if (onlyTriviaOnLine) return true;

  let previous = index - 1;
  while (previous >= 0 && isWhitespace(source[previous] as string)) previous -= 1;
  if (previous < 0) return true;
  const ch = source[previous] as string;
  if (ch === "." || ch === "?" || isIdentifierPart(ch)) return false;
  if (ch === ";" || ch === "}" || ch === "{" || ch === ")" || ch === "]") return true;
  return hasNewline(source, previous + 1, index);
}

/** True when the `/` at `index` starts a regular expression rather than a division. */
function isRegexStart(source: string, index: number): boolean {
  let previous = index - 1;
  while (previous >= 0 && isWhitespace(source[previous] as string)) previous -= 1;
  if (previous < 0) return true;
  const ch = source[previous] as string;
  if ("=(:,[!&|?{};+-*%<>~^".includes(ch)) return true;
  if (isIdentifierPart(ch)) {
    const word = previousWord(source, previous + 1);
    return (
      word === "return" ||
      word === "typeof" ||
      word === "case" ||
      word === "delete" ||
      word === "void" ||
      word === "throw" ||
      word === "new" ||
      word === "in" ||
      word === "of" ||
      word === "yield" ||
      word === "await"
    );
  }
  return false;
}

/** The identifier ending at `end` (exclusive), for regex-position checks. */
function previousWord(source: string, end: number): string {
  let start = end;
  while (start > 0 && isIdentifierPart(source[start - 1] as string)) start -= 1;
  return source.slice(start, end);
}

/** Skips whitespace and comments. */
function skipTrivia(source: string, index: number): number {
  let current = index;
  while (current < source.length) {
    const ch = source[current] as string;
    if (isWhitespace(ch)) {
      current += 1;
      continue;
    }
    if (ch === "/" && source[current + 1] === "/") {
      current = endOfLineComment(source, current);
      continue;
    }
    if (ch === "/" && source[current + 1] === "*") {
      const end = source.indexOf("*/", current + 2);
      current = end === -1 ? source.length : end + 2;
      continue;
    }
    break;
  }
  return current;
}

/** Index just after a `//` comment. */
function endOfLineComment(source: string, index: number): number {
  const newline = source.indexOf("\n", index + 2);
  return newline === -1 ? source.length : newline + 1;
}

/** Index just after a quoted string. */
function endOfString(source: string, index: number, quote: string): number {
  let current = index + 1;
  while (current < source.length) {
    const ch = source[current] as string;
    if (ch === "\\") {
      current += 2;
      continue;
    }
    if (ch === quote) return current + 1;
    current += 1;
  }
  throw new Error("Unterminated string");
}

/** Index just after a template literal. */
function endOfTemplate(source: string, index: number): number {
  let current = index + 1;
  while (current < source.length) {
    const ch = source[current] as string;
    if (ch === "\\") {
      current += 2;
      continue;
    }
    if (ch === "`") return current + 1;
    current += 1;
  }
  throw new Error("Unterminated template literal");
}

/** Index just after a regular expression literal, including its flags. */
function endOfRegex(source: string, index: number): number {
  let current = index + 1;
  let inClass = false;
  while (current < source.length) {
    const ch = source[current] as string;
    if (ch === "\\") {
      current += 2;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      current += 1;
      continue;
    }
    if (ch === "]") {
      inClass = false;
      current += 1;
      continue;
    }
    if (ch === "/" && !inClass) {
      current += 1;
      while (current < source.length && isIdentifierPart(source[current] as string)) current += 1;
      return current;
    }
    current += 1;
  }
  throw new Error("Unterminated regular expression");
}

/** True for whitespace characters the scanner ignores between tokens. */
function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v" || ch === "\uFEFF";
}

/** True when `text` holds a line break. */
function hasNewline(text: string, start: number, end: number): boolean {
  for (let index = start; index < end; index += 1) {
    if (text[index] === "\n" || text[index] === "\r") return true;
  }
  return false;
}
