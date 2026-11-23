import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main } from "../src/cli/index.ts";
import type { RecordedExampleResult } from "../src/contracts/index.ts";
import { EXAMPLES_LOCK_FILE, readExamplesLock } from "../src/examples/pinned.ts";
import { build } from "../src/pipeline/build.ts";
import { sandboxAvailable } from "../src/pipeline/examples/run-shell.ts";

const COMMIT = "a".repeat(40);
const DATE = "2026-11-23";
const MARKDOWN = [
  "# Example results",
  "```js test\nconsole.log('hello');\n```",
  "```output\nhello\n```",
  "```js test\nthrow new Error('expected failure');\n```",
  "::include[_snippets/example.md]",
].join("\n\n");

test("an explicit run records fence results; cached and worker builds expose only pinned evidence", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "pinned-examples-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "site");
  const themeRoot = join(parent, "theme");
  const out = join(parent, "out");
  await mkdir(root);
  await mkdir(join(themeRoot, "layouts"), { recursive: true });
  await mkdir(join(themeRoot, "src"));
  await writeFile(join(themeRoot, "src", "index.ts"), 'export const theme = { name: "examples", folders: ["layouts"] };');
  await writeFile(join(themeRoot, "layouts", "doc.ts"), `
    export default ({ page }) =>
      '<html><head></head><body>' + page.html + '<aside>' +
      JSON.stringify(Object.fromEntries(Object.entries(page.examples ?? {}).map(
        ([id, result]) => [id, result.status]
      ))) + '</aside></body></html>';
  `);
  await writeFile(join(root, "mizzen.yml"), [
    "title: Examples", "search: false", "examples:", "  pinned: true", "  failOnFailure: true",
  ].join("\n"));
  await mkdir(join(root, "_snippets"));
  await writeFile(join(root, "_snippets", "example.md"), "```python test\nprint('not run');\n```\n");
  const source = join(root, "index.md");
  await writeFile(source, MARKDOWN);
  const settings = { root, themeRoot, out, cache: true, defaultLayout: "doc", basePath: "/preview", workers: 2 };
  const html = () => readFile(join(out, "index.html"), "utf8");
  const report = async () => JSON.parse(await readFile(join(out, "examples.json"), "utf8")) as {
    version: number;
    pages: Array<{ url: string; total: number; passed: number; failed: number; skipped: number }>;
    examples: Record<string, Record<string, RecordedExampleResult>>;
  };
  const initial = await build(settings);
  assert.ok(!initial.diagnostics.some(({ id }) => id === "example-failed" || id === "example-sandbox"));
  assert.match(await html(), /<aside>\{\}<\/aside>/);
  assert.deepEqual((await report()).pages, [{ url: "/preview/", total: 3, passed: 0, failed: 0, skipped: 3 }]);

  const record = () => main(["examples", "record", root, "--date", DATE, "--commit", COMMIT], {
    log: () => {}, error: () => {},
  });
  assert.equal(await record(), 1);
  const lockFile = join(root, EXAMPLES_LOCK_FILE);
  const firstLock = await readFile(lockFile, "utf8");
  const lock = (await readExamplesLock(root))!.lock;
  const entries = lock.examples["/"]!;
  const sandbox = sandboxAvailable();
  assert.equal(entries["example-1"]?.status, sandbox ? "passed" : "sandbox-unavailable");
  assert.equal(entries["example-2"]?.status, sandbox ? "failed" : "sandbox-unavailable");
  assert.equal(entries["example-3"]?.status, "skipped");
  assert.equal(entries["example-3"]?.file, "_snippets/example.md");
  assert.equal(entries["example-3"]?.line, 1);
  assert.deepEqual(entries["example-1"], {
    status: sandbox ? "passed" : "sandbox-unavailable",
    file: "index.md", line: 3, language: "js", date: DATE, commit: COMMIT,
    sha256: entries["example-1"]?.sha256,
  });

  const recorded = await build(settings);
  assert.ok(!recorded.diagnostics.some(({ id }) => id === "render.worker-failed"));
  assert.equal(recorded.diagnostics.find(({ id }) => id === "example-failed")?.severity, sandbox ? "error" : undefined);
  const rendered = await html();
  assert.deepEqual([...rendered.matchAll(/data-example-id="([^"]+)"/g)].map((match) => match[1]), Object.keys(entries));
  assert.ok(rendered.includes(`"example-1":"${entries["example-1"]?.status}"`));
  const published = await report();
  assert.equal(published.version, 1);
  assert.deepEqual(Object.keys(published.pages[0]!), ["url", "total", "passed", "failed", "skipped"]);
  assert.deepEqual(published.pages[0], {
    url: "/preview/", total: 3, passed: sandbox ? 1 : 0, failed: sandbox ? 1 : 0, skipped: sandbox ? 1 : 3,
  });
  assert.deepEqual(published.examples["/preview/"], entries);

  const moved = "A paragraph above the fences.\n\n" + MARKDOWN;
  await writeFile(source, moved);
  await build(settings);
  assert.deepEqual((await report()).examples, published.examples, "prose edits preserve fence identities and results");

  await writeFile(source, moved.replace("\nhello\n", "\nchanged expectation\n") +
    "\n\n```js test\nthrow new Error('must never run in a build');\n```\n");
  const edited = await build(settings);
  const editedHtml = await html();
  assert.match(editedHtml, /"example-1":"stale"/);
  assert.doesNotMatch(editedHtml, /"example-4":/);
  assert.equal(edited.diagnostics.filter(({ id }) => id === "example-failed").length, sandbox ? 1 : 0);
  assert.deepEqual((await report()).pages, [{ url: "/preview/", total: 4, passed: 0, failed: sandbox ? 1 : 0, skipped: sandbox ? 3 : 4 }]);
  assert.equal(await readFile(lockFile, "utf8"), firstLock, "only the record command writes the lock");

  await writeFile(lockFile, JSON.stringify({ ...lock, version: 2 }));
  const malformed = await build(settings);
  assert.ok(malformed.diagnostics.some(({ id, severity }) => id === "examples.invalid-lock" && severity === "error"));
  assert.match(await html(), /<aside>\{\}<\/aside>/);
});
