/** Acceptance for #520: a release-line date reaches its page, its timeline, the feed, and its page JSON, and the record URLs stay the same. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "../../src/pipeline/build.ts";

const THEME = fileURLToPath(new URL("../../../lateen", import.meta.url));

const CONFIG = [
  "title: Relations",
  "url: https://example.test",
  "collections:",
  "  products:",
  "    source: _data/products.yml",
  "    template: _templates/products.md",
  "    permalink: /products/{id}/",
  "    references:",
  "      rule: rules",
  "  release-lines:",
  "    source: _data/release-lines.yml",
  "    template: _templates/release-lines.md",
  "    permalink: /releases/{id}/",
  "    dates: [date]",
  "    references:",
  "      product: products",
  "      rules: rules",
  "  rules:",
  "    source: _data/rules.yml",
  "    template: _templates/rules.md",
  "    permalink: /rules/{id}/",
  "feeds:",
  "  releases:",
  "    collection: release-lines",
  "    date: date",
  "    formats: [atom]",
  "redirects:",
  "  /releases/old-rel-1/: /releases/rel-1/",
  "",
].join("\n");

const FILES = {
  "mizzen.yml": CONFIG,
  "_data/products.yml": "- id: starling\n  name: Starling\n  rule: hold\n",
  "_data/release-lines.yml":
    "- id: rel-2\n  product: starling\n  rules: [hold]\n  date: 2026-02-10\n" +
    "- id: rel-1\n  product: starling\n  rules: [draft, hold]\n  date: 2026-01-10\n",
  "_data/rules.yml": "- id: draft\n  title: Draft\n- id: hold\n  title: Hold\n",
  "_templates/products.md": '---\nlayout: doc\ntitle: "{name}"\n---\n# :field[name]\n',
  "_templates/release-lines.md": '---\nlayout: doc\ntitle: "Release {id}"\n---\n# :field[id]\n\nReleased :field[date].\n',
  "_templates/rules.md": '---\nlayout: doc\ntitle: "{title}"\n---\n# :field[title]\n',
  "releases/index.md":
    "---\nlayout: doc\ntitle: Releases\nlist:\n  collection: release-lines\n  sort: [date desc]\n  fields: [id, date]\n---\n# Releases\n",
} as const;

/** A temporary site from a path-to-text map; the caller removes it. */
function tree(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "relations-acceptance-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** Every record's page URL, from the collection JSON a build writes. */
function urlsOf(out: string): Map<string, string> {
  const urls = new Map<string, string>();
  for (const collection of ["products", "release-lines", "rules"]) {
    const body = JSON.parse(readFileSync(join(out, `data/${collection}.json`), "utf8")) as {
      records: readonly { id: string; url: string }[];
    };
    for (const record of body.records) urls.set(`${collection}/${record.id}`, record.url);
  }
  return urls;
}

/** The Atom entry for `id`, or a failure naming what the feed held. */
function atomEntry(xml: string, id: string): string {
  const entry = xml.split("<entry>").find((block) => block.includes(`/releases/${id}/`));
  assert.ok(entry, `no Atom entry links to /releases/${id}/`);
  return entry;
}

test("a changed release date reaches the page, the timeline, the feed, and the page JSON, and the URLs stay", async () => {
  const root = tree(FILES);
  const parent = mkdtempSync(join(tmpdir(), "relations-acceptance-out-"));
  try {
    const first = await build({ root, out: join(parent, "first"), themeRoot: THEME, defaultLayout: "doc" });
    assert.deepEqual(first.diagnostics.filter((diagnostic) => diagnostic.severity === "error"), []);
    const firstOut = join(parent, "first");
    const urls = urlsOf(firstOut);
    assert.equal(urls.get("release-lines/rel-1"), "/releases/rel-1/");
    assert.equal(urls.get("products/starling"), "/products/starling/");
    assert.equal(urls.get("rules/hold"), "/rules/hold/");

    assert.match(readFileSync(join(firstOut, "releases/rel-1/index.html"), "utf8"), /2026-01-10/);
    const firstTimeline = readFileSync(join(firstOut, "releases/index.md"), "utf8");
    assert.ok(firstTimeline.indexOf("2026-02-10") < firstTimeline.indexOf("2026-01-10"), "the timeline is newest first");
    assert.match(firstTimeline, /\| \[rel-1\]\(\/releases\/rel-1\/\) \| 2026-01-10 \|/);
    assert.match(atomEntry(readFileSync(join(firstOut, "feeds/releases.xml"), "utf8"), "rel-1"), /2026-01-10T00:00:00\.000Z/);
    assert.equal(
      (JSON.parse(readFileSync(join(firstOut, "releases/rel-1/index.json"), "utf8")) as { record: { fields: { date: string } } })
        .record.fields.date,
      "2026-01-10",
    );

    const file = join(root, "_data/release-lines.yml");
    writeFileSync(file, readFileSync(file, "utf8").replace("date: 2026-01-10", "date: 2026-03-10"));

    const second = await build({ root, out: join(parent, "second"), themeRoot: THEME, defaultLayout: "doc" });
    assert.deepEqual(second.diagnostics.filter((diagnostic) => diagnostic.severity === "error"), []);
    const secondOut = join(parent, "second");
    assert.deepEqual(urlsOf(secondOut), urls, "every record keeps the URL it had before the date changed");

    assert.match(readFileSync(join(secondOut, "releases/rel-1/index.html"), "utf8"), /2026-03-10/);
    const timeline = readFileSync(join(secondOut, "releases/index.md"), "utf8");
    assert.ok(timeline.indexOf("2026-03-10") < timeline.indexOf("2026-02-10"), "the timeline follows the new date");
    assert.match(timeline, /\| \[rel-1\]\(\/releases\/rel-1\/\) \| 2026-03-10 \|/);
    assert.match(atomEntry(readFileSync(join(secondOut, "feeds/releases.xml"), "utf8"), "rel-1"), /2026-03-10T00:00:00\.000Z/);
    assert.equal(
      (JSON.parse(readFileSync(join(secondOut, "releases/rel-1/index.json"), "utf8")) as { record: { fields: { date: string } } })
        .record.fields.date,
      "2026-03-10",
    );
    assert.deepEqual(
      (
        JSON.parse(readFileSync(join(secondOut, "releases/index.json"), "utf8")) as { list: { records: readonly string[] } }
      ).list.records,
      ["rel-1", "rel-2"],
    );

    assert.match(readFileSync(join(secondOut, "_redirects"), "utf8"), /^\/releases\/old-rel-1\/ https:\/\/example\.test\/releases\/rel-1\/ 301$/m);
    assert.match(
      readFileSync(join(secondOut, "releases/old-rel-1/index.html"), "utf8"),
      /content="0; url=https:\/\/example\.test\/releases\/rel-1\/"/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});
