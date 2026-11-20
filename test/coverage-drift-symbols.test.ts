import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkDocumentedSignature,
  documentedClaim,
  exportedSymbols,
  type DocumentedClaim,
  type ExportedSymbol,
} from "../src/drift/symbols.ts";

/** The one symbol `source` exports, or a failure. */
function symbolOf(source: string): ExportedSymbol {
  const [symbol] = exportedSymbols(source).symbols;
  assert.ok(symbol, "the source exports one symbol");
  return symbol;
}

/** The signature text of one exported symbol. */
function signatureOf(source: string): string | undefined {
  return symbolOf(source).signatures?.[0]?.text;
}

/** The claim of documented code, or a failure. */
function claimOf(value: string): DocumentedClaim {
  const claim = documentedClaim(value);
  assert.ok(claim, `"${value}" is a claim`);
  return claim;
}

/** How one documented form compares with one exported declaration. */
function check(source: string, documented: string): string {
  return checkDocumentedSignature(claimOf(documented), symbolOf(source)).state;
}

test("export assignments, namespace aliases, and quoted re-exports are reported", () => {
  const assigned = exportedSymbols("const value = 1;\nexport = value;\n");
  assert.deepEqual(assigned.symbols.map((symbol) => [symbol.name, symbol.kind]), [["value", "const"]]);
  assert.match(assigned.symbols[0]?.unchecked ?? "", /not known/);

  const imported = exportedSymbols('export import Alias = require("./module");\n');
  assert.deepEqual(imported.symbols.map((symbol) => [symbol.name, symbol.kind]), [["Alias", "namespace"]]);
  assert.match(imported.symbols[0]?.unchecked ?? "", /namespace alias/);

  const star = exportedSymbols('export * as helpers from "./helpers.ts";\n');
  assert.deepEqual(star.symbols.map((symbol) => [symbol.name, symbol.kind]), [["helpers", "namespace"]]);
  assert.match(star.symbols[0]?.unchecked ?? "", /namespace re-export/);

  const quoted = exportedSymbols('export { "odd-name" as odd } from "./module.ts";\n');
  assert.deepEqual(quoted.symbols.map((symbol) => [symbol.name, symbol.kind]), [["odd", "const"]]);

  const typed = exportedSymbols('export type * from "./module.ts";\nexport type { Shape as Outline } from "./module.ts";\n');
  assert.deepEqual(typed.symbols.map((symbol) => symbol.name), ["Outline"]);
});

test("a malformed declaration reports one syntax error at its own position", () => {
  const cases = [
    "export",
    "export function () {}",
    "export class {}",
    "export * as",
    "export =",
    "export import",
    "export function generic<T(a: T) {}",
  ];
  for (const source of cases) {
    const result = exportedSymbols(source, { file: "broken.ts" });
    assert.deepEqual(result.symbols, [], source);
    assert.equal(result.diagnostics.length, 1, source);
    assert.equal(result.diagnostics[0]?.id, "drift.symbols-syntax", source);
    assert.equal(result.diagnostics[0]?.pos?.file, "broken.ts", source);
  }
});

test("function expressions and arrows carry their parameters, generics, and returns", () => {
  const source = [
    "export const fn = function (a: string): number { return 1; };",
    "export const asyncGen = async function* named<T>(value: T): T { return value; };",
    "export const gen = function* () {};",
    "export const genericArrow = <T>(value: T): T => value;",
    "export const genericParen = <T>(value: T) => value;",
    "export const parenthesized = (a: number): (() => void) => () => {};",
    "export const stringReturn = (): \"x\" => \"x\";",
    "export const templateReturn = (): `x${string}` => `x`;",
    "export const commentedReturn = (a: number /* c */): /* r */ string => \"\";",
    "export const objectReturn = (a: { b: string }): { c: number } => ({ c: 1 });",
    "export const single = (value) => value;",
    "export const singleTyped = value => value;",
    "export const notArrow = <T>(value: T): T;",
  ].join("\n");

  const symbols = new Map(exportedSymbols(source).symbols.map((symbol) => [symbol.name, symbol]));
  assert.match(symbols.get("fn")?.signatures?.[0]?.text ?? "", /^const fn = function\(a:string\): number$/);
  assert.match(symbols.get("asyncGen")?.signatures?.[0]?.text ?? "", /^const asyncGen = async function\*<T>\(value:T\): T$/);
  assert.match(symbols.get("gen")?.signatures?.[0]?.text ?? "", /^const gen = function\*\(\)$/);
  assert.equal(symbols.get("genericArrow")?.signatures?.[0]?.generics, "<T>");
  assert.equal(symbols.get("genericArrow")?.signatures?.[0]?.returns, "T");
  assert.equal(symbols.get("parenthesized")?.signatures?.[0]?.returns, "(()=>void)");
  assert.equal(symbols.get("stringReturn")?.signatures?.[0]?.returns, '"x"');
  assert.equal(symbols.get("templateReturn")?.signatures?.[0]?.returns, "`x${string}`");
  assert.equal(symbols.get("commentedReturn")?.signatures?.[0]?.returns, "string");
  assert.equal(symbols.get("objectReturn")?.signatures?.[0]?.returns, "{c:number}");
  assert.deepEqual(symbols.get("single")?.signatures?.[0]?.params?.map((param) => param.name), ["value"]);
  assert.deepEqual(symbols.get("singleTyped")?.signatures?.[0]?.params?.map((param) => param.name), ["value"]);
  assert.match(symbols.get("notArrow")?.unchecked ?? "", /not a function/);
});

test("class members keep the public API and skip private, hashed, and inferred ones", () => {
  const source = [
    "export class Members {",
    "  ;",
    "  ,",
    "  #secret = 1;",
    "  private hidden = 2;",
    "  protected alsoHidden: string = 'x';",
    "  private #hashed = 3;",
    "  constructor(public name: string, private id: number) {}",
    "  [index: string]: unknown;",
    "  [bad] = 1;",
    "  method<T>(value: T): T { return value; }",
    "  get value(): number { return 1; }",
    "  set value(next: number) {}",
    "  static async run(): Promise<void> {}",
    "  property = 1;",
    "  bare;",
    "  0: string;",
    '  "quoted": number;',
    "  @decorated prop: string;",
    "}",
    "export class NoBody;",
  ].join("\n");

  const symbols = new Map(exportedSymbols(source).symbols.map((symbol) => [symbol.name, symbol]));
  const members = symbols.get("Members");
  assert.ok(members?.signatures?.[0]?.members);
  const text = members.signatures[0].members.join(";");
  assert.match(text, /constructor\(public name:string, private id:number\)/);
  assert.match(text, /\[index:string\]:unknown/);
  assert.match(text, /method<T>\(value:T\): T/);
  assert.match(text, /get value\(\): number/);
  assert.match(text, /set value\(next:number\)/);
  assert.match(text, /static async run\(\): Promise<void>/);
  assert.match(text, /property/);
  assert.match(text, /bare/);
  assert.match(text, /0:string/);
  assert.match(text, /"quoted":number/);
  assert.equal(text.includes("hidden"), false);
  assert.equal(text.includes("secret"), false);
  assert.equal(text.includes("hashed"), false);
  assert.equal(text.includes("decorated"), false);
  assert.match(members.unchecked ?? "", /inferred type|unrecognized|index signature/);
  assert.match(symbols.get("NoBody")?.unchecked ?? "", /without a body/);

  const skipping = exportedSymbols([
    "export class Skipping {",
    "  private config = { a: 1 };",
    "  private text = `a",
    "b`;",
    "  private pattern = /x/g;",
    "  private union = 'a' |",
    "    'b';",
    "  private value =",
    "    1;",
    "  visible: string;",
    "}",
  ].join("\n"));
  const skipped = skipping.symbols[0];
  assert.deepEqual(skipped?.signatures?.[0]?.members, ["visible:string"]);
});

test("interface, type alias, and return types read comments, strings, templates, and numbers", () => {
  const source = [
    "export interface Commented {",
    "  prop: /* c */ string | null;",
    '  quoted: "a" | "b";',
    "  templated: `x`;",
    "  union:",
    '    | "a"',
    '    | "b";',
    "}",
    "export type Escaped = \"a\\\\b\" | 'c\\'d' | \"e\\\"f\" | \"g\\nh\";",
    "export type Same = 'a' | \"b\";",
    "export type Hex = 0x10 | 1_000 | 1e3 | 1.5;",
    "export type Template = `x${string}`;",
    "export type CommentedAlias = string /* block */ | number;",
    "export type LineComment = string // trailing",
    "  | number;",
    "export function multi(): | \"a\"",
    "  | \"b\" { return \"a\"; }",
    "export function typed(): /* c */ \"x\" | `y` { return \"x\"; }",
    "export function numbers(): 0 | 1 { return 0; }",
    "export function nested(): (() => { a: string }) { return null as never; }",
    "export function declared(): string",
  ].join("\n");

  const symbols = new Map(exportedSymbols(source).symbols.map((symbol) => [symbol.name, symbol]));
  assert.deepEqual(symbols.get("Commented")?.signatures?.[0]?.members, [
    "prop:string|null",
    'quoted:"a"|"b"',
    "templated:`x`",
    'union:|"a"|"b"',
  ]);
  assert.equal(symbols.get("Same")?.signatures?.[0]?.alias, '"a"|"b"');
  assert.equal(symbols.get("Hex")?.signatures?.[0]?.alias, "0x10|1_000|1e3|1.5");
  assert.equal(symbols.get("Template")?.signatures?.[0]?.alias, "`x${string}`");
  assert.equal(symbols.get("CommentedAlias")?.signatures?.[0]?.alias, "string|number");
  assert.equal(symbols.get("LineComment")?.signatures?.[0]?.alias, "string|number");
  assert.equal(symbols.get("multi")?.signatures?.[0]?.returns, '|"a"|"b"');
  assert.equal(symbols.get("typed")?.signatures?.[0]?.returns, '"x"|`y`');
  assert.equal(symbols.get("numbers")?.signatures?.[0]?.returns, "0|1");
  assert.equal(symbols.get("nested")?.signatures?.[0]?.returns, "(()=>{a:string})");
  assert.equal(symbols.get("declared")?.signatures?.[0]?.returns, "string");
});

test("parameters keep names, types, defaults, rest, and comments", () => {
  const source = [
    "export function params(",
    "  a: /* c */ string,",
    '  b: "x" = "x",',
    "  c = `t`,",
    "  d = /r/,",
    "  ...rest: number[]",
    "): void {}",
  ].join("\n");
  const signature = symbolOf(source).signatures?.[0];
  assert.deepEqual(signature?.params?.map((param) => [param.name, param.type, param.optional, param.rest]), [
    ["a", "string", false, false],
    ["b", '"x"', true, false],
    ["c", undefined, true, false],
    ["d", undefined, true, false],
    ["rest", "number[]", false, true],
  ]);

  const generics = exportedSymbols("export function gen<T /* c */ extends \"a\" | `b`>(value: T): T { return value; }");
  assert.equal(generics.symbols[0]?.signatures?.[0]?.generics, "<T extends\"a\"|`b`>");
});

test("documented claims read names, calls, functions, classes, types, and consts", () => {
  assert.deepEqual(documentedClaim("   "), null);
  assert.deepEqual(documentedClaim("build"), { name: "build", form: "name" });
  assert.equal(documentedClaim("")?.name, undefined);

  const call = claimOf("build(root, mode)");
  assert.equal(call.form, "call");
  assert.equal(call.signature?.text, "build(root, mode)");
  assert.equal(documentedClaim("..."), null);

  const spread = claimOf("run(...args)");
  assert.equal(spread.form, "call");
  assert.match(spread.unchecked ?? "", /spread argument/);

  const pattern = claimOf("run({ id })");
  assert.match(pattern.unchecked ?? "", /destructured argument/);

  const typed = claimOf("pick<T>(value: T): T");
  assert.equal(typed.form, "signature");
  assert.equal(typed.signature?.generics, "<T>");
  assert.equal(typed.signature?.returns, "T");

  const functionClaim = claimOf("async function load<T>(value: T): T");
  assert.equal(functionClaim.kind, "function");
  assert.equal(functionClaim.signature?.params?.[0]?.name, "value");

  assert.equal(claimOf("function* generate(): void").kind, "function");
  assert.equal(claimOf("class Widget { id: string }").kind, "class");
  assert.equal(claimOf("interface Shape { id: string }").kind, "interface");
  assert.equal(claimOf("type Id = string").signature?.alias, "string");
  assert.equal(claimOf("const VERSION: string").signature?.alias, "string");
  assert.equal(claimOf("let mutable").kind, "const");
  assert.equal(claimOf("declare const declared").kind, "const");
  assert.equal(claimOf("export default class Base").kind, "class");
  assert.equal(claimOf("async ()").form, "call");
  assert.match(documentedClaim("type (")?.unchecked ?? "", /not TypeScript/);

  const malformed = documentedClaim('broken("unterminated)');
  assert.ok(malformed);
  assert.equal(malformed.name, "broken");
  assert.equal(malformed.form, "signature");
  assert.match(malformed.unchecked ?? "", /not TypeScript/);
  assert.equal(documentedClaim('"unterminated'), null);
});

test("a documented class, interface, type, or const compares only the stated API", () => {
  assert.equal(check("export class Widget<T> extends Base { id: string; run(): void }", "class Widget<T> { id: string }"), "match");
  assert.equal(check("export interface Shape extends Base { id: string }", "interface Shape { id: string }"), "match");
  assert.equal(check("export type Id = string | number;", "type Id = string | number"), "match");
  assert.equal(check("export const VERSION: string = '1';", "const VERSION: string"), "match");

  assert.equal(check("export class Widget extends Base { id: string }", "class Widget extends Other"), "mismatch");
  assert.equal(check("export interface Shape { id: string }", "interface Shape { id: number }"), "mismatch");
  assert.equal(check("export type Id = string;", "type Id<A> = A"), "mismatch");
  assert.equal(check("export type Id = string;", "type Id"), "unchecked");
});

test("comparison reports unchecked when a declaration has no type to compare", () => {
  const claim = claimOf("Widget(value: string)");
  const classSymbol: ExportedSymbol = {
    name: "Widget",
    kind: "class",
    line: 1,
    signatures: [{ text: "class Widget", line: 1 }],
  };
  assert.deepEqual(checkDocumentedSignature(claim, classSymbol), {
    state: "unchecked",
    reason: "a class constructor is not compared",
  });

  const members = checkDocumentedSignature(claimOf("interface Shape { id: string }"), {
    name: "Shape",
    kind: "interface",
    line: 1,
    signatures: [{ text: "interface Shape", line: 1 }],
  });
  assert.deepEqual(members, { state: "unchecked", reason: "the members of this declaration could not be extracted" });

  const alias = checkDocumentedSignature(claimOf("type Id = string"), {
    name: "Id",
    kind: "type",
    line: 1,
    signatures: [{ text: "type Id", line: 1 }],
  });
  assert.deepEqual(alias, { state: "unchecked", reason: "the type alias has no type annotation to compare" });

  const constAlias = checkDocumentedSignature(claimOf("const VERSION: string"), {
    name: "VERSION",
    kind: "const",
    line: 1,
    signatures: [{ text: "const VERSION", line: 1 }],
  });
  assert.deepEqual(constAlias, { state: "unchecked", reason: "the declaration has no type annotation to compare" });

  const memberMismatch = checkDocumentedSignature(claimOf("class Widget { id: number }"), {
    name: "Widget",
    kind: "class",
    line: 1,
    unchecked: "a member has an inferred type",
    signatures: [{ text: "class Widget", line: 1, members: ["id:string"] }],
  });
  assert.deepEqual(memberMismatch, { state: "unchecked", reason: "a member has an inferred type" });

  const nameOnly = checkDocumentedSignature(claimOf("build"), { name: "build", kind: "function", line: 1 });
  assert.deepEqual(nameOnly, { state: "match" });

  const noForm = checkDocumentedSignature({ name: "build", form: "signature" }, symbolOf("export function build(a: string): void {}"));
  assert.deepEqual(noForm, { state: "unchecked", reason: "the documented form has no readable signature" });
});

test("a rest parameter and a missing return annotation make comparison unchecked", () => {
  const pastRest = check("export function f(a: string, ...rest: never[]): void {}", "f(a: string, rest: never[], c: string)");
  assert.equal(pastRest, "unchecked");
  assert.deepEqual(
    checkDocumentedSignature(claimOf("f(a: string, rest: never[], c: string)"), symbolOf("export function f(a: string, ...rest: never[]): void {}")),
    { state: "unchecked", reason: "a parameter past the declared rest parameter has no type to compare" },
  );

  const noReturn = checkDocumentedSignature(claimOf("f(a: string): string"), symbolOf("export function f(a: string) {}"));
  assert.deepEqual(noReturn, { state: "unchecked", reason: "the declaration has no return type annotation to compare" });

  const noAnnotation = checkDocumentedSignature(claimOf("f(a: string)"), symbolOf("export function f(a) {}"));
  assert.deepEqual(noAnnotation, { state: "unchecked", reason: "the parameter at position 1 has no type annotation" });

  const restMismatch = checkDocumentedSignature(
    {
      name: "f",
      form: "signature",
      signature: {
        text: "f(...items)",
        line: 1,
        params: [{ text: "...items", name: "items", optional: false, rest: true }],
      },
    },
    symbolOf("export function f(a: string): void {}"),
  );
  assert.equal(restMismatch.state, "mismatch");
});

test("overloads merge, repeated declarations dedupe, and signatures sort by line and name", () => {
  const source = [
    "export function load(id: string): string;",
    "export function load(id: number): number;",
    "export { load as read, load as load };",
  ].join("\n");
  const symbols = exportedSymbols(source).symbols;
  const load = symbols.find((symbol) => symbol.name === "load");
  assert.equal(load?.signatures?.length, 4);
  assert.equal(symbols.find((symbol) => symbol.name === "read")?.signatures?.length, 2);
  assert.deepEqual(symbols.map((symbol) => symbol.name), ["load", "read"]);
});

test("a same-line export, regex literal, and string escape are scanned without false exports", () => {
  const source = [
    'const escaped = "a\\"b";',
    "const template = `a\\`b`;",
    "const divided = (10) / 2;",
    "const classy = /[a/b]\\/[c]/g;",
    "const object = { export: 1 };",
    "const combined = 1 + export const skipped = 1;",
    "export const real = 1;",
    "const after = 2; export const second = 3;",
  ].join("\n");

  assert.deepEqual(
    exportedSymbols(source).symbols.map((symbol) => symbol.name),
    ["real", "second"],
  );
});

test("a syntax error after a multibyte character reports a code-point column", () => {
  const result = exportedSymbols('const note = "é";\nexport function broken( {', { file: "unicode.ts" });
  assert.equal(result.symbols.length, 0);
  assert.equal(result.diagnostics[0]?.id, "drift.symbols-syntax");
  assert.equal(result.diagnostics[0]?.pos?.file, "unicode.ts");
  assert.ok((result.diagnostics[0]?.pos?.column ?? 0) >= 1);
});
