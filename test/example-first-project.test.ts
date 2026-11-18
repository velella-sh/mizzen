import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "../src/pipeline/build.ts";
import { buildModel } from "../src/model/build.ts";

const THEME = fileURLToPath(new URL("../../lateen", import.meta.url));

const samples = [
  {
    name: "catalog",
    list: "sensors/",
    pages: ["index.html", "sensors/index.html", "sensors/thermometer/index.html"],
  },
  {
    name: "report",
    list: "archive/",
    pages: ["index.html", "archive/index.html"],
  },
  {
    name: "mixed",
    list: "stations/",
    pages: ["guide/index.html", "stations/index.html", "stations/riverside/index.html"],
  },
] as const;

for (const sample of samples) {
  const root = fileURLToPath(new URL(`../examples/first-project/${sample.name}/`, import.meta.url));

  test(`the ${sample.name} sample builds twice with no error and the same bytes, and its list page holds records`, async () => {
    const parent = mkdtempSync(join(tmpdir(), `example-first-project-${sample.name}-`));
    try {
      const first = await build({ root, out: join(parent, "first"), themeRoot: THEME });
      const second = await build({ root, out: join(parent, "second"), themeRoot: THEME });
      for (const result of [first, second]) {
        assert.deepEqual(result.diagnostics.filter((d) => d.severity === "error"), []);
      }
      assert.deepEqual(first.files, second.files);
      for (const file of first.files) {
        assert.ok(
          readFileSync(join(parent, "first", file)).equals(readFileSync(join(parent, "second", file))),
          `${file} is byte for byte the same in both builds`,
        );
      }
      for (const file of sample.pages) {
        assert.ok(first.files.includes(file), `the build writes ${file}`);
      }
      assert.ok(first.files.includes(`${sample.list}index.html`), `the build writes the ${sample.list} list page`);
      const model = await buildModel(root);
      const lists = model.site.pages.filter((page) => page.list !== undefined);
      assert.ok(lists.length > 0, "the sample has a list page");
      for (const page of lists) assert.ok(page.list?.records.length !== 0, `${page.url} lists records`);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
}
