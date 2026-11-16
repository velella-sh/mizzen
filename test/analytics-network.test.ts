import assert from "node:assert/strict";
import { test } from "node:test";
import { analyticsScripts } from "../src/analytics/script.ts";
import { resolveAnalytics } from "../src/analytics/network.ts";
import { config, page, site } from "./helpers-analytics.ts";

const network = { analytics: { provider: "plausible", site: "shared.example" } } as const;

test("a site with no key of its own uses the network's", () => {
  assert.deepEqual(resolveAnalytics(undefined, network, undefined), { config: network.analytics });
  assert.equal(resolveAnalytics(undefined, undefined, "a"), undefined);
});

test("a site's own key wins over the network's", () => {
  const own = { provider: "umami", site: "mine" } as const;
  assert.equal(resolveAnalytics(own, network, "a")?.config.provider, "umami");
});

test("two projects send their own path as the label", () => {
  const model = site(config());
  const one = analyticsScripts(model, page(), { network, project: "/one" });
  const two = analyticsScripts(model, page(), { network, project: "/two" });
  assert.equal(one[0]?.attrs?.["data-project"], "/one");
  assert.equal(two[0]?.attrs?.["data-project"], "/two");
  assert.equal(one[0]?.attrs?.["data-domain"], "shared.example");
});
