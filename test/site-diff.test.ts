import assert from "node:assert/strict";
import { test } from "node:test";
import { diffBuilds, DiffUsageError } from "../src/diff/index.ts";
import { main } from "../src/cli/index.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, writeBuild } from "./site-diff-builds.ts";

const home = { url: "/", title: "Home", md: "# Home\n\nHello.\n" };
const guide = { url: "/guide/", title: "Guide", md: "# Guide\n\n## Intro\n\nText.\n" };

test("identical builds report no difference and read nothing else", async () => {
  const a = await writeBuild({ pages: [home, guide] });
  const b = await writeBuild({ pages: [home, guide] });
  const diff = await diffBuilds(a, b);
  assert.equal(diff.identical, true);
  assert.equal(diff.summary.pages.changed, 0);
  cleanup(a, b);
});

test("an added, a removed, and a changed page are reported", async () => {
  const a = await writeBuild({ pages: [home, guide] });
  const b = await writeBuild({
    pages: [{ ...home, md: "# Home\n\nHello, world.\n" }, { url: "/new/", title: "New", md: "# New\n" }],
  });
  const diff = await diffBuilds(a, b);
  assert.deepEqual(diff.pages.added.map((p) => p.url), ["/new/"]);
  assert.deepEqual(diff.pages.removed.map((p) => p.url), ["/guide/"]);
  assert.deepEqual(diff.pages.changed.map((p) => p.url), ["/"]);
  assert.ok(diff.pages.changed[0]!.changes.includes("text"));
  assert.deepEqual(diff.brokenUrls, ["/guide/"]);
  cleanup(a, b);
});

test("a folder without a manifest is a usage error", async () => {
  const a = await writeBuild({ pages: [home] });
  const empty = mkdtempSync(join(tmpdir(), "mizzen-empty-"));
  await assert.rejects(diffBuilds(a, empty), DiffUsageError);
  const errors: string[] = [];
  const code = await main(["diff", a, empty], { error: (m) => errors.push(m), write: () => {}, log: () => {} });
  assert.equal(code, 2);
  assert.match(errors.join("\n"), /manifest/);
  cleanup(a, empty);
});

test("the CLI prints the report and exits 0 by default", async () => {
  const a = await writeBuild({ pages: [home] });
  const b = await writeBuild({ pages: [] });
  let out = "";
  const code = await main(["diff", a, b], { write: (t) => (out += t), error: () => {}, log: () => {} });
  assert.equal(code, 0);
  assert.match(out, /removed/);
  cleanup(a, b);
});

test("diff needs two folders", async () => {
  const errors: string[] = [];
  const code = await main(["diff", "only-one"], { error: (m) => errors.push(m), write: () => {}, log: () => {} });
  assert.equal(code, 2);
});
