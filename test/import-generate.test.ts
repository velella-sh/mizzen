import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main } from "../src/cli/index.ts";

/** A temporary folder holding `files`. */
function tree(files: Record<string, string | Uint8Array>): string {
  const root = mkdtempSync(join(tmpdir(), "import-generate-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** Every file below `root` with its exact bytes, so a write anywhere shows up as a difference. */
function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const path of readdirSync(root, { recursive: true, encoding: "utf8" })) {
    const absolute = join(root, path);
    if (statSync(absolute).isFile()) files[path] = readFileSync(absolute).toString("base64");
  }
  return files;
}

function capture() {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    io: {
      log: (message: string) => {
        logs.push(message);
      },
      error: (message: string) => {
        errors.push(message);
      },
    },
  };
}

test("import plain --out writes the mapped project into an empty folder and leaves the source alone", async () => {
  const root = tree({
    "index.md": "# Home\n",
    "guide/intro.mdx": "# Intro\n",
    "logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    "mizzen.yml": "title: Source\n",
  });
  const out = mkdtempSync(join(tmpdir(), "import-generated-"));
  const before = snapshot(root);
  const { logs, errors, io } = capture();
  const status = await main(["import", "plain", root, "--out", out], io);

  assert.deepEqual(errors, []);
  assert.equal(status, 0);
  assert.deepEqual(snapshot(root), before);
  assert.deepEqual(readdirSync(out, { recursive: true, encoding: "utf8" }).sort(), [
    ".mizzen-import.json",
    "guide",
    "guide/intro.md",
    "index.md",
    "logo.png",
    "mizzen.yml",
  ]);
  assert.equal(readFileSync(join(out, "index.md"), "utf8"), "# Home\n");
  assert.equal(readFileSync(join(out, "guide/intro.md"), "utf8"), "# Intro\n");
  assert.equal(readFileSync(join(out, "mizzen.yml"), "utf8"), "title: Source\n");
  assert.deepEqual(readFileSync(join(out, "logo.png")), readFileSync(join(root, "logo.png")));
  assert.deepEqual(JSON.parse(readFileSync(join(out, ".mizzen-import.json"), "utf8")), {
    version: 1,
    files: [
      { source: "guide/intro.mdx", kind: "content", destination: "guide/intro.md", url: "/guide/intro/" },
      { source: "index.md", kind: "content", destination: "index.md", url: "/" },
      { source: "logo.png", kind: "asset", destination: "logo.png", url: "/logo.png" },
      { source: "mizzen.yml", kind: "config", destination: "mizzen.yml" },
    ],
    accuracy: {
      files: [
        {
          source: "guide/intro.mdx",
          destination: "guide/intro.md",
          status: "approximate",
          blocks: [
            {
              line: 1,
              status: "approximate",
              note: "copied as Markdown; its JSX components need a person to convert them",
            },
          ],
        },
        { source: "index.md", destination: "index.md", status: "full", blocks: [{ line: 1, status: "full" }] },
        { source: "logo.png", destination: "logo.png", status: "full", blocks: [{ line: 1, status: "full" }] },
        { source: "mizzen.yml", destination: "mizzen.yml", status: "full", blocks: [{ line: 1, status: "full" }] },
      ],
      counts: {
        files: { full: 3, approximate: 1, manual: 0 },
        blocks: { full: 3, approximate: 1, manual: 0 },
      },
    },
  });
  assert.match(logs.join("\n"), /wrote 5 files|5 files written/);
});

test("import plain --out rewrites internal page links and reports the ones it cannot resolve", async () => {
  const root = tree({
    "index.md": "[intro](./guide/intro.mdx?tab=1#install) and [site](https://example.com/x.md)\n",
    "guide/intro.mdx": "# Intro\n",
    "guide/setup.md": "[intro](./intro.mdx) and [missing](./gone.md)\n",
  });
  const out = mkdtempSync(join(tmpdir(), "import-generated-"));
  const { logs, io } = capture();
  const status = await main(["import", "plain", root, "--out", out], io);

  assert.equal(status, 0);
  assert.equal(
    readFileSync(join(out, "index.md"), "utf8"),
    "[intro](/guide/intro.md?tab=1#install) and [site](https://example.com/x.md)\n",
  );
  assert.equal(readFileSync(join(out, "guide/setup.md"), "utf8"), "[intro](/guide/intro.md) and [missing](./gone.md)\n");
  assert.match(logs.join("\n"), /guide\/setup\.md:1:26 {2}import\.unresolved-link/);
});

test("import plain --out refuses a non-empty destination and writes nothing", async () => {
  const root = tree({ "index.md": "# Home\n" });
  const out = tree({ "keep.txt": "already here\n", "nested/other.txt": "also here\n" });
  const before = snapshot(out);
  const { logs, errors, io } = capture();
  const status = await main(["import", "plain", root, "--out", out], io);

  assert.equal(status, 1);
  assert.deepEqual(errors, []);
  assert.equal(logs.join("\n").includes(join(out, "keep.txt")), true);
  assert.deepEqual(snapshot(out), before);
});

test("import plain --out refuses a conflicting file and leaves the destination byte-identical", async () => {
  const root = tree({ "index.md": "# Imported\n", "guide/intro.md": "# Intro\n" });
  const out = tree({ "index.md": "# Existing\n" });
  const before = snapshot(out);
  const { logs, errors, io } = capture();
  const status = await main(["import", "plain", root, "--out", out], io);

  assert.equal(status, 1);
  assert.deepEqual(errors, []);
  assert.equal(logs.join("\n").includes(join(out, "index.md")), true);
  assert.deepEqual(snapshot(out), before);
  assert.equal(readFileSync(join(out, "index.md"), "utf8"), "# Existing\n");
});

test("import plain --out refuses the source folder itself", async () => {
  const root = tree({ "index.md": "# Home\n" });
  const before = snapshot(root);
  const { errors, io } = capture();
  const status = await main(["import", "plain", root, "--out", root], io);

  assert.equal(status, 1);
  assert.deepEqual(errors, []);
  assert.deepEqual(snapshot(root), before);
});
