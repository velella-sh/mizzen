import assert from "node:assert/strict";
import { test } from "node:test";
import { referenceDateOf } from "../src/data/reference-date.ts";
import { withSite } from "./data-record-site.ts";

test("a fixed date and a _data path both resolve to a reference date", () => {
  assert.deepEqual(referenceDateOf("posts", { source: "_data/posts.yml", referenceDate: "2026-03-15" }, {}), {
    date: "2026-03-15",
  });
  assert.deepEqual(
    referenceDateOf("posts", { source: "_data/posts.yml", referenceDate: "site.today" }, { site: { today: "2026-03-15" } }),
    { date: "2026-03-15" },
  );
});

test("a config value that names no date is reported at the list that needed it", async () => {
  await withSite(
    {
      "mizzen.yml":
        "collections:\n" +
        "  posts:\n" +
        "    source: _data/posts.yml\n" +
        "    dates: [date]\n" +
        "    referenceDate: nonsense\n",
      "_data/posts.yml": "- id: a\n  date: 2026-01-05\n",
      "blog/index.md":
        "---\ntitle: Blog\nlist:\n  collection: posts\n  where:\n    date: { after: reference-7d }\n---\n# Blog\n",
    },
    (_root, result) => {
      assert.deepEqual(result.diagnostics.map((finding) => finding.id), ["data.reference-date"]);
    },
  );
});

test("a list on either side of a fixed reference date is the same build on two days", async () => {
  const files = {
    "mizzen.yml":
      "collections:\n" +
      "  posts:\n" +
      "    source: _data/posts.yml\n" +
      "    dates: [date]\n" +
      "    referenceDate: 2026-03-15\n",
    "_data/posts.yml": "- id: old\n  date: 2026-01-05\n- id: new\n  date: 2026-03-14\n",
    "blog/index.md":
      "---\ntitle: Blog\nlist:\n  collection: posts\n  where:\n    date: { after: reference-7d }\n---\n# Blog\n",
  };
  const { buildModel } = await import("../src/model/build.ts");
  const { site } = await import("./data-record-site.ts");
  const root = site(files);
  try {
    const first = await buildModel(root);
    const second = await buildModel(root);
    assert.deepEqual(second.site, first.site);
    assert.deepEqual(first.site.pages.find((page) => page.url === "/blog/")?.list?.records.map((record) => record.id), ["new"]);
  } finally {
    const { rmSync } = await import("node:fs");
    rmSync(root, { recursive: true, force: true });
  }
});
