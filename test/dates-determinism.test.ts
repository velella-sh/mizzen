import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { buildModel, type ModelResult } from "../src/model/build.ts";
import { pageAt, site } from "./data-record-site.ts";

/** A site with a date-dependent record page, a dated list, and a plain page. */
const FILES: Readonly<Record<string, string>> = {
  "mizzen.yml":
    "collections:\n" +
    "  releases:\n" +
    "    source: _data/releases.yml\n" +
    "    template: _templates/releases.md\n" +
    "    permalink: /releases/{id}/\n" +
    "    dates: [released]\n" +
    "    derived:\n" +
    "      daysLeft: { field: released, kind: days-left }\n",
  "_data/releases.yml":
    '- id: one\n  title: One\n  status: published\n  released: "2026-03-15"\n' +
    '- id: two\n  title: Two\n  status: published\n  released: "2026-07-01"\n',
  "_templates/releases.md":
    '---\ntitle: "{title}"\n---\nReleased: :field[released]{format=long}\n\nDays left: :field[daysLeft]\n',
  "coming/index.md":
    "---\ntitle: Coming\nlist:\n  collection: releases\n  where:\n    released: { after: reference }\n---\n# Coming\n",
  "plain/index.md": "---\ntitle: Plain\n---\n# Plain\n\nNothing dated here.\n",
};

/** Every page's URL, dates marker, HTML, and Markdown, plus every diagnostic. */
function snapshot(result: ModelResult): unknown {
  return {
    pages: result.site.pages.map((page) => ({
      url: page.url,
      dates: page.dates ?? null,
      html: page.html,
      markdown: page.markdown,
    })),
    diagnostics: result.diagnostics,
  };
}

/** Runs the callback on a temporary copy of {@link FILES}, and removes it afterwards. */
async function withFiles(run: (root: string) => Promise<void>): Promise<void> {
  const root = site(FILES);
  try {
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("two builds with the same as-of date are identical", async () => {
  await withFiles(async (root) => {
    const first = await buildModel(root, { asOf: "2026-06-01" });
    const second = await buildModel(root, { asOf: "2026-06-01" });
    assert.deepEqual(snapshot(second), snapshot(first));
    assert.equal(pageAt(first, "/releases/one/")?.dates, true);
    assert.equal(Object.hasOwn(pageAt(first, "/plain/")!, "dates"), false);
  });
});

test("as-of A, then B, then A: the third build equals the first on every page", async () => {
  await withFiles(async (root) => {
    const first = await buildModel(root, { asOf: "2026-06-01" });
    const moved = await buildModel(root, { asOf: "2026-06-02" });
    const again = await buildModel(root, { asOf: "2026-06-01" });

    assert.deepEqual(snapshot(again), snapshot(first));
    assert.notEqual(
      pageAt(moved, "/releases/one/")?.markdown,
      pageAt(first, "/releases/one/")?.markdown,
      "the moved as-of date changed the marked page",
    );
  });
});

test("two builds with no as-of date are identical", async () => {
  await withFiles(async (root) => {
    const first = await buildModel(root);
    const second = await buildModel(root);
    assert.deepEqual(snapshot(second), snapshot(first));
    assert.ok(first.diagnostics.some((finding) => finding.id === "dates.no-as-of"));
  });
});
