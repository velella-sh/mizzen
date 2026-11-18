import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main } from "../src/cli/index.ts";

/** A temporary source tree holding `files`. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "import-cli-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
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

test("import plain previews each destination and the MDX warning", async () => {
  const root = tree({
    "index.md": "# Home\n",
    "notes.mdx": "# Notes\n",
    "logo.png": "",
    "mizzen.yml": "title: Source\n",
    "notes.txt": "not an input\n",
  });
  const { logs, errors, io } = capture();
  const status = await main(["import", "plain", root], io);
  assert.deepEqual(errors, []);
  assert.equal(status, 0);
  const report = logs.join("\n");
  assert.ok(report.startsWith(`plain import of ${root} (preview; nothing is written)\n`));
  assert.match(report, /^ {2}index\.md -> index\.md {2}\/$/m);
  assert.match(report, /^ {2}notes\.mdx -> notes\.md {2}\/notes\/$/m);
  assert.match(report, /^ {2}logo\.png -> logo\.png {2}\/logo\.png$/m);
  assert.match(report, /^ {2}mizzen\.yml -> mizzen\.yml$/m);
  assert.match(report, /^ {2}notes\.mdx:1:1 {2}import\.mdx {2}copied as Markdown; its JSX components need a person to convert them$/m);
  assert.match(report, /^5 files: 2 content, 1 config, 1 asset, 1 unsupported\.$/m);
  assert.match(report, /^1 manual item, 0 errors\.$/m);
});

test("import with an unknown importer exits 2", async () => {
  const root = tree({ "index.md": "# Home\n" });
  const { logs, errors, io } = capture();
  const status = await main(["import", "docusaurus", root], io);
  assert.equal(status, 2);
  assert.deepEqual(logs, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /unknown importer: docusaurus; choose plain/);
});

test("import usage errors exit 2 and print the help", async () => {
  const { errors, io } = capture();
  assert.equal(await main(["import"], io), 2);
  assert.match(errors.join("\n"), /import needs an importer name/);
  assert.equal(await main(["import", "plain", "a", "b"], io), 2);
  assert.match(errors.join("\n"), /unexpected argument: b/);
});
