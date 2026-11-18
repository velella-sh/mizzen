import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { build } from "../src/pipeline/build.ts";

/** Writes `files` under `root`, creating their folders. */
function tree(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

const CANARY = "canary-value-898";

const siteFiles = (publicLine: string): Record<string, string> => ({
  "mizzen.yml": [
    "title: Canary",
    "url: https://example.test",
    "outputs:",
    "  search: false",
    "collections:",
    "  people:",
    "    source: _data/people.yml",
    "    template: _templates/person.md",
    "    permalink: /people/{id}/",
    "    dates: [date]",
    publicLine,
    "    index:",
    "      fields: [title, secret]",
    "api:",
    "  collections:",
    "    people:",
    "      fields: [title, date, secret]",
    "feeds:",
    "  people:",
    "    collection: people",
    "    date: date",
    "    fields: [title, secret]",
    "",
  ]
    .filter((line) => line !== "")
    .join("\n"),
  "_data/people.yml": ["- id: ada", "  title: Ada", "  date: 2024-01-01", `  secret: ${CANARY}`, ""].join("\n"),
  "_templates/person.md": ["---", "title: Ada", "layout: doc", "---", "", ":field[title]", "", ":field[secret]", ""].join("\n"),
  "index.md": ["---", "title: Home", "layout: doc", "---", "", "Hello", ""].join("\n"),
});

test("a field that becomes private is rewritten out of every managed file", async () => {
  const parent = mkdtempSync(join(tmpdir(), "public-transition-"));
  try {
    const theme = join(parent, "theme");
    tree(theme, {
      "src/index.ts": 'export const theme = { name: "t", folders: ["layouts"] };\n',
      "layouts/doc.ts": "export default (p: any) => `<html><body>${p.page.html}</body></html>`;\n",
    });
    const site = join(parent, "site");
    tree(site, siteFiles("    public: [title, date]"));
    const out = join(parent, "out");

    // First build: no policy, so the canary reaches every public file.
    tree(site, siteFiles(""));
    await build({ root: site, out, themeRoot: theme, defaultLayout: "doc" });
    for (const path of [
      "data/people.raw.json",
      "data/people.csv",
      "data/people.index.json",
      "people/ada/index.html",
      "people/ada/index.json",
      "api/v1/people.json",
      "api/v1/people/ada.json",
      "llms-full.txt",
    ]) {
      assert.ok(readFileSync(join(out, path), "utf8").includes(CANARY), path);
    }

    // Second build: the same folder, with the field private. Managed files are replaced, not appended to.
    tree(site, siteFiles("    public: [title, date]"));
    const result = await build({ root: site, out, themeRoot: theme, defaultLayout: "doc" });
    const errors = result.diagnostics.filter((finding) => finding.severity === "error");
    assert.ok(errors.some((finding) => finding.id === "data.public-reference"), "the feed reference is rejected");
    assert.ok(errors.some((finding) => finding.id === "api.private-field"), "the API field is rejected");
    for (const path of [
      "data/people.raw.json",
      "data/people.csv",
      "data/people.index.json",
      "people/ada/index.html",
      "people/ada/index.json",
      "api/v1/people.json",
      "api/v1/people/ada.json",
      "llms-full.txt",
    ]) {
      assert.ok(existsSync(join(out, path)), path);
      assert.equal(readFileSync(join(out, path), "utf8").includes(CANARY), false, path);
    }
    const apiIndex = JSON.parse(readFileSync(join(out, "api/v1/index.json"), "utf8")) as { collections: { fields: string[] }[] };
    assert.deepEqual(apiIndex.collections[0]!.fields, ["title", "date"]);
    assert.equal(readFileSync(join(out, "people/ada/index.html"), "utf8").includes("Ada"), true);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
