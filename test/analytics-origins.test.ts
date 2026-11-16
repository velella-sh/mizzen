import assert from "node:assert/strict";
import { test } from "node:test";
import { pageOrigins, siteOrigins, unlistedOrigins } from "../src/analytics/origins.ts";
import { manifest } from "../src/outputs/manifest.ts";
import { originReport } from "../src/outputs/origin-report.ts";
import type { Diagnostic } from "../src/contracts/index.ts";
import { config, page, site } from "./helpers-analytics.ts";

const analytics = { provider: "plausible", site: "example.com" } as const;
const ctx = (found: Diagnostic[]) => ({ renderPage: async () => "", report: (d: Diagnostic) => void found.push(d) });

test("a page's scripts, styles, fonts and images are listed by origin", () => {
  const html =
    '<img src="https://img.test/a.png"><script src="//cdn.test/x.js"></script><a href="https://link.test/">x</a>' +
    '<div style="background:url(https://font.test/f.woff2)"></div><img src="/local.png">';
  assert.deepEqual(pageOrigins(html).sort(), ["https://cdn.test", "https://font.test", "https://img.test"]);
});

test("a clean site lists only the analytics origin, and warns about nothing", async () => {
  const model = site(config({ analytics }), [page("/", { html: '<img src="https://example.test/a.png">' })]);
  assert.deepEqual(siteOrigins(model), ["https://plausible.io"]);
  const found: Diagnostic[] = [];
  await originReport.run(model, ctx(found));
  assert.deepEqual(found.filter((d) => d.severity === "warning"), []);
});

test("one extra origin warns unless it is allowed", async () => {
  const html = '<img src="https://extra.test/a.png">';
  const model = site(config({ analytics }), [page("/", { html })]);
  assert.deepEqual(unlistedOrigins(model), ["https://extra.test"]);
  const found: Diagnostic[] = [];
  await originReport.run(model, ctx(found));
  assert.deepEqual(found.filter((d) => d.severity === "warning").map((d) => d.id), ["origins.unlisted"]);
  const allowed = site(config({ analytics: { ...analytics, allowedOrigins: ["https://extra.test"] } }), [page("/", { html })]);
  assert.deepEqual(unlistedOrigins(allowed), []);
});

test("the manifest lists the origins only when the site sets analytics", async () => {
  const html = '<img src="https://extra.test/a.png">';
  const withKey = await manifest.run(site(config({ analytics }), [page("/", { html })]), ctx([]));
  assert.deepEqual(JSON.parse(String(withKey[0]!.contents)).origins, ["https://extra.test", "https://plausible.io"]);
  const without = await manifest.run(site(config(), [page("/", { html })]), ctx([]));
  assert.equal("origins" in JSON.parse(String(without[0]!.contents)), false);
});
