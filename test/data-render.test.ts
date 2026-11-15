import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "../src/pipeline/build.ts";
import { site } from "./data-record-site.ts";

const FILES = {
  "mizzen.yml":
    "collections:\n" +
    "  components:\n" +
    "    source: _data/components.yml\n" +
    "    template: _templates/components.md\n" +
    "    permalink: /components/{id}/\n",
  "_data/components.yml": "- id: button\n  name: Button\n- id: input\n  name: Input\n",
  "_templates/components.md": "---\ntitle: \"{name}\"\n---\n# :field[name]\n",
};

/** A theme with a `doc` and a `record` layout; the record layout prints the props it receives. */
function theme(withRecord: boolean): string {
  const root = mkdtempSync(join(tmpdir(), "data-render-theme-"));
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "data-theme", type: "module" }),
    "src/index.ts": 'export const theme = { name: "data-theme", folders: ["layouts"] };\n',
    "layouts/doc.ts":
      "export default function doc({ page }) {\n  return `<!DOCTYPE html>\\n<html lang=\"en\"><body>${page.html}</body></html>\\n`;\n}\n",
  };
  if (withRecord) {
    files["layouts/record.ts"] =
      "export default function record({ page, record }) {\n" +
      "  const fields = record ? Object.keys(record.fields).sort().join(\",\") : \"none\";\n" +
      "  return `<!DOCTYPE html>\\n<html lang=\"en\"><body>${page.html}<p id=\"record\">${record?.collection}/${record?.id} ${record?.url} ${fields}</p></body></html>\\n`;\n" +
      "}\n";
  }
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

test("a record page reaches the layout as props, the same with one worker and with four", async () => {
  const root = site(FILES);
  const themeRoot = theme(true);
  const parent = mkdtempSync(join(tmpdir(), "data-render-out-"));
  try {
    const one = await build({ root, out: join(parent, "one"), themeRoot, defaultLayout: "doc" });
    const four = await build({ root, out: join(parent, "four"), themeRoot, defaultLayout: "doc", workers: 4 });
    assert.deepEqual(four.diagnostics, one.diagnostics);
    const serial = readFileSync(join(parent, "one/components/button/index.html"), "utf8");
    const parallel = readFileSync(join(parent, "four/components/button/index.html"), "utf8");
    assert.equal(parallel, serial);
    assert.match(serial, /components\/button \/components\/button\/ id,name/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(themeRoot, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a theme without the record layout is one error, not one per page", async () => {
  const root = site(FILES);
  const themeRoot = theme(false);
  const parent = mkdtempSync(join(tmpdir(), "data-render-out-"));
  try {
    const result = await build({ root, out: join(parent, "site"), themeRoot, defaultLayout: "doc" });
    const unknown = result.diagnostics.filter((diagnostic) => diagnostic.id === "render.unknown-layout");
    assert.equal(unknown.length, 1);
    assert.match(unknown[0]!.message, /"record"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(themeRoot, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});
