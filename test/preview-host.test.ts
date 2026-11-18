// #845, #846: a local host serves the activated bundle and an activation swaps it, so rolling back is activating the
// previous name. The bundle keeps its own manifest and files, so a rollback changes nothing on disk but `current`.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { activate, serve } from "../scripts/preview-host.ts";
import { bundle } from "../scripts/bundle.ts";
import { build } from "../src/pipeline/build.ts";

/** Writes `files` under `root`, creating their folders. */
function tree(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

/** A theme with one layout, so a build needs nothing else. */
function theme(root: string): string {
  const dir = join(root, "theme");
  tree(dir, {
    "src/index.ts": 'export const theme = { name: "t", folders: ["layouts"] };\n',
    "layouts/doc.ts":
      'export default (p: any) => `<html><head><title>${p.page.title}</title></head><body>${p.page.html}</body></html>`;\n',
  });
  return dir;
}

test("a bundle swaps and rolls back on the local host", async () => {
  const parent = mkdtempSync(join(tmpdir(), "preview-host-"));
  let server: Awaited<ReturnType<typeof serve>> | undefined;
  try {
    const themeRoot = theme(parent);
    const site = join(parent, "site");
    tree(site, { "mizzen.yml": "title: Preview\n" });
    const bundlesDir = join(parent, "previews");
    const release = async (name: string, body: string): Promise<void> => {
      writeFileSync(join(site, "index.md"), `---\ntitle: ${name}\nlayout: doc\n---\n\n${body}\n`);
      const out = join(parent, `out-${name}`);
      await build({
        root: site,
        out,
        themeRoot,
        defaultLayout: "doc",
        basePath: "/preview/pr-1",
        preview: { canonicalBase: "https://preview.example.com/" },
      });
      await bundle(out, join(bundlesDir, name));
    };
    await release("v1", "Version one");
    await release("v2", "Version two");

    const v1Json = readFileSync(join(bundlesDir, "v1", "bundle.json"), "utf8");
    const v2Json = readFileSync(join(bundlesDir, "v2", "bundle.json"), "utf8");
    assert.notEqual(JSON.parse(v1Json).buildHash, JSON.parse(v2Json).buildHash, "the two releases differ");

    await activate(bundlesDir, "v2");
    server = await serve(bundlesDir, 0);
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("the server is not listening");
    const base = `http://127.0.0.1:${address.port}`;
    const get = async (path: string): Promise<{ status: number; body: Buffer }> => {
      const response = await fetch(`${base}${path}`);
      return { status: response.status, body: Buffer.from(await response.arrayBuffer()) };
    };

    const served = await get("/bundle.json");
    assert.equal(served.status, 200);
    assert.equal(served.body.toString("utf8"), v2Json, "the manifest is served from the bundle root");
    const v2 = await get("/index.html");
    assert.equal(v2.status, 200);
    assert.deepEqual(v2.body, readFileSync(join(bundlesDir, "v2", "files", "index.html")));
    assert.match(v2.body.toString("utf8"), /Version two/);

    await activate(bundlesDir, "v1");
    const rolledBack = await get("/index.html");
    assert.equal(rolledBack.status, 200);
    assert.deepEqual(rolledBack.body, readFileSync(join(bundlesDir, "v1", "files", "index.html")));
    assert.match(rolledBack.body.toString("utf8"), /Version one/);
    assert.equal((await get("/bundle.json")).body.toString("utf8"), v1Json, "the old bundle keeps its manifest");
    assert.equal(readFileSync(join(bundlesDir, "v1", "bundle.json"), "utf8"), v1Json);

    assert.equal((await get("/..%2f..%2fbundle.json")).status, 404, "a path traversal is refused");
    assert.equal((await get("/missing.html")).status, 404);
  } finally {
    if (server !== undefined) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    rmSync(parent, { recursive: true, force: true });
  }
});

test("activation refuses a bundle whose files changed after it was packaged", async () => {
  const parent = mkdtempSync(join(tmpdir(), "preview-host-tamper-"));
  try {
    const themeRoot = theme(parent);
    const site = join(parent, "site");
    tree(site, {
      "mizzen.yml": "title: Preview\n",
      "index.md": "---\ntitle: Home\nlayout: doc\n---\n\nHello\n",
    });
    const out = join(parent, "out");
    await build({ root: site, out, themeRoot, defaultLayout: "doc", basePath: "/preview/pr-1" });
    const bundlesDir = join(parent, "previews");
    await bundle(out, join(bundlesDir, "v1"));

    writeFileSync(join(bundlesDir, "v1", "files", "index.html"), "changed\n");
    await assert.rejects(activate(bundlesDir, "v1"), /does not match its bundle\.json/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
