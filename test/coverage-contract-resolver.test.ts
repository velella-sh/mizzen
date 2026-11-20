import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { resolveContractSymbol } from "../src/drift/contract-resolver.ts";

/** A site root under the OS temp folder; the caller removes it. */
function site(): string {
  return mkdtempSync(join(tmpdir(), "contract-resolver-"));
}

/** Writes one file inside `root`, creating its folders. */
function write(root: string, path: string, text: string): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** A function declaration every fixture can share. */
const WIDGET = "export function createWidget(name: string): void {}\n";

test("an alias to an ambiguous star target stays ambiguous from the entry", async () => {
  const root = site();
  try {
    write(root, "src/a.ts", "export function shared(value: string): void {}\n");
    write(root, "src/b.ts", "export function shared(value: string): void {}\n");
    write(root, "src/all.ts", 'export * from "./a.ts";\nexport * from "./b.ts";\n');
    write(root, "src/index.ts", 'export { shared as renamed } from "./all.ts";\n');

    const result = await resolveContractSymbol("src/index.ts", "renamed", { root });
    assert.equal(result.state, "ambiguous");
    if (result.state !== "ambiguous") return;
    assert.equal(result.file, "src/index.ts");
    assert.equal(result.name, "renamed");
    assert.deepEqual(result.candidates, ["src/a.ts", "src/b.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a star target that is itself ambiguous keeps the entry's name", async () => {
  const root = site();
  try {
    write(root, "src/a.ts", "export function shared(value: string): void {}\n");
    write(root, "src/b.ts", "export function shared(value: string): void {}\n");
    write(root, "src/all.ts", 'export * from "./a.ts";\nexport * from "./b.ts";\n');
    write(root, "src/index.ts", 'export * from "./all.ts";\n');

    const result = await resolveContractSymbol("src/index.ts", "shared", { root });
    assert.equal(result.state, "ambiguous");
    if (result.state !== "ambiguous") return;
    assert.deepEqual(result.candidates, ["src/a.ts", "src/b.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a star re-export of a package is unsupported, alone or beside a local module", async () => {
  const root = site();
  try {
    write(root, "src/a.ts", "export function local(value: string): void {}\n");
    write(root, "src/only.ts", 'export * from "@scope/pkg";\n');
    write(root, "src/mixed.ts", 'export * from "@scope/pkg";\nexport * from "./a.ts";\n');

    const only = await resolveContractSymbol("src/only.ts", "remote", { root });
    assert.equal(only.state, "unsupported");
    if (only.state !== "unsupported") return;
    assert.equal(only.file, "src/only.ts");
    assert.match(only.reason, /not a local module/);

    const mixed = await resolveContractSymbol("src/mixed.ts", "local", { root });
    assert.equal(mixed.state, "ambiguous");
    if (mixed.state !== "ambiguous") return;
    assert.deepEqual(mixed.candidates, ["@scope/pkg", "src/a.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a star re-export target that cannot be read is unsupported", async () => {
  const root = site();
  try {
    write(root, "src/index.ts", 'export * from "./absent.ts";\n');
    const result = await resolveContractSymbol("src/index.ts", "anything", { root });
    assert.equal(result.state, "unsupported");
    if (result.state !== "unsupported") return;
    assert.equal(result.file, "src/index.ts");
    assert.match(result.reason, /cannot be read/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("JavaScript specifiers resolve to their TypeScript files", async () => {
  const root = site();
  try {
    write(root, "src/widget.ts", WIDGET);
    write(root, "src/widget.tsx", WIDGET);
    write(root, "src/widget.mts", WIDGET);
    write(root, "src/widget.cts", WIDGET);
    write(root, "src/folder/index.ts", WIDGET);

    const cases: Array<[string, string]> = [
      ["./widget.js", "src/widget.ts"],
      ["./widget.mjs", "src/widget.mts"],
      ["./widget.cjs", "src/widget.cts"],
      ["./folder", "src/folder/index.ts"],
    ];
    for (const [specifier, expected] of cases) {
      write(root, "src/index.ts", `export { createWidget } from "${specifier}";\n`);
      const result = await resolveContractSymbol("src/index.ts", "createWidget", { root });
      assert.equal(result.state, "resolved", specifier);
      if (result.state !== "resolved") continue;
      assert.equal(result.file, expected, specifier);
    }

    // A `.js` specifier falls back to `.tsx` when the `.ts` candidate does not exist.
    rmSync(join(root, "src/widget.ts"));
    write(root, "src/index.ts", 'export { createWidget } from "./widget.js";\n');
    const tsx = await resolveContractSymbol("src/index.ts", "createWidget", { root });
    assert.equal(tsx.state, "resolved");
    if (tsx.state === "resolved") assert.equal(tsx.file, "src/widget.tsx");

    // A `.jsx` specifier resolves its `.tsx` file.
    write(root, "src/index.ts", 'export { createWidget } from "./widget.jsx";\n');
    const jsx = await resolveContractSymbol("src/index.ts", "createWidget", { root });
    assert.equal(jsx.state, "resolved");
    if (jsx.state === "resolved") assert.equal(jsx.file, "src/widget.tsx");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a direct TypeScript specifier and an unknown extension behave differently", async () => {
  const root = site();
  try {
    write(root, "src/widget.ts", WIDGET);
    write(root, "src/index.ts", 'export { createWidget } from "./widget.ts";\n');
    const direct = await resolveContractSymbol("src/index.ts", "createWidget", { root });
    assert.equal(direct.state, "resolved");

    write(root, "src/index.ts", 'export { createWidget } from "./widget.json";\n');
    const unknown = await resolveContractSymbol("src/index.ts", "createWidget", { root });
    assert.equal(unknown.state, "unsupported");
    if (unknown.state === "unsupported") assert.match(unknown.reason, /cannot be read/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a re-export outside the root is refused even when the file exists", async () => {
  const root = site();
  const outside = mkdtempSync(join(tmpdir(), "contract-outside-"));
  try {
    write(outside, "widget.ts", WIDGET);
    write(root, "src/index.ts", `export { createWidget } from "${relative(join(root, "src"), join(outside, "widget.ts"))}";\n`);
    const result = await resolveContractSymbol("src/index.ts", "createWidget", { root });
    assert.equal(result.state, "unsupported");
    if (result.state !== "unsupported") return;
    assert.match(result.reason, /outside the site root/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("an entry that is missing, outside, not TypeScript, or unreadable is unsupported", async () => {
  const root = site();
  try {
    const missing = await resolveContractSymbol("src/missing.ts", "name", { root });
    assert.equal(missing.state, "unsupported");
    if (missing.state === "unsupported") assert.match(missing.reason, /Cannot read/);

    const outsideRoot = mkdtempSync(join(tmpdir(), "contract-outside-entry-"));
    try {
      write(outsideRoot, "widget.ts", WIDGET);
      const outside = await resolveContractSymbol(join(outsideRoot, "widget.ts"), "createWidget", { root });
      assert.equal(outside.state, "unsupported");
      if (outside.state === "unsupported") assert.match(outside.reason, /outside the site root/);
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
    }

    write(root, "src/readme.md", "# no types\n");
    const markdown = await resolveContractSymbol("src/readme.md", "name", { root });
    assert.equal(markdown.state, "unsupported");
    if (markdown.state === "unsupported") assert.match(markdown.reason, /not a TypeScript file/);

    mkdirSync(join(root, "src/folder.ts"));
    const directory = await resolveContractSymbol("src/folder.ts", "name", { root });
    assert.equal(directory.state, "unsupported");
    if (directory.state === "unsupported") assert.match(directory.reason, /Cannot read/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing root is still resolved from the path itself", async () => {
  const root = join(site(), "missing-root");
  try {
    const result = await resolveContractSymbol("src/index.ts", "name", { root });
    assert.equal(result.state, "unsupported");
    if (result.state === "unsupported") assert.match(result.reason, /Cannot read/);
  } finally {
    rmSync(dirname(root), { recursive: true, force: true });
  }
});

test("an absolute entry inside the root is shown relative", async () => {
  const root = site();
  try {
    write(root, "src/widget.ts", WIDGET);
    const result = await resolveContractSymbol(join(root, "src/widget.ts"), "createWidget", { root });
    assert.equal(result.state, "resolved");
    if (result.state === "resolved") assert.equal(result.file, "src/widget.ts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a syntax error, explicit cycle, and missing explicit target are reported", async () => {
  const root = site();
  try {
    write(root, "src/enum.ts", "export enum Color { Red }\n");
    write(root, "src/alias.ts", 'export { Color as Shade } from "./enum.ts";\n');
    const enumTarget = await resolveContractSymbol("src/alias.ts", "Shade", { root });
    assert.equal(enumTarget.state, "unsupported");
    if (enumTarget.state === "unsupported") assert.match(enumTarget.reason, /enum/);

    write(root, "src/bad.ts", "export function broken( {\n");
    const syntax = await resolveContractSymbol("src/bad.ts", "broken", { root });
    assert.equal(syntax.state, "unsupported");
    if (syntax.state === "unsupported") assert.match(syntax.reason, /Cannot parse/);

    write(root, "src/a.ts", 'export { loop } from "./b.ts";\n');
    write(root, "src/b.ts", 'export { loop } from "./a.ts";\n');
    const cycle = await resolveContractSymbol("src/a.ts", "loop", { root });
    assert.equal(cycle.state, "missing");

    write(root, "src/index.ts", 'export { absent } from "./a.ts";\n');
    const absent = await resolveContractSymbol("src/index.ts", "absent", { root });
    assert.equal(absent.state, "missing");
    if (absent.state === "missing") assert.equal(absent.file, "src/index.ts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("comments, strings, templates, and regular expressions before exports are not code", async () => {
  const root = site();
  try {
    write(root, "src/widget.ts", WIDGET);
    write(root, "src/index.ts", [
      "// export { fake } from \"./missing.ts\";",
      'const text = "export * from \\"./missing.ts\\"";',
      "const template = `export * from \"./missing.ts\"`;",
      "const pattern = /export\\s+\\*[^/]*\\/[a-z]+/g;",
      "/* export { fake } from \"./missing.ts\"; */",
      "export { createWidget } from \"./widget.ts\";",
      "const object = { export: 1 };",
      "const division = 10 / 2;",
      "const divided = (10) / 2;",
      "const escapedTemplate = `a \\` b`;",
      'export { "createWidget" as quoted } from "./widget.ts";',
      'export { type createWidget as typed } from "./widget.ts";',
    ].join("\n"));

    for (const name of ["createWidget", "quoted", "typed"]) {
      const result = await resolveContractSymbol("src/index.ts", name, { root });
      assert.equal(result.state, "resolved", name);
      if (result.state === "resolved") assert.equal(result.file, "src/widget.ts", name);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("comments inside an export list still find the module", async () => {
  const root = site();
  try {
    write(root, "src/widget.ts", WIDGET);
    write(root, "src/index.ts", [
      "export {",
      "  // the public name",
      "  createWidget as createWidget,",
      "  /* a block",
      "     comment } with a brace */",
      "} from \"./widget.ts\";",
    ].join("\n"));

    const result = await resolveContractSymbol("src/index.ts", "createWidget", { root });
    assert.equal(result.state, "resolved");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an export after a continued line and a leading regex is still found", async () => {
  const root = site();
  try {
    write(root, "src/widget.ts", WIDGET);
    write(root, "src/index.ts", [
      "/export/.test(\"export\");",
      "const combined = 1 +",
      "export { createWidget } from \"./widget.ts\";",
    ].join("\n"));

    const result = await resolveContractSymbol("src/index.ts", "createWidget", { root });
    assert.equal(result.state, "resolved");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an export after a same-line statement or a non-statement context is read only when valid", async () => {
  const root = site();
  try {
    write(root, "src/widget.ts", WIDGET);
    write(root, "src/index.ts", 'const before = 0;  export { createWidget } from "./widget.ts";\n');
    const sameLine = await resolveContractSymbol("src/index.ts", "createWidget", { root });
    assert.equal(sameLine.state, "resolved");

    write(root, "src/index.ts", [
      'const combined = 1 + export { createWidget } from "./widget.ts";',
      'export { createWidget } from "./widget.ts";',
    ].join("\n"));
    const continued = await resolveContractSymbol("src/index.ts", "createWidget", { root });
    assert.equal(continued.state, "resolved");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an empty export list and a local export list stay local", async () => {
  const root = site();
  try {
    write(root, "src/index.ts", 'export {};\nexport function createWidget(name: string): void {}\nexport { createWidget as local };\n');
    const direct = await resolveContractSymbol("src/index.ts", "createWidget", { root });
    assert.equal(direct.state, "resolved");

    const local = await resolveContractSymbol("src/index.ts", "local", { root });
    assert.equal(local.state, "resolved");
    if (local.state === "resolved") assert.equal(local.file, "src/index.ts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolution is deterministic", async () => {
  const root = site();
  try {
    write(root, "src/widget.ts", WIDGET);
    write(root, "src/index.ts", 'export { createWidget } from "./widget.ts";\n');
    assert.deepEqual(
      await resolveContractSymbol("src/index.ts", "createWidget", { root }),
      await resolveContractSymbol("src/index.ts", "createWidget", { root }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
