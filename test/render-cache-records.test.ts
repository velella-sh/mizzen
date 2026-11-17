import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { write } from "../fixtures/data-large/generate.ts";
import { buildModel } from "../src/model/build.ts";
import { build } from "../src/pipeline/build.ts";
import { pruneRenderEntries, recordKeyOf, recordShapeOf } from "../src/pipeline/render-cache.ts";

const REPO = fileURLToPath(new URL("../", import.meta.url));

/** A theme whose layout renders the body, every page title, and the navigation, so chrome is part of what is cached. */
function makeTheme(): string {
  const root = mkdtempSync(join(tmpdir(), "render-records-theme-"));
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"), "dir");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "layouts"), { recursive: true });
  writeFileSync(join(root, "src/index.ts"), 'export const theme = { name: "records-test", folders: ["layouts"] };\n');
  writeFileSync(
    join(root, "layouts/doc.ts"),
    `import { h } from "preact";
import type { Layout } from "@velella/mizzen/contracts";

const doc: Layout = (props) =>
  h(
    "html",
    null,
    h(
      "body",
      null,
      h("ul", { id: "titles" }, props.site.pages.map((page) => h("li", { key: page.url }, page.title))),
      h("pre", { id: "nav" }, JSON.stringify(props.site.nav)),
      h("main", { dangerouslySetInnerHTML: { __html: props.page.html } }),
    ),
  );

export default doc;
`,
  );
  return root;
}

function snapshot(dir: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rel of readdirSync(dir, { recursive: true }) as string[]) {
    const abs = join(dir, rel);
    if (statSync(abs).isFile()) map.set(rel.split("\\").join("/"), readFileSync(abs).toString("latin1"));
  }
  return map;
}

const RECORDS = 200;

function setup(): { root: string; theme: string; parent: string; out: string; clean: string; cacheDir: string } {
  const root = mkdtempSync(join(tmpdir(), "render-records-site-"));
  write(root, RECORDS);
  const parent = mkdtempSync(join(tmpdir(), "render-records-out-"));
  return { root, theme: makeTheme(), parent, out: join(parent, "site"), clean: join(parent, "clean"), cacheDir: join(parent, "cache") };
}

function edit(root: string, file: string, from: string, to: string): void {
  const path = join(root, "_data", file);
  const text = readFileSync(path, "utf8");
  assert.ok(text.includes(from), `${from} is in ${file}`);
  writeFileSync(path, text.replace(from, to));
}

const entries = (cacheDir: string): string[] => {
  const render = join(cacheDir, "render");
  return readdirSync(render).flatMap((folder) =>
    readdirSync(join(render, folder)).filter((name) => /^[0-9a-f]{64}\.json$/.test(name)),
  );
};

test("one edited record re-renders its page and the lists that show it; the rest are reused, and the bytes equal a clean build", async () => {
  const s = setup();
  try {
    const base = { root: s.root, themeRoot: s.theme, defaultLayout: "doc", cache: true, cacheDir: s.cacheDir };
    const cold = await build({ ...base, out: s.out });
    assert.equal(cold.cachedPages, 0);
    const pages = cold.renderedPages;
    assert.ok(pages > RECORDS, "every record page and the lists render");

    edit(s.root, "releases.json", '"summary": "Release 50 ', '"summary": "Release 50 (edited) ');
    const warm = await build({ ...base, out: s.out });
    assert.ok(warm.renderedPages >= 1 && warm.renderedPages <= 3, `rendered ${warm.renderedPages}`);
    assert.equal(warm.renderedPages + warm.cachedPages, pages);
    assert.ok(warm.invalidation !== undefined);
    assert.equal(warm.invalidation.complete, false);

    await build({ root: s.root, out: s.clean, themeRoot: s.theme, defaultLayout: "doc" });
    assert.deepEqual(snapshot(s.out), snapshot(s.clean));
    assert.match(readFileSync(join(s.out, "releases/1.4.9-00049/index.html"), "utf8"), /\(edited\)/);

    const again = await build({ ...base, out: s.out });
    assert.equal(again.renderedPages, 0, "an unchanged site renders nothing");
  } finally {
    for (const dir of [s.root, s.theme, s.parent]) rmSync(dir, { recursive: true, force: true });
  }
});

test("a page whose referenced record changed is a miss, even when the change does not show in its HTML", async () => {
  const s = setup();
  try {
    const before = await buildModel(s.root);
    const keyBefore = recordKeyOf(before.site);
    const release = before.site.pages.find((page) => page.record?.collection === "releases")!;
    const component = String(before.site.collections.releases!.records.find((r) => r.id === release.record!.id)!.fields.component);
    const sibling = before.site.pages.find(
      (page) =>
        page.record?.collection === "releases" &&
        String(before.site.collections.releases!.records.find((r) => r.id === page.record!.id)!.fields.component) !== component,
    )!;

    // `status` of a component is not shown on a release page: only the record key can notice it.
    const text = readFileSync(join(s.root, "_data/components.yml"), "utf8");
    const at = text.indexOf(`slug: ${component}\n`);
    assert.ok(at >= 0);
    const status = /status: (\w+)/.exec(text.slice(at))!;
    writeFileSync(join(s.root, "_data/components.yml"), text.slice(0, at) + text.slice(at).replace(status[0], `status: ${status[1] === "stable" ? "beta" : "stable"}`));

    const after = await buildModel(s.root);
    const keyAfter = recordKeyOf(after.site);
    const find = (site: typeof after.site, url: string) => site.pages.find((page) => page.url === url)!;

    assert.equal(find(after.site, release.url).html, release.html, "the change is invisible in the page's HTML");
    assert.notEqual(keyAfter(find(after.site, release.url)), keyBefore(release), "the referencing page misses");
    assert.equal(keyAfter(find(after.site, sibling.url)), keyBefore(sibling), "a page that does not reference it is reused");
    assert.equal(recordShapeOf(after.site), recordShapeOf(before.site), "a field edit leaves the shape alone");
  } finally {
    for (const dir of [s.root, s.theme, s.parent]) rmSync(dir, { recursive: true, force: true });
  }
});

test("a retitled record changes the shape, so every page misses", async () => {
  const s = setup();
  try {
    const base = { root: s.root, themeRoot: s.theme, defaultLayout: "doc", cache: true, cacheDir: s.cacheDir };
    const cold = await build({ ...base, out: s.out });
    edit(s.root, "components.yml", "name: button 1\n", "name: button one\n");
    const warm = await build({ ...base, out: s.out });
    assert.equal(warm.renderedPages, cold.renderedPages, "every page shows every title, so none can be reused");
    await build({ root: s.root, out: s.clean, themeRoot: s.theme, defaultLayout: "doc" });
    assert.deepEqual(snapshot(s.out), snapshot(s.clean));
  } finally {
    for (const dir of [s.root, s.theme, s.parent]) rmSync(dir, { recursive: true, force: true });
  }
});

test("entries of edited and removed records are pruned, and the cache does not grow with edits", async () => {
  const s = setup();
  try {
    const base = { root: s.root, themeRoot: s.theme, defaultLayout: "doc", cache: true, cacheDir: s.cacheDir };
    const cold = await build({ ...base, out: s.out });
    const total = entries(s.cacheDir).length;
    assert.equal(total, cold.renderedPages);

    for (let run = 1; run <= 3; run++) {
      edit(s.root, "releases.json", `"summary": "Release 50 ${run === 1 ? "" : `(edit ${run - 1}) `}`, `"summary": "Release 50 (edit ${run}) `);
      await build({ ...base, out: s.out });
      assert.equal(entries(s.cacheDir).length, total, `after edit ${run} no stale entry is left`);
    }

    // Removing a release drops its page, and its entry goes with it.
    const path = join(s.root, "_data/releases.json");
    const data = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    delete data["1.4.9-00049"];
    writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
    await build({ ...base, out: s.out });
    assert.ok(entries(s.cacheDir).length <= total - 1, "the removed record's entry is gone");
  } finally {
    for (const dir of [s.root, s.theme, s.parent]) rmSync(dir, { recursive: true, force: true });
  }
});

test("pruneRenderEntries removes only entry files, and only the ones not kept", async () => {
  const dir = mkdtempSync(join(tmpdir(), "render-prune-"));
  try {
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    for (const name of [`${a}.json`, `${b}.json`, "inputs.json", `.${a}-1-2.tmp`, "notes.txt"]) writeFileSync(join(dir, name), "{}");
    assert.equal(await pruneRenderEntries(dir, new Set([a])), 1);
    assert.deepEqual(readdirSync(dir).sort(), [`.${a}-1-2.tmp`, `${a}.json`, "inputs.json", "notes.txt"].sort());
    assert.equal(await pruneRenderEntries(join(dir, "missing"), new Set()), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
