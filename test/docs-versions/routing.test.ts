import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildModel } from "../../src/model/build.ts";
import { resolveVersionRouting, type VersionRouting } from "../../src/versions/routing.ts";

const FIXTURE = fileURLToPath(new URL("../../fixtures/docs-versions/", import.meta.url));
const { site } = await buildModel(FIXTURE);
const base = site.config.base;

/** A route as `file|state|canonical|versioned|urls`, so a whole table reads in one assertion. */
function table(routing: VersionRouting): string[] {
  return routing.routes.map((route) =>
    [route.page.source.file, route.state, route.canonical ?? "-", route.versioned ?? "-", route.urls.join(",") || "-"].join("|"),
  );
}

/** Every versioned page and the URL it keeps, in route order. */
function versionedUrls(routing: VersionRouting): string[] {
  return routing.routes
    .filter((route) => route.versioned !== null)
    .map((route) => `${route.page.source.file}|${route.versioned}`);
}

test("the fixture's v2 default owns canonical URLs while v1 keeps its versioned URLs", () => {
  const routing = resolveVersionRouting(site.pages, site.data.versions, { base });

  assert.deepEqual(routing.diagnostics, []);
  assert.deepEqual(routing.settings, { default: "v2", old: ["v1"] });
  assert.deepEqual(table(routing), [
    "v1/guide/install.md|old|-|/v1/guide/install/|/v1/guide/install/",
    "v1/guide/legacy.md|old|-|/v1/guide/legacy/|/v1/guide/legacy/",
    "v1/guide/upgrade.md|old|-|/v1/guide/upgrade/|/v1/guide/upgrade/",
    "v2/guide/deploy.md|default|/guide/deploy/|/v2/guide/deploy/|/guide/deploy/,/v2/guide/deploy/",
    "v2/guide/install.md|default|/guide/install/|/v2/guide/install/|/guide/install/,/v2/guide/install/",
    "v2/guide/upgrade.md|default|/guide/upgrade/|/v2/guide/upgrade/|/guide/upgrade/,/v2/guide/upgrade/",
    "README.md|current|-|-|-",
    "guide/install.md|current|-|-|-",
    "guide/upgrade.md|current|-|-|-",
  ]);
});

test("switching the default moves the canonical alias and leaves every versioned URL where it was", () => {
  const defaults = resolveVersionRouting(site.pages, site.data.versions, { base });
  const switched = resolveVersionRouting(site.pages, { default: "v1", old: ["v2"] }, { base });

  assert.deepEqual(switched.diagnostics, []);
  assert.deepEqual(versionedUrls(switched), versionedUrls(defaults));
  assert.deepEqual(table(switched), [
    "v1/guide/install.md|default|/guide/install/|/v1/guide/install/|/guide/install/,/v1/guide/install/",
    "v1/guide/legacy.md|default|/guide/legacy/|/v1/guide/legacy/|/guide/legacy/,/v1/guide/legacy/",
    "v1/guide/upgrade.md|default|/guide/upgrade/|/v1/guide/upgrade/|/guide/upgrade/,/v1/guide/upgrade/",
    "v2/guide/deploy.md|old|-|/v2/guide/deploy/|/v2/guide/deploy/",
    "v2/guide/install.md|old|-|/v2/guide/install/|/v2/guide/install/",
    "v2/guide/upgrade.md|old|-|/v2/guide/upgrade/|/v2/guide/upgrade/",
    "README.md|current|-|-|-",
    "guide/install.md|current|-|-|-",
    "guide/upgrade.md|current|-|-|-",
  ]);
});

test("a site without version settings keeps current docs canonical and every release reachable", () => {
  const unversioned = resolveVersionRouting(site.pages, undefined, { base });

  assert.deepEqual(unversioned.diagnostics, []);
  assert.deepEqual(unversioned.settings, { default: "current", old: [] });
  assert.deepEqual(table(unversioned), [
    "v1/guide/install.md|released|-|/v1/guide/install/|/v1/guide/install/",
    "v1/guide/legacy.md|released|-|/v1/guide/legacy/|/v1/guide/legacy/",
    "v1/guide/upgrade.md|released|-|/v1/guide/upgrade/|/v1/guide/upgrade/",
    "v2/guide/deploy.md|released|-|/v2/guide/deploy/|/v2/guide/deploy/",
    "v2/guide/install.md|released|-|/v2/guide/install/|/v2/guide/install/",
    "v2/guide/upgrade.md|released|-|/v2/guide/upgrade/|/v2/guide/upgrade/",
    "README.md|current|/|-|/",
    "guide/install.md|current|/guide/install/|-|/guide/install/",
    "guide/upgrade.md|current|/guide/upgrade/|-|/guide/upgrade/",
  ]);

  const explicit = resolveVersionRouting(site.pages, { default: "current" }, { base });
  assert.deepEqual(explicit.routes, unversioned.routes);
});

test("canonical aliases keep the site base, and both default URLs carry it", () => {
  const page = (file: string, url: string) => ({
    source: { file, line: 1, column: 1, endLine: 1, endColumn: 1 },
    url,
  });
  const routing = resolveVersionRouting(
    [page("v2/guide/install.md", "/docs/v2/guide/install/"), page("guide/install.md", "/docs/guide/install/")],
    { default: "v2" },
    { base: "/docs" },
  );

  assert.deepEqual(routing.diagnostics, []);
  assert.deepEqual(table(routing), [
    "v2/guide/install.md|default|/docs/guide/install/|/docs/v2/guide/install/|/docs/guide/install/,/docs/v2/guide/install/",
    "guide/install.md|current|-|-|-",
  ]);
});

test("invalid dispositions and a versionless permalink are diagnosed, never routed", () => {
  const routing = resolveVersionRouting(site.pages, { default: "v2", old: ["v2", "v2", "v9"], extra: true }, { base });
  assert.deepEqual(
    routing.diagnostics.map((diagnostic) => diagnostic.id),
    ["versions.unknown-key", "versions.old-duplicate", "versions.default-old", "versions.old-missing"],
  );

  const broken = resolveVersionRouting(
    [
      {
        source: { file: "v2/guide/install.md", line: 1, column: 1, endLine: 1, endColumn: 1 },
        url: "/install/",
      },
    ],
    { default: "v2" },
    { base },
  );
  assert.deepEqual(
    broken.diagnostics.map((diagnostic) => diagnostic.id),
    ["versions.permalink"],
  );
  assert.deepEqual(broken.routes[0]?.urls, []);
  assert.equal(broken.routes[0]?.versioned, null);
});
