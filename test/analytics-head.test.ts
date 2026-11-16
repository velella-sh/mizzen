import assert from "node:assert/strict";
import { test } from "node:test";
import type { AnalyticsConfig } from "../src/contracts/index.ts";
import { headMeta } from "../src/outputs/head-meta.ts";
import { config, page, site } from "./helpers-analytics.ts";

const providers: AnalyticsConfig[] = [
  { provider: "goatcounter", site: "docs" },
  { provider: "plausible", site: "example.com" },
  { provider: "umami", site: "id-1" },
  { provider: "cloudflare", site: "tok" },
  { provider: "custom", src: "https://a.test/x.js" },
];

test("every page of a build carries the same one tag for each provider", () => {
  for (const analytics of providers) {
    const model = site(config({ analytics }));
    const tags = [page("/"), page("/a/"), page("/b/c/")].map((p) => headMeta(model, p, []).scripts);
    for (const scripts of tags) {
      assert.equal(scripts?.length, 1, analytics.provider);
      assert.deepEqual(scripts, tags[0]);
      assert.match(scripts![0]!.src, /^https:\/\//);
    }
  }
});

test("two computations are byte-identical, and a site without the key has no script", () => {
  const model = site(config({ analytics: providers[1]! }));
  assert.equal(JSON.stringify(headMeta(model, page(), [])), JSON.stringify(headMeta(model, page(), [])));
  assert.deepEqual(headMeta(site(config()), page(), []).scripts, []);
});
