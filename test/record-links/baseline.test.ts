/** Baseline for #510: what a cross-site link to a record does today when the record's slug changes. */
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { OutputContext } from "../../src/contracts/output.ts";
import { writeUrlsLock } from "../../src/data/urls-lock.ts";
import { buildModel } from "../../src/model/build.ts";
import { writeNetworkLock, type NetworkLock } from "../../src/network/lock.ts";
import { redirects } from "../../src/outputs/redirects.ts";
import { urls } from "../../src/outputs/urls.ts";
import { ids, site } from "../data-record-site.ts";
import { H } from "../helpers-network.ts";

const SOURCE = "https://example.org/network.json";

/** A context that renders nothing: the urls and redirects outputs do not need a page. */
const quiet: OutputContext = {
  renderPage: () => Promise.reject(new Error("the baseline test never renders a page")),
  report: () => undefined,
};

/** The two projects of the example, with Ebb's locked page paths as given. */
function networkLock(ebbPages: readonly string[]): NetworkLock {
  return {
    version: 1,
    source: SOURCE,
    sha256: H,
    projects: [
      {
        id: "ebb",
        path: "ebb",
        title: "Ebb",
        public: true,
        manifest: {
          url: "https://example.org/ebb/.mizzen/manifest.json",
          sha256: H,
          pages: ebbPages.map((path) => ({ path, title: "Ebb", sha256: H })),
        },
      },
      {
        id: "offing",
        path: "offing",
        title: "Offing",
        public: true,
        manifest: {
          url: "https://example.org/offing/.mizzen/manifest.json",
          sha256: H,
          pages: [{ path: "/", title: "Offing", sha256: H }],
        },
      },
    ],
  };
}

/** Ebb's files: one record collection whose page URL is its slug. */
function ebbFiles(name: string): Record<string, string> {
  return {
    "mizzen.yml":
      "title: Ebb\n" +
      "url: https://example.org\n" +
      "network:\n" +
      `  source: ${SOURCE}\n` +
      "  project: ebb\n" +
      "collections:\n" +
      "  items:\n" +
      "    source: _data/items.yml\n" +
      "    template: _templates/item.md\n" +
      "    permalink: /items/{name|slug}/\n",
    "_data/items.yml": `- id: ebb\n  name: ${name}\n- id: tide\n  name: Tide\n`,
    "_templates/item.md": '---\ntitle: "{name}"\n---\n# :field[name]\n',
  };
}

/** Offing's files: a home page and one page of cross-project links. */
function offingFiles(links: string): Record<string, string> {
  return {
    "mizzen.yml": `title: Offing\nnetwork:\n  source: ${SOURCE}\n  project: offing\n`,
    "index.md": "---\ntitle: Home\n---\nHome.\n",
    "links.md": `---\ntitle: Links\n---\n${links}\n`,
  };
}

test("a renamed record keeps its id in urls.json and answers its earlier URL through urls.lock.json", async () => {
  const root = site(ebbFiles("Ebb"));
  try {
    await writeNetworkLock(root, networkLock(["/items/ebb/", "/items/tide/"]));
    const before = await buildModel(root);
    assert.deepEqual(ids(before), []);
    const first = await urls.run(before.site, quiet);
    assert.deepEqual(JSON.parse(String(first[0]!.contents)).collections, {
      items: { ebb: "https://example.org/ebb/items/ebb/", tide: "https://example.org/ebb/items/tide/" },
    });
    await writeUrlsLock(root, before.urls.next);

    writeFileSync(join(root, "_data/items.yml"), "- id: ebb\n  name: Ebb Renamed\n- id: tide\n  name: Tide\n");
    const after = await buildModel(root, { updateUrls: true });
    assert.deepEqual(ids(after), ["urls.url-updated"]);
    const record = after.site.pages.find((page) => page.record?.id === "ebb")!;
    assert.deepEqual(record.record?.previousUrls, ["/ebb/items/ebb/"]);
    const second = await urls.run(after.site, quiet);
    assert.equal(
      JSON.parse(String(second[0]!.contents)).collections.items.ebb,
      "https://example.org/ebb/items/ebb-renamed/",
      "the record id is stable and the URL follows the slug",
    );

    const files = await redirects.run(after.site, quiet);
    const byPath = new Map(files.map((file) => [file.path, String(file.contents)]));
    assert.match(byPath.get("items/ebb/index.html") ?? "", /url=https:\/\/example\.org\/ebb\/items\/ebb-renamed\//);
    assert.equal(byPath.get("_redirects"), "/items/ebb/ https://example.org/ebb/items/ebb-renamed/ 301\n");

    await writeUrlsLock(root, after.urls.next);
    const later = await buildModel(root);
    assert.deepEqual(ids(later), [], "a later ordinary build still serves the earlier URL");
    const served = (await redirects.run(later.site, quiet)).find((file) => file.path === "items/ebb/index.html");
    assert.match(String(served?.contents), /url=https:\/\/example\.org\/ebb\/items\/ebb-renamed\//);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a cross-project link follows the locked page path, so a rename needs the lock and the link rewritten", async () => {
  const root = site(offingFiles("See [[ebb:/items/ebb/]]."));
  try {
    await writeNetworkLock(root, networkLock(["/items/ebb/", "/items/tide/"]));
    const before = await buildModel(root);
    assert.deepEqual(before.diagnostics.filter((finding) => finding.id.startsWith("network.link-")), []);
    const linked = before.site.pages.find((page) => page.title === "Links")!;
    assert.match(linked.html, /<a href="\/ebb\/items\/ebb\/">Ebb<\/a>/);

    writeFileSync(
      join(root, "links.md"),
      "---\ntitle: Links\n---\nSee [[ebb:/items/ebb/]] and [[ebb:/items/ebb-renamed/]].\n",
    );
    await writeNetworkLock(root, networkLock(["/items/ebb-renamed/", "/items/tide/"]));
    const after = await buildModel(root);
    const missing = after.diagnostics.find((finding) => finding.id === "network.link-missing-page");
    assert.equal(missing?.severity, "error");
    assert.match(missing?.message ?? "", /\[\[ebb:\/items\/ebb\/\]\]/);
    assert.equal(missing?.pos?.file, "links.md");
    const updated = after.site.pages.find((page) => page.title === "Links")!;
    assert.match(updated.html, /\[\[ebb:\/items\/ebb\/\]\]/, "the unresolvable link keeps the author's text");
    assert.match(updated.html, /<a href="\/ebb\/items\/ebb-renamed\/">Ebb<\/a>/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
