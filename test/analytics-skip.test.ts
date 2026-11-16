import assert from "node:assert/strict";
import { test } from "node:test";
import { analyticsScripts } from "../src/analytics/script.ts";
import { skipsAnalytics } from "../src/analytics/skip.ts";
import { config, page, site } from "./helpers-analytics.ts";

const model = site(config({ analytics: { provider: "plausible", site: "example.com" } }));

test("a page with `analytics: false` has no script", () => {
  const off = page("/x/", { frontMatter: { analytics: false } });
  assert.equal(skipsAnalytics(off), true);
  assert.deepEqual(analyticsScripts(model, off), []);
  assert.equal(analyticsScripts(model, page("/y/")).length, 1);
});

test("a page built with the embedded layout has no script", () => {
  assert.deepEqual(analyticsScripts(model, page("/e/", { frontMatter: { layout: "embedded" } })), []);
});

test("a page of a project that is not public has no script", () => {
  assert.deepEqual(analyticsScripts(model, page(), { projectPublic: false }), []);
});

test("the URL never decides", () => {
  assert.equal(analyticsScripts(model, page("/embedded/")).length, 1);
  assert.equal(analyticsScripts(model, page("/private/")).length, 1);
});
