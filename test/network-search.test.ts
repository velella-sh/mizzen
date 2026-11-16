/** One search over several projects: each project's index under the folder the network names, and a file that lists the others. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildModel } from "../src/model/build.ts";
import { SEARCH_MERGE_PATH, searchMerge } from "../src/outputs/search-merge.ts";
import { SEARCH_SCOPE } from "../src/outputs/search-shared.ts";
import { build } from "../src/pipeline/build.ts";
import { lockOf, networkSite } from "./helpers-network.ts";

const ctx = { renderPage: async () => "", report: () => {} };
const THEME = fileURLToPath(new URL("../../lateen", import.meta.url));

test("a site with three projects lists the other public projects' indexes and never the hidden one", async () => {
  const { site } = await buildModel(await networkSite());
  const files = await searchMerge.run(site, ctx);
  assert.deepEqual(files.map((f) => f.path), [SEARCH_MERGE_PATH]);
  const record = JSON.parse(String(files[0]!.contents));
  assert.deepEqual(record.others, [{ id: "blog", title: "Blog", index: "/blog/find" }]);
  assert.deepEqual(record.project, { id: "docs", title: "Docs", index: "/docs/pagefind" });
  assert.deepEqual(record.scope, { parameter: "scope", values: ["project", "all"], default: "project" });
  assert.ok(!JSON.stringify(record).includes("internal"));
  assert.deepEqual([SEARCH_SCOPE.project, SEARCH_SCOPE.all], ["project", "all"]);
});

test("a site without a network key, and a project alone in its network, write nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "mizzen-netsearch-"));
  writeFileSync(join(root, "mizzen.yml"), "title: Demo\n");
  writeFileSync(join(root, "index.md"), "# Home\n");
  assert.deepEqual(await searchMerge.run((await buildModel(root)).site, ctx), []);
  const alone = lockOf({ projects: [lockOf().projects[0]!] });
  assert.deepEqual(await searchMerge.run((await buildModel(await networkSite("", alone))).site, ctx), []);
});

test("a site whose search is off writes no merge file", async () => {
  const { site } = await buildModel(await networkSite("search: false\n"));
  assert.deepEqual(await searchMerge.run(site, ctx), []);
});

test("a build writes this project's index under the folder the network names", async () => {
  const lock = lockOf();
  const named = { ...lock, projects: [{ ...lock.projects[0]!, search: "find" }, ...lock.projects.slice(1)] };
  const root = await networkSite("", named);
  const out = join(root, "_site");
  const result = await build({ root, out, themeRoot: THEME, defaultLayout: "doc" });
  assert.deepEqual(result.diagnostics.filter((d) => d.severity === "error"), []);
  assert.ok(existsSync(join(out, "find", "pagefind.js")));
  assert.ok(!existsSync(join(out, "pagefind")));
  assert.equal(JSON.parse(readFileSync(join(out, SEARCH_MERGE_PATH), "utf8")).project.index, "/docs/find");
});
