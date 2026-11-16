import assert from "node:assert/strict";
import { test } from "node:test";
import { diffReadBuilds } from "../src/diff/index.ts";
import { readBuild } from "../src/diff/builds.ts";
import { formatDiff } from "../src/diff/format.ts";
import { Reader } from "../src/diff/reader.ts";
import { cleanup, writeBuild } from "./site-diff-builds.ts";

const many = Array.from({ length: 30 }, (_, i) => ({ url: `/p${i}/`, title: `P${i}`, md: `# P${i}\n\nbody ${i}\n` }));

test("the same two builds give the same report, byte for byte, in every format", async () => {
  const a = await writeBuild({ pages: many });
  const b = await writeBuild({ pages: [...many.slice(1), { url: "/z/", title: "Z", md: "# Z\n" }, { ...many[0]!, md: "# P0\n\nchanged\n" }] });
  const first = await diffReadBuilds(await readBuild(a, "a"), await readBuild(b, "b"));
  const second = await diffReadBuilds(await readBuild(a, "a"), await readBuild(b, "b"));
  for (const format of ["text", "json", "markdown"] as const) assert.equal(formatDiff(first, format), formatDiff(second, format));
  cleanup(a, b);
});

test("pages that did not change are never opened", async () => {
  const a = await writeBuild({ pages: many });
  const b = await writeBuild({ pages: [{ ...many[0]!, md: "# P0\n\nchanged\n" }, ...many.slice(1)] });
  const reader = new Reader();
  const diff = await diffReadBuilds(await readBuild(a, "a"), await readBuild(b, "b"), reader);
  assert.equal(diff.summary.pages.changed, 1);
  assert.ok(reader.reads <= 8, `read ${reader.reads} files for one changed page`);
  cleanup(a, b);
});

test("identical builds read no file at all", async () => {
  const a = await writeBuild({ pages: many });
  const b = await writeBuild({ pages: many });
  const reader = new Reader();
  await diffReadBuilds(await readBuild(a, "a"), await readBuild(b, "b"), reader);
  assert.equal(reader.reads, 0);
  cleanup(a, b);
});
