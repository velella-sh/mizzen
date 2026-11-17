import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveContractSymbol } from "../../src/drift/contract-resolver.ts";

const fixture = fileURLToPath(new URL("../../fixtures/api-contract-check/", import.meta.url));

/** A site root under the OS temp folder; the caller removes it. */
function site(): string {
  return mkdtempSync(join(tmpdir(), "api-contract-resolve-"));
}

/** Writes one file inside `root`, creating its folders. */
function write(root: string, path: string, text: string): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** A widget module whose function is declared on line 5. */
function widget(): string {
  return [
    "export interface WidgetOptions {", // 1
    "  readonly id: string;", // 2
    "}", // 3
    "", // 4
    "export function createWidget(name: string, options?: WidgetOptions): void {}", // 5
  ].join("\n");
}

test("a direct export resolves to its own declaration", async () => {
  const result = await resolveContractSymbol("src/widget.ts", "createWidget", { root: fixture });
  assert.equal(result.state, "resolved");
  if (result.state !== "resolved") return;
  assert.equal(result.file, "src/widget.ts");
  assert.equal(result.symbol.name, "createWidget");
  assert.equal(result.symbol.line, 10);
  assert.equal(result.symbol.signatures?.length, 1);
});

test("an alias and a star re-export resolve from a local entry to the declaring file", async () => {
  const root = site();
  try {
    write(root, "src/widget.ts", widget());
    write(root, "src/types.ts", "export type Id = string;");
    write(root, "src/index.ts", [
      'export { createWidget as makeWidget } from "./widget.ts";',
      'export * from "./types.ts";',
    ].join("\n"));

    const alias = await resolveContractSymbol("src/index.ts", "makeWidget", { root });
    assert.equal(alias.state, "resolved");
    if (alias.state !== "resolved") return;
    assert.equal(alias.file, "src/widget.ts");
    assert.equal(alias.symbol.name, "createWidget");
    assert.equal(alias.symbol.line, 5);

    const star = await resolveContractSymbol("src/index.ts", "Id", { root });
    assert.equal(star.state, "resolved");
    if (star.state !== "resolved") return;
    assert.equal(star.file, "src/types.ts");
    assert.equal(star.symbol.name, "Id");
    assert.equal(star.symbol.line, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a removed name is missing, not clean", async () => {
  const root = site();
  try {
    write(root, "src/index.ts", "export const present = 1;\n");
    const result = await resolveContractSymbol("src/index.ts", "removed", { root });
    assert.equal(result.state, "missing");
    if (result.state !== "missing") return;
    assert.equal(result.file, "src/index.ts");
    assert.equal(result.name, "removed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a name two star re-exports provide is ambiguous", async () => {
  const root = site();
  try {
    write(root, "src/a.ts", "export function shared(): void {}\n");
    write(root, "src/b.ts", "export function shared(): void {}\n");
    write(root, "src/index.ts", [
      'export * from "./b.ts";',
      'export * from "./a.ts";',
    ].join("\n"));

    const result = await resolveContractSymbol("src/index.ts", "shared", { root });
    assert.equal(result.state, "ambiguous");
    if (result.state !== "ambiguous") return;
    assert.equal(result.file, "src/index.ts");
    assert.equal(result.name, "shared");
    assert.deepEqual(result.candidates, ["src/a.ts", "src/b.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a star re-export cycle leaves an unrelated name missing", async () => {
  const root = site();
  try {
    write(root, "src/a.ts", 'export function present(): void {}\nexport * from "./b.ts";');
    write(root, "src/b.ts", 'export * from "./a.ts";');
    write(root, "src/index.ts", 'export * from "./a.ts";');

    const missing = await resolveContractSymbol("src/index.ts", "absent", { root });
    assert.equal(missing.state, "missing");
    if (missing.state !== "missing") return;
    assert.equal(missing.file, "src/index.ts");
    assert.equal(missing.name, "absent");

    const present = await resolveContractSymbol("src/index.ts", "present", { root });
    assert.equal(present.state, "resolved");
    if (present.state !== "resolved") return;
    assert.equal(present.file, "src/a.ts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a package re-export, an enum, and an inferred value are unsupported shapes", async () => {
  const root = site();
  try {
    write(root, "src/color.ts", "export enum Color { Red }\n");
    write(root, "src/index.ts", [
      'export { remote } from "@scope/pkg";',
      'export { Color } from "./color.ts";',
      "export const inferred = 1;",
    ].join("\n"));

    const remote = await resolveContractSymbol("src/index.ts", "remote", { root });
    assert.equal(remote.state, "unsupported");
    if (remote.state !== "unsupported") return;
    assert.match(remote.reason, /not a local module/);

    const color = await resolveContractSymbol("src/index.ts", "Color", { root });
    assert.equal(color.state, "unsupported");
    if (color.state !== "unsupported") return;
    assert.match(color.reason, /enum/);

    const inferred = await resolveContractSymbol("src/index.ts", "inferred", { root });
    assert.equal(inferred.state, "unsupported");
    if (inferred.state !== "unsupported") return;
    assert.match(inferred.reason, /infer/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
