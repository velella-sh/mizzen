import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** Every file under `dir`, relative with `/`, sorted by path. */
function filesOf(dir: string, base = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = base === "" ? entry.name : `${base}/${entry.name}`;
    if (entry.isDirectory()) out.push(...filesOf(join(dir, entry.name), path));
    else out.push(path);
  }
  return out.sort();
}

const CANARY = "canary-value-898";

test("no public output of a policy-bearing site contains a private canary", async () => {
  const parent = mkdtempSync(join(tmpdir(), "public-canary-"));
  try {
    const theme = join(parent, "theme");
    tree(theme, {
      "src/index.ts": 'export const theme = { name: "t", folders: ["layouts"] };\n',
      "layouts/doc.ts": "export default (p: any) => `<html><body>${p.page.html}</body></html>`;\n",
    });
    const site = join(parent, "site");
    tree(site, {
      "mizzen.yml": [
        "title: Canary",
        "url: https://example.test",
        "collections:",
        "  people:",
        "    source: _data/people.yml",
        "    template: _templates/person.md",
        "    permalink: /people/{id}/",
        "    dates: [date]",
        "    public: [title, date]",
        "    index:",
        "      fields: [title, secret]",
        "    changelog:",
        "      pages: true",
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
      ].join("\n"),
      "_data/people.yml": ["- id: ada", "  title: Ada", "  date: 2024-01-01", `  secret: ${CANARY}`, ""].join("\n"),
      "_templates/person.md": [
        "---",
        "title: Ada",
        "layout: doc",
        "---",
        "",
        ":field[title]",
        "",
        ":field[secret]",
        "",
        ":::changes",
        ":field[new]",
        ":::",
        "",
      ].join("\n"),
      "data-changes/people.jsonl":
        `{"id":"0123456789abcdef","type":"changed","record":"ada","field":"secret","old":"old","new":"${CANARY}","date":"2024-01-02"}\n`,
      "index.md": ["---", "title: Home", "layout: doc", "---", "", "Hello", ""].join("\n"),
    });
    const out = join(parent, "out");
    const result = await build({ root: site, out, themeRoot: theme, defaultLayout: "doc" });

    // The fixture is real: the value is rejected before publication, so the build says why.
    const errors = result.diagnostics.filter((finding) => finding.severity === "error");
    assert.ok(errors.some((finding) => finding.id === "data.public-reference"));
    assert.ok(errors.some((finding) => finding.id === "api.private-field"));

    const leaks = filesOf(out).filter((path) => readFileSync(join(out, path), "utf8").includes(CANARY));
    assert.deepEqual(leaks, [], `the canary leaked into: ${leaks.join(", ")}`);

    // The site still published the public value, so the scan is not passing on an empty build.
    assert.match(readFileSync(join(out, "people/ada/index.html"), "utf8"), /Ada/);
    assert.ok(filesOf(out).some((path) => path.startsWith("pagefind/")), "search output exists");
    assert.ok(filesOf(out).some((path) => path.startsWith("changes/people/")), "changelog output exists");
    assert.ok(filesOf(out).some((path) => path.startsWith("api/v1/")), "API output exists");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
