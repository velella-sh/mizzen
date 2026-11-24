/**
 * Type-checking examples against a fixture's real exports (#1327). The block is compiled with the project's TypeScript
 * in a temporary folder with the fixture copied beside it, and a type error is reported at the fence's span with the
 * symbol named.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { MarkdownExample } from "../src/markdown/plugins/example-fence.ts";
import {
  EXAMPLE_TYPE_ERROR_ID,
  relativeImportsOf,
  symbolOf,
  typeCheckable,
  typeCheckExample,
  typeProblemsOf,
} from "../src/examples/type-check.ts";

/** A temporary site with the fixture the test imports, removed by the caller. */
async function site(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "example-typecheck-"));
  await mkdir(join(root, "fixtures", "lib"), { recursive: true });
  await writeFile(join(root, "fixtures", "lib", "math.ts"), "export function add(a: number, b: number): number { return a + b; }\nexport const answer: string = 'ok';\n");
  return root;
}

function example(code: string, line = 10): MarkdownExample {
  return { id: "example-1", lang: "ts", code, expected: null, pos: { line, column: 1, endLine: line + 3, endColumn: 4 } };
}

test("only ts/js blocks that are not setup, teardown, or a step are type-checked", () => {
  assert.equal(typeCheckable("ts", undefined), true);
  assert.equal(typeCheckable("js", undefined), true);
  assert.equal(typeCheckable("bash", undefined), false);
  assert.equal(typeCheckable("ts", "setup"), false);
  assert.equal(typeCheckable("ts", "step"), false);
});

test("relative imports are read from the block, and absolute and package imports are ignored", () => {
  assert.deepEqual(relativeImportsOf('import { add } from "./fixtures/lib/math.ts";'), ["./fixtures/lib/math.ts"]);
  assert.deepEqual(relativeImportsOf('import { x } from "npm-package";'), []);
});

test("a type error is reported at the fence with the symbol named", async () => {
  const root = await site();
  try {
    const findings = await typeCheckExample({
      example: example('import { add } from "./fixtures/lib/math.ts";\nconst n: string = add(1, 2);'),
      root,
      sourceDir: root,
      file: "examples.md",
    });
    const error = findings.find((finding) => finding.id === EXAMPLE_TYPE_ERROR_ID);
    assert.ok(error, "the wrong assignment is a type error");
    assert.equal(error.severity, "error");
    assert.equal(error.pos.file, "examples.md");
    assert.equal(error.pos.line, 10);
    assert.match(error.message, /examples\.md:11/, "the error line is inside the block");
    assert.match(error.message, /Type 'number' is not assignable to type 'string'/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a block that type-checks against the fixture's real exports is clean", async () => {
  const root = await site();
  try {
    const findings = await typeCheckExample({
      example: example('import { add, answer } from "./fixtures/lib/math.ts";\nconst n: number = add(1, 2);\nconsole.log(n, answer);'),
      root,
      sourceDir: root,
      file: "examples.md",
    });
    assert.deepEqual(findings, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an import of a symbol the fixture does not export is a type error", async () => {
  const root = await site();
  try {
    const findings = await typeCheckExample({
      example: example('import { missing } from "./fixtures/lib/math.ts";\nconsole.log(missing);'),
      root,
      sourceDir: root,
      file: "examples.md",
    });
    assert.ok(findings.some((finding) => finding.id === EXAMPLE_TYPE_ERROR_ID));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the compiler output parser reads file(line,column) errors only", () => {
  const parsed = typeProblemsOf('guide.md(3,5): error TS2322: Type \'x\' is not assignable.\nwarning: ignore me\n');
  assert.deepEqual(parsed, [{ file: "guide.md", line: 3, column: 5, code: "TS2322", message: "Type 'x' is not assignable." }]);
});

test("the symbol is read from backticks or a `Cannot find name` message", () => {
  assert.equal(symbolOf("Cannot find name 'thing'."), "thing");
  assert.equal(symbolOf("Property `foo` does not exist."), "foo");
  assert.equal(symbolOf("A plain message."), undefined);
});
