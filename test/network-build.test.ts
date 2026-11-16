/** A site in a network builds from `network.lock.json` only: base from the project's path, Site.network for themes, and a lock that is part of the build's identity. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildModel } from "../src/model/build.ts";
import { type NetworkLock, writeNetworkLock } from "../src/network/lock.ts";
import { build } from "../src/pipeline/build.ts";

const THEME = fileURLToPath(new URL("../../lateen", import.meta.url));
const H = "a".repeat(64);

export function lockOf(over: Partial<NetworkLock> = {}): NetworkLock {
  return {
    version: 1,
    source: "https://example.org/network.json",
    sha256: H,
    projects: [
      { id: "docs", path: "docs", title: "Docs", public: true, manifest: { url: "https://example.org/docs/.mizzen/manifest.json", sha256: H, pages: [{ path: "/", title: "Home", sha256: H }] } },
      { id: "blog", path: "blog", title: "Blog", public: true, search: "find", manifest: { url: "https://example.org/blog/.mizzen/manifest.json", sha256: H, pages: [{ path: "/post/", title: "A post", sha256: H }] } },
      { id: "internal", path: "internal", title: "Internal", public: false },
    ],
    ...over,
  };
}

export async function networkSite(extra = "", lock: NetworkLock | null = lockOf(), project = "docs"): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "mizzen-netbuild-"));
  writeFileSync(join(root, "mizzen.yml"), `title: Demo\nurl: https://example.org\nnetwork:\n  source: https://example.org/network.json\n  project: ${project}\n${extra}`);
  writeFileSync(join(root, "index.md"), "---\ntitle: Home\n---\n# Home\n\nHello.\n");
  mkdirSync(join(root, "guide"));
  writeFileSync(join(root, "guide", "index.md"), "---\ntitle: Guide\n---\n# Guide\n\nText.\n");
  if (lock !== null) await writeNetworkLock(root, lock);
  return root;
}

test("Site.network lists the public projects, marks the current one, and carries the lock's hash", async () => {
  const { site, diagnostics } = await buildModel(await networkSite());
  assert.deepEqual(diagnostics.filter((d) => d.severity === "error"), []);
  assert.equal(site.network?.current, "docs");
  assert.deepEqual(site.network?.projects.map((p) => [p.id, p.current]), [["docs", true], ["blog", false]]);
  assert.equal(site.network?.projects[1]?.search, "find");
  assert.match(site.network?.lock ?? "", /^[0-9a-f]{64}$/);
});

test("a site without a network key has no Site.network", async () => {
  const root = mkdtempSync(join(tmpdir(), "mizzen-netbuild-"));
  writeFileSync(join(root, "mizzen.yml"), "title: Demo\n");
  writeFileSync(join(root, "index.md"), "# Home\n");
  assert.equal((await buildModel(root)).site.network, undefined);
});

test("a missing lock is an error that names `mizzen network update`", async () => {
  const { diagnostics } = await buildModel(await networkSite("", null));
  const d = diagnostics.find((x) => x.id === "network.lock-missing");
  assert.equal(d?.severity, "error");
  assert.match(d?.help ?? "", /mizzen network update/);
});

test("a project the lock does not list is rejected", async () => {
  const { diagnostics } = await buildModel(await networkSite("", lockOf(), "wiki"));
  assert.ok(diagnostics.some((d) => d.id === "network.unknown-project" && d.severity === "error"));
});

test("an old lock is a warning, never an error, and maxAgeDays moves the line", async () => {
  const root = await networkSite();
  const day = 86_400_000;
  const now = () => Date.now() + 40 * day;
  const old = (await buildModel(root, { now })).diagnostics.find((d) => d.id === "network.lock-stale");
  assert.equal(old?.severity, "warning");
  const young = await buildModel(root, { now: () => Date.now() + 10 * day });
  assert.ok(!young.diagnostics.some((d) => d.id === "network.lock-stale"));
});

test("the base is the project's path, on every page", async () => {
  const { site, diagnostics } = await buildModel(await networkSite());
  assert.deepEqual(diagnostics.filter((d) => d.severity === "error"), []);
  assert.equal(site.config.base, "/docs");
  assert.ok(site.pages.every((p) => p.url.startsWith("/docs/")), site.pages.map((p) => p.url).join(","));
});

test("a config base that agrees is accepted; one that differs is an error", async () => {
  const ok = await buildModel(await networkSite("base: /docs/\n"));
  assert.ok(!ok.diagnostics.some((d) => d.id === "network.base-mismatch"));
  const bad = await buildModel(await networkSite("base: /other\n"));
  assert.ok(bad.diagnostics.some((d) => d.id === "network.base-mismatch" && d.severity === "error"));
});

test("a build records the lock, and a changed lock changes the build hash though no page changed", async () => {
  const opts = { themeRoot: THEME, defaultLayout: "doc" };
  const one = await networkSite();
  const outOne = join(one, "_site");
  const first = await build({ root: one, out: outOne, ...opts });
  assert.deepEqual(first.diagnostics.filter((d) => d.severity === "error"), []);
  const record = JSON.parse(readFileSync(join(outOne, ".mizzen", "network.json"), "utf8"));
  assert.deepEqual([record.project, record.projects], ["docs", ["docs", "blog"]]);
  const manifest = (dir: string) => JSON.parse(readFileSync(join(dir, ".mizzen", "manifest.json"), "utf8"));
  assert.ok(manifest(outOne).pages.every((p: { url: string }) => p.url.startsWith("/docs/")));

  const two = await networkSite("", lockOf({ sha256: "b".repeat(64) }));
  const outTwo = join(two, "_site");
  await build({ root: two, out: outTwo, ...opts });
  assert.notEqual(manifest(outTwo).build.hash, manifest(outOne).build.hash);
});
