import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main } from "../src/cli/index.ts";

/** A temporary source tree holding `files`. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "import-preview-"));
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

test("import plain writes nothing and reports destinations and manual items", async () => {
  const root = tree({
    "index.md": "# Home\n",
    "guide/intro.mdx": "# Intro\n",
    "logo.png": "\u0089PNG\r\n",
    "mizzen.yml": "title: Source\n",
    "notes.txt": "not an input\n",
  });
  const before = snapshot(root);
  const logs: string[] = [];
  const errors: string[] = [];
  const status = await main(["import", "plain", root], {
    log: (message: string) => {
      logs.push(message);
    },
    error: (message: string) => {
      errors.push(message);
    },
  });

  assert.deepEqual(snapshot(root), before);
  assert.deepEqual(errors, []);
  assert.equal(status, 0);

  const report = logs.join("\n");
  assert.match(report, /^ {2}index\.md -> index\.md {2}\/$/m);
  assert.match(report, /^ {2}guide\/intro\.mdx -> guide\/intro\.md {2}\/guide\/intro\/$/m);
  assert.match(report, /^ {2}logo\.png -> logo\.png {2}\/logo\.png$/m);
  assert.match(report, /^ {2}mizzen\.yml -> mizzen\.yml$/m);
  assert.match(report, /^ {2}notes\.txt {2}\(not a Markdown page, a static file, or mizzen\.yml\)$/m);
  assert.match(report, /^Manual items:$/m);
  assert.match(report, /^ {2}guide\/intro\.mdx:1:1 {2}import\.mdx /m);
  assert.match(report, /^5 files: 2 content, 1 config, 1 asset, 1 unsupported\.$/m);
  assert.match(report, /^1 manual item, 0 errors\.$/m);
});

test("import plain reports each file's accuracy and what the conversion keeps", async () => {
  const root = tree({
    "index.md": "# Home\n\nSee [intro](./guide/intro.md) and [missing](./gone.md).\n",
    "guide/intro.md": "# Intro\n",
    "logo.png": "\u0089PNG\r\n",
    "notes.txt": "not an input\n",
  });
  const logs: string[] = [];
  const status = await main(["import", "plain", root], {
    log: (message: string) => {
      logs.push(message);
    },
    error: () => {},
  });

  assert.equal(status, 0);
  const report = logs.join("\n");
  assert.match(report, /^Accuracy:$/m);
  assert.match(report, /^ {2}4 files: 2 full, 1 approximate, 1 manual$/m);
  assert.match(report, /^ {2}guide\/intro\.md {2}full$/m);
  assert.match(report, /^ {2}index\.md {2}approximate$/m);
  assert.match(report, /^ {4}index\.md:3 {2}approximate {2}`\.\/gone\.md` names no imported page/m);
  assert.match(report, /^Coverage:$/m);
  assert.match(report, /^ {2}index\.md {2}blocks 1 -> 1, links 2 -> 1$/m);
  assert.match(report, /^ {2}logo\.png {2}assets 1 -> 1$/m);
  assert.match(report, /^ {2}notes\.txt {2}unsupported 1 -> 0$/m);
  assert.match(report, /^ {2}totals {2}blocks 2 -> 2, links 2 -> 1, assets 1 -> 1, unsupported 1 -> 0$/m);
});
