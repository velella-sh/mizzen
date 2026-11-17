// The epic's acceptance case: two pages, one shared fragment, two sets of values. Both pages show their own values,
// both name the fragment's file and line as the origin of its text, and editing the fragment updates both.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Diagnostic, Page, Site, SourcePos } from "../../src/contracts/index.ts";
import { buildModel } from "../../src/model/build.ts";

const FIXTURE = join(import.meta.dirname, "../../fixtures/content-includes");

/** The fixture in a temporary folder, so a case can edit its fragment; the caller removes it. */
function copyFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "include-acceptance-"));
  cpSync(FIXTURE, root, { recursive: true });
  return root;
}

/** The page at `url`; a missing page fails the case with the URLs that exist. */
function pageOf(site: Site, url: string): Page {
  const page = site.pages.find((entry) => entry.url === url);
  assert.ok(page !== undefined, `${url} is built; got ${site.pages.map((entry) => entry.url).join(", ")}`);
  return page;
}

/** The one finding with `id`, so a case can assert where it points. */
function finding(diagnostics: readonly Diagnostic[], id: string): Diagnostic & { readonly pos: SourcePos } {
  const found = diagnostics.filter((diagnostic) => diagnostic.id === id);
  assert.equal(found.length, 1, `expected one ${id}, got ${diagnostics.map((d) => d.id).join(", ") || "none"}`);
  const one = found[0]!;
  assert.ok(one.pos !== undefined, `${id} has a position`);
  return one as Diagnostic & { readonly pos: SourcePos };
}

test("both pages expand the shared fragment with their own values and the fragment's source lines", async () => {
  const root = copyFixture();
  try {
    const { site, diagnostics } = await buildModel(root);
    assert.deepEqual(diagnostics.filter((diagnostic) => diagnostic.severity === "error"), []);

    const beacon = pageOf(site, "/guide/beacon/");
    const orbit = pageOf(site, "/guide/orbit/");

    // Each page keeps its own intro at its own line, and the fragment's body after it.
    assert.match(beacon.html, /^<p data-src="guide\/beacon\.md:4:1-4:23">Beacon runs on Node 24\.<\/p>/);
    assert.match(orbit.html, /^<p data-src="guide\/orbit\.md:4:1-4:22">Orbit runs on Node 24\.<\/p>/);

    // Values come from each call site: defaults for Beacon, every override for Orbit.
    assert.match(beacon.html, /data-src="_snippets\/install\.md:8:1-8:22">Install Beacon<\/h2>/);
    assert.match(beacon.html, /data-src="_snippets\/install\.md:10:1-10:38">The Standard edition installs with:/);
    assert.match(beacon.html, /npm install @acme\/beacon/);
    assert.match(beacon.html, /Questions go to the <em>Beacon<\/em> team\./);
    assert.match(orbit.html, /data-src="_snippets\/install\.md:8:1-8:22">Install Orbit<\/h2>/);
    assert.match(orbit.html, /data-src="_snippets\/install\.md:10:1-10:38">The Team edition installs with:/);
    assert.match(orbit.html, /npm install @acme\/orbit/);
    assert.match(orbit.html, /Questions go to the Orbit team\./);
    assert.match(beacon.html, /data-src="_snippets\/install\.md:18:1-18:82">Questions go to/);
    assert.match(orbit.html, /data-src="_snippets\/install\.md:18:1-18:82">Questions go to/);

    // The nested fragment keeps its own origin on both pages.
    assert.match(beacon.html, /data-src="_snippets\/upgrade\.md:1:1-1:56"/);
    assert.match(orbit.html, /data-src="_snippets\/upgrade\.md:1:1-1:56"/);

    // The heading record points at the fragment too, not at the page that included it.
    for (const page of [beacon, orbit]) {
      assert.deepEqual(page.headings.map((heading) => heading.pos), [
        { file: "_snippets/install.md", line: 8, column: 1, endLine: 8, endColumn: 22 },
      ]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("changing the shared text updates both pages and keeps the fragment's source line", async () => {
  const root = copyFixture();
  try {
    const fragment = join(root, "_snippets/install.md");
    writeFileSync(fragment, readFileSync(fragment, "utf8").replace("Questions go to", "Reach out to"));
    const { site, diagnostics } = await buildModel(root);
    assert.deepEqual(diagnostics.filter((diagnostic) => diagnostic.severity === "error"), []);

    for (const [url, value] of [
      ["/guide/beacon/", "the <em>Beacon</em> team"],
      ["/guide/orbit/", "the Orbit team"],
    ] as const) {
      const page = pageOf(site, url);
      assert.match(page.html, new RegExp(`data-src="_snippets/install\\.md:18:1-18:\\d+">Reach out to ${value}\\.`));
      assert.doesNotMatch(page.html, /Questions go to/);
      assert.deepEqual(page.headings[0]?.pos, {
        file: "_snippets/install.md",
        line: 8,
        column: 1,
        endLine: 8,
        endColumn: 22,
      });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a required value that is missing points at the directive line on each page", async () => {
  const root = copyFixture();
  try {
    const beacon = join(root, "guide/beacon.md");
    writeFileSync(beacon, readFileSync(beacon, "utf8").replace('{support="the *Beacon* team"}', ""));
    const orbit = join(root, "guide/orbit.md");
    writeFileSync(orbit, readFileSync(orbit, "utf8").replace(' support="the Orbit team"', ""));

    const { site, diagnostics } = await buildModel(root);
    const missing = diagnostics.filter((diagnostic) => diagnostic.id === "include.param-missing");
    assert.deepEqual(
      missing.map((diagnostic) => diagnostic.pos),
      [
        { file: "guide/beacon.md", line: 6, column: 1, endLine: 6, endColumn: 34 },
        { file: "guide/orbit.md", line: 6, column: 1, endLine: 6, endColumn: 88 },
      ],
    );
    // The placeholder stays visible, so the gap is visible on the page.
    assert.match(pageOf(site, "/guide/beacon/").html, /\{\{support\}\}/);
    assert.match(pageOf(site, "/guide/orbit/").html, /\{\{support\}\}/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
