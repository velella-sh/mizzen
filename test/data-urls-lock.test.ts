import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "../src/pipeline/build.ts";
import { URLS_LOCK_FILE } from "../src/data/urls-lock.ts";
import { ids, site, withSite } from "./data-record-site.ts";

const FILES = {
  "mizzen.yml":
    "url: https://example.com\n" +
    "collections:\n" +
    "  pages:\n" +
    "    source: _data/pages.yml\n" +
    "    template: _templates/page.md\n" +
    "    permalink: /pages/{name|slug}/\n",
  "_data/pages.yml": "- id: a\n  name: Alpha\n",
  "_templates/page.md": "---\ntitle: \"{name}\"\n---\n# :field[name]\n",
};

/** A lock whose one record lives at `url`. */
function lock(url: string, extra = ""): string {
  return `{"version":1,"collections":{"pages":{"a":{"url":"${url}","previous":[]}${extra}}}}\n`;
}

test("a matching lock reports nothing, and a missing one starts no check", async () => {
  await withSite({ ...FILES, [URLS_LOCK_FILE]: lock("/pages/alpha/") }, (_root, result) => {
    assert.deepEqual(result.diagnostics, []);
  });
  await withSite(FILES, (_root, result) => {
    assert.deepEqual(result.diagnostics, []);
  });
});

test("a changed URL is an error that names both addresses and the command that accepts it", async () => {
  await withSite(
    { ...FILES, [URLS_LOCK_FILE]: lock("/pages/alpha/"), "_data/pages.yml": "- id: a\n  name: Beta\n" },
    (_root, result) => {
      assert.deepEqual(ids(result), ["urls.url-changed"]);
      const finding = result.diagnostics[0]!;
      assert.match(finding.message, /"\/pages\/alpha\/" to "\/pages\/beta\/"/);
      assert.match(finding.help!, /--update-urls/);
      assert.equal(finding.pos?.file, "_data/pages.yml");
    },
  );
});

test("a new record is fine and counted, and a malformed lock is an error", async () => {
  await withSite(
    {
      ...FILES,
      [URLS_LOCK_FILE]: lock("/pages/alpha/"),
      "_data/pages.yml": "- id: a\n  name: Alpha\n- id: b\n  name: Beta\n",
    },
    (_root, result) => {
      assert.deepEqual(ids(result), ["urls.new-records"]);
      assert.match(result.diagnostics[0]!.message, /1 new record/);
    },
  );
  await withSite({ ...FILES, [URLS_LOCK_FILE]: '{"version":2}\n' }, (_root, result) => {
    assert.deepEqual(ids(result), ["data.urls-lock-invalid"]);
  });
});

test("a removed record is an error by default, a notice with gone, and a redirect with a target", async () => {
  const removed = { ...FILES, [URLS_LOCK_FILE]: lock("/pages/alpha/"), "_data/pages.yml": "[]\n" };
  await withSite(removed, (_root, result) => {
    assert.deepEqual(ids(result), ["urls.removed"]);
    assert.match(result.diagnostics[0]!.message, /"\/pages\/alpha\/"/);
    assert.equal(result.site.removed, undefined);
  });
  await withSite({ ...removed, "mizzen.yml": `${FILES["mizzen.yml"]}    onRemoved: gone\n` }, (_root, result) => {
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(result.site.removed, [
      { collection: "pages", id: "a", urls: ["/pages/alpha/"] },
    ]);
  });
  await withSite(
    { ...removed, "mizzen.yml": `${FILES["mizzen.yml"]}    onRemoved:\n      redirect: /pages/\n` },
    (_root, result) => {
      assert.deepEqual(result.diagnostics, []);
      assert.deepEqual(result.site.removed, [
        { collection: "pages", id: "a", urls: ["/pages/alpha/"], target: "/pages/" },
      ]);
    },
  );
});

test("a new record cannot take the id of a removed one", async () => {
  await withSite(
    {
      ...FILES,
      [URLS_LOCK_FILE]: `{"version":1,"collections":{"pages":{"a":{"url":"/pages/alpha/","previous":[],"removed":true}}}}\n`,
      "_data/pages.yml": "- id: a\n  name: Alpha\n",
    },
    (_root, result) => {
      assert.deepEqual(ids(result), ["urls.id-reused"]);
    },
  );
});

/** A theme with the two layouts the site needs, so a real build can run. */
function theme(): string {
  const root = mkdtempSync(join(tmpdir(), "urls-lock-theme-"));
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "urls-theme", type: "module" }),
    "src/index.ts": 'export const theme = { name: "urls-theme", folders: ["layouts"] };\n',
    "layouts/doc.ts": "export default function doc({ page }) { return `<html><body>${page.html}</body></html>`; }\n",
    "layouts/record.ts": "export default function record({ page }) { return `<html><body>${page.html}</body></html>`; }\n",
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

test("--update-urls writes the lock and keeps the old URL as a redirect", async () => {
  const root = site({ ...FILES, [URLS_LOCK_FILE]: lock("/pages/alpha/"), "_data/pages.yml": "- id: a\n  name: Beta\n" });
  const themeRoot = theme();
  const parent = mkdtempSync(join(tmpdir(), "urls-lock-out-"));
  try {
    const result = await build({ root, out: join(parent, "out"), themeRoot, defaultLayout: "doc", updateUrls: true });
    assert.deepEqual(ids(result), ["urls.url-updated"]);
    const written = JSON.parse(readFileSync(join(root, URLS_LOCK_FILE), "utf8")) as {
      collections: { pages: { a: { url: string; previous: string[] } } };
    };
    assert.deepEqual(written.collections.pages.a, { url: "/pages/beta/", previous: ["/pages/alpha/"] });
    const redirect = readFileSync(join(parent, "out/pages/alpha/index.html"), "utf8");
    assert.match(redirect, /url=https:\/\/example\.com\/pages\/beta\//);
    assert.throws(() => readFileSync(join(parent, "out", URLS_LOCK_FILE), "utf8"));

    // A second change keeps every earlier address: alpha -> beta -> gamma.
    writeFileSync(join(root, "_data/pages.yml"), "- id: a\n  name: Gamma\n");
    await build({ root, out: join(parent, "out"), themeRoot, defaultLayout: "doc", updateUrls: true });
    const updated = JSON.parse(readFileSync(join(root, URLS_LOCK_FILE), "utf8")) as {
      collections: { pages: { a: { url: string; previous: string[] } } };
    };
    assert.deepEqual(updated.collections.pages.a, {
      url: "/pages/gamma/",
      previous: ["/pages/alpha/", "/pages/beta/"],
    });
    for (const old of ["alpha", "beta"]) {
      assert.match(readFileSync(join(parent, "out/pages", old, "index.html"), "utf8"), /url=https:\/\/example\.com\/pages\/gamma\//);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(themeRoot, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("an ordinary build writes no lock", async () => {
  const root = site(FILES);
  const themeRoot = theme();
  const parent = mkdtempSync(join(tmpdir(), "urls-lock-out-"));
  try {
    await build({ root, out: join(parent, "out"), themeRoot, defaultLayout: "doc" });
    assert.throws(() => readFileSync(join(root, URLS_LOCK_FILE), "utf8"));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(themeRoot, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});
