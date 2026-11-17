import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { readSourceRange } from "../../src/content/code-snippets/read.ts";

/** A temporary folder holding `files`; the caller removes it. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "code-snippets-read-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const SOURCE = "const one = 1;\nconst two = 2;\nconst three = 3;\nconst four = 4;\nconst five = 5;\n";

test("a valid range returns the lines with their 1-based inclusive bounds", async () => {
  const root = tree({ "example.ts": SOURCE });
  try {
    const result = await readSourceRange({ sourceDir: root, path: "example.ts", lines: "2-4" });
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(result.snippet, {
      file: "example.ts",
      start: 2,
      end: 4,
      text: "const two = 2;\nconst three = 3;\nconst four = 4;\n",
    });

    const whole = await readSourceRange({ sourceDir: root, path: "example.ts" });
    assert.equal(whole.snippet?.text, SOURCE);
    assert.deepEqual([whole.snippet?.start, whole.snippet?.end], [1, 5]);

    const one = await readSourceRange({ sourceDir: root, path: "example.ts", lines: "5" });
    assert.equal(one.snippet?.text, "const five = 5;\n");
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("a missing file is one error at the insertion point, with no lines", async () => {
  const root = tree({});
  const pos = { file: "guide.md", line: 7, column: 1, endLine: 7, endColumn: 20 };
  try {
    const result = await readSourceRange({ sourceDir: root, path: "nope.ts", pos });
    assert.equal(result.snippet, undefined);
    assert.equal(result.diagnostics.length, 1);
    const [diagnostic] = result.diagnostics;
    assert.equal(diagnostic?.id, "snippet.missing");
    assert.equal(diagnostic?.severity, "error");
    assert.deepEqual(diagnostic?.pos, pos);
    assert.match(diagnostic?.message ?? "", /nope\.ts does not exist/);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("a malformed range and a range past the end of the file are different failures", async () => {
  const root = tree({ "example.ts": SOURCE });
  try {
    for (const lines of ["4-2", "zero", "0-1"]) {
      const result = await readSourceRange({ sourceDir: root, path: "example.ts", lines });
      assert.deepEqual(
        result.diagnostics.map((diagnostic) => diagnostic.id),
        ["snippet.invalid-lines"],
        lines,
      );
      assert.equal(result.snippet, undefined);
    }

    const past = await readSourceRange({ sourceDir: root, path: "example.ts", lines: "4-9" });
    assert.equal(past.diagnostics[0]?.id, "snippet.lines-out-of-range");
    assert.match(past.diagnostics[0]?.message ?? "", /which has 5 lines/);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("a path outside the source folder is refused before it is read", async () => {
  const base = mkdtempSync(join(tmpdir(), "code-snippets-read-outside-"));
  const root = join(base, "site");
  mkdirSync(root);
  writeFileSync(join(base, "secret.ts"), "export const secret = true;\n");
  try {
    const result = await readSourceRange({ sourceDir: root, path: "../secret.ts" });
    assert.equal(result.snippet, undefined);
    assert.equal(result.diagnostics[0]?.id, "snippet.outside-source");
    assert.doesNotMatch(result.diagnostics[0]?.message ?? "", /secret = true/);
  } finally {
    rmSync(base, { recursive: true });
  }
});

test("a symbolic link cannot carry a snippet outside the source folder", async () => {
  const base = mkdtempSync(join(tmpdir(), "code-snippets-read-link-"));
  const root = join(base, "site");
  mkdirSync(root);
  const outside = join(base, "outside.ts");
  writeFileSync(outside, "outside\n");
  symlinkSync(outside, join(root, "leak.ts"));
  try {
    const result = await readSourceRange({ sourceDir: root, path: "leak.ts" });
    assert.equal(result.snippet, undefined);
    assert.equal(result.diagnostics[0]?.id, "snippet.outside-source");
    assert.match(result.diagnostics[0]?.message ?? "", /symbolic link/);
  } finally {
    rmSync(base, { recursive: true });
  }
});

test("a folder and an empty path are reported, not thrown", async () => {
  const root = tree({ "folder/file.ts": SOURCE });
  try {
    const folder = await readSourceRange({ sourceDir: root, path: "folder" });
    assert.equal(folder.diagnostics[0]?.id, "snippet.unreadable");
    assert.equal(folder.snippet, undefined);

    const empty = await readSourceRange({ sourceDir: root, path: "  " });
    assert.equal(empty.diagnostics[0]?.id, "snippet.no-path");
  } finally {
    rmSync(root, { recursive: true });
  }
});
