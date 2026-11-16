import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { runNetwork } from "../src/cli/network.ts";

const networkFile = {
  version: 1,
  projects: [
    { id: "docs", path: "docs", title: "Docs", public: true },
    { id: "blog", path: "blog", title: "Blog", public: true },
    { id: "internal", path: "internal", title: "Internal", public: false },
  ],
};

function manifest(path: string, hash: string) {
  return { version: 1, pages: [
    { url: `/${path}/`, source: "index.md", title: "Home", layout: "page", outputs: [], hashes: { source: "a", html: hash } },
    { url: `/${path}/guide/`, source: "guide.md", title: "Guide", layout: "page", outputs: [], hashes: { source: "b", html: "b".repeat(64) } },
  ] };
}

describe("network update", () => {
  let server: Server;
  let origin = "";
  let docsHash = "a".repeat(64);
  const requests: string[] = [];

  before(async () => {
    server = createServer((req, res) => {
      requests.push(req.url ?? "");
      const body = req.url === "/network.json" ? networkFile
        : req.url === "/docs/.mizzen/manifest.json" ? manifest("docs", docsHash)
        : req.url === "/blog/.mizzen/manifest.json" ? manifest("blog", "c".repeat(64))
        : undefined;
      if (body === undefined) { res.statusCode = 404; res.end("no"); return; }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  async function site(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "mizzen-net-"));
    await writeFile(join(root, "mizzen.yml"), `title: T\nnetwork:\n  source: ${origin}/network.json\n  project: docs\n`);
    return root;
  }
  async function run(root: string, ...args: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runNetwork(["update", root, ...args], { log: (m) => out.push(m), error: (m) => err.push(m) });
    return { code, out, err };
  }

  it("writes a lock that two runs leave byte-identical, with no timestamp", async () => {
    const root = await site();
    assert.equal((await run(root)).code, 0);
    const first = await readFile(join(root, "network.lock.json"), "utf8");
    const again = await run(root);
    assert.equal(again.code, 0);
    assert.equal(await readFile(join(root, "network.lock.json"), "utf8"), first);
    assert.ok(first.endsWith("\n"));
    assert.doesNotMatch(first, /\d{4}-\d{2}-\d{2}T/);
    const lock = JSON.parse(first);
    assert.deepEqual(lock.projects.map((p: { id: string }) => p.id), ["docs", "blog", "internal"]);
    assert.equal(lock.projects[2].manifest, undefined);
    assert.equal(lock.projects[1].manifest.pages[0].path, "/");
  });

  it("never fetches a hidden project's page list", async () => {
    requests.length = 0;
    await run(await site());
    assert.ok(!requests.some((r) => r.startsWith("/internal")));
  });

  it("prints a diff when a project changed, marks it, and --accept clears the mark", async () => {
    const root = await site();
    await run(root);
    docsHash = "d".repeat(64);
    const check = await run(root, "--check");
    assert.equal(check.code, 1);
    assert.ok(check.out.some((l) => l.includes("~ docs:/")));
    const update = await run(root);
    assert.equal(update.code, 0);
    assert.ok(update.out.some((l) => l.includes("~ docs:/")));
    const marked = JSON.parse(await readFile(join(root, "network.lock.json"), "utf8"));
    assert.equal(marked.projects[0].manifest.pages[0].previous, "a".repeat(64));
    assert.equal((await run(root)).code, 0);
    assert.equal((await run(root, "--check")).code, 0);
    await run(root, "--accept");
    const accepted = JSON.parse(await readFile(join(root, "network.lock.json"), "utf8"));
    assert.equal(accepted.projects[0].manifest.pages[0].previous, undefined);
    docsHash = "a".repeat(64);
  });

  it("keeps the old lock when a page list cannot be read", async () => {
    const root = await site();
    await run(root);
    const before = await readFile(join(root, "network.lock.json"), "utf8");
    await writeFile(join(root, "mizzen.yml"), `title: T\nnetwork:\n  source: ${origin}/missing.json\n  project: docs\n`);
    const result = await run(root);
    assert.equal(result.code, 1);
    assert.equal(await readFile(join(root, "network.lock.json"), "utf8"), before);
  });

  it("refuses a site without a network key", async () => {
    const root = await mkdtemp(join(tmpdir(), "mizzen-net-"));
    await writeFile(join(root, "mizzen.yml"), "title: T\n");
    assert.equal((await run(root)).code, 2);
  });
});
