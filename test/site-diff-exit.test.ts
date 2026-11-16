import assert from "node:assert/strict";
import { test } from "node:test";
import { main } from "../src/cli/index.ts";
import { cleanup, writeBuild } from "./site-diff-builds.ts";

const home = { url: "/", title: "Home", md: "# Home\n" };
const gone = { url: "/gone/", title: "Gone", md: "# Gone\n" };

async function run(a: string, b: string, ...flags: string[]): Promise<{ code: number; err: string }> {
  let err = "";
  const code = await main(["diff", a, b, ...flags], { write: () => {}, log: () => {}, error: (m) => (err += m) });
  return { code, err };
}

test("by default a diff exits 0 whatever it finds", async () => {
  const a = await writeBuild({ pages: [home, gone] });
  const b = await writeBuild({ pages: [home] });
  assert.equal((await run(a, b)).code, 0);
  cleanup(a, b);
});

test("removed-pages fails when a page disappeared, not when it moved", async () => {
  const a = await writeBuild({ pages: [home, gone] });
  const b = await writeBuild({ pages: [home] });
  assert.equal((await run(a, b, "--fail-on", "removed-pages")).code, 1);
  const moved = await writeBuild({ pages: [home, { ...gone, url: "/elsewhere/", source: gone.url.replace(/\//g, "") + ".md" }].map((p, i) => (i === 1 ? { ...p, source: "gone.md" } : p)) });
  const base = await writeBuild({ pages: [home, { ...gone, source: "gone.md" }] });
  assert.equal((await run(base, moved, "--fail-on", "removed-pages")).code, 0);
  cleanup(a, b, moved, base);
});

test("broken-urls fails for a move without a redirect and passes with one", async () => {
  const base = await writeBuild({ pages: [{ ...gone, source: "gone.md" }] });
  const bare = await writeBuild({ pages: [{ url: "/new/", title: "Gone", md: "# Gone\n", source: "gone.md" }] });
  const redirected = await writeBuild({
    pages: [{ url: "/new/", title: "Gone", md: "# Gone\n", source: "gone.md" }],
    files: { "gone/index.html": '<meta http-equiv="refresh" content="0; url=/new/">' },
  });
  assert.equal((await run(base, bare, "--fail-on", "broken-urls")).code, 1);
  assert.equal((await run(base, redirected, "--fail-on", "broken-urls")).code, 0);
  cleanup(base, bare, redirected);
});

test("render-only fails when only the HTML changed", async () => {
  const a = await writeBuild({ pages: [{ ...home, html: "<p>1</p>" }] });
  const b = await writeBuild({ pages: [{ ...home, html: "<p>2</p>" }] });
  assert.equal((await run(a, b, "--fail-on", "render-only")).code, 1);
  assert.equal((await run(a, b, "--fail-on", "removed-pages")).code, 0);
  cleanup(a, b);
});

test("kinds combine, and an unknown kind is a usage error", async () => {
  const a = await writeBuild({ pages: [home, gone] });
  const b = await writeBuild({ pages: [home] });
  const result = await run(a, b, "--fail-on", "render-only,removed-pages");
  assert.equal(result.code, 1);
  assert.match(result.err, /removed-pages/);
  assert.equal((await run(a, b, "--fail-on", "everything")).code, 2);
  cleanup(a, b);
});
