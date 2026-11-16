import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { write } from "../fixtures/data-large/generate.ts";
import { buildModel } from "../src/model/build.ts";
import { search } from "../src/outputs/search.ts";

async function index(records: number) {
  const root = mkdtempSync(join(tmpdir(), "mizzen-search-scale-"));
  try {
    write(root, records);
    const { site } = await buildModel(root);
    const findings: string[] = [];
    const files = await search.run(site, {
      renderPage: async () => "",
      build: { root, workers: 1 },
      report: (d) => void findings.push(d.id),
    });
    return { site, files, findings };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("every page, record pages included, gets a fragment in the search index", async () => {
  const { site, files, findings } = await index(300);
  assert.deepEqual(findings, []);
  const indexed = site.pages.filter((page) => page.kind === "doc" && page.frontMatter.search !== false);
  const fragments = files.filter((file) => file.path.startsWith("pagefind/fragment/"));
  assert.equal(fragments.length, indexed.length);
  assert.ok(site.pages.some((page) => page.record !== undefined));
});

test("the index grows with the number of records, not faster", async () => {
  const small = await index(100);
  const large = await index(400);
  const bytes = (files: readonly { contents: string | Uint8Array }[]) => files.reduce((n, f) => n + Buffer.byteLength(f.contents), 0);
  const perRecord = (bytes(large.files) - bytes(small.files)) / 300;
  assert.ok(perRecord > 0 && perRecord < 4096, `${perRecord.toFixed(0)} bytes per record`);
});

test("the index is the same bytes in the same order on every build", async () => {
  const a = await index(150);
  const b = await index(150);
  assert.deepEqual(
    a.files.map((f) => f.path),
    [...a.files.map((f) => f.path)].sort(),
  );
  assert.deepEqual(a.files.map((f) => [f.path, Buffer.from(f.contents).toString("base64")]), b.files.map((f) => [f.path, Buffer.from(f.contents).toString("base64")]));
});
