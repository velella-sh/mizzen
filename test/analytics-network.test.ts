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

test("a build passes the locked network's setting and the project path", () => {
  const net = {
    current: "lateen",
    lock: "x",
    analytics: { provider: "plausible", site: "shared.example" },
    projects: [{ id: "lateen", path: "lateen", title: "Lateen", current: true }],
  } as const;
  const model = { ...site(config()), network: net };
  const tag = analyticsScripts(model, page())[0];
  assert.equal(tag?.attrs?.["data-project"], "lateen");
  assert.equal(tag?.attrs?.["data-domain"], "shared.example");
  assert.deepEqual(analyticsScripts(model, page()), analyticsScripts(model, page("/other/")));
});

test("the site's own key wins and still carries the project label", () => {
  const net = { current: "a", lock: "x", analytics: { provider: "plausible", site: "shared.example" }, projects: [{ id: "a", path: "a", title: "A", current: true }] } as const;
  const model = { ...site(config({ analytics: { provider: "umami", site: "mine" } })), network: net };
  assert.equal(analyticsScripts(model, page()).length, 1);
  assert.equal(analyticsScripts(model, page())[0]?.attrs?.["data-domain"], undefined);
});

test("analytics: false, embedded layout and non-public projects get none", () => {
  const net = { current: "a", lock: "x", analytics: { provider: "plausible", site: "s.example" }, projects: [{ id: "a", path: "a", title: "A", current: true }] } as const;
  const model = { ...site(config()), network: net };
  assert.deepEqual(analyticsScripts(model, page("/", { frontMatter: { analytics: false } })), []);
  assert.deepEqual(analyticsScripts(model, page("/", { frontMatter: { layout: "embedded" } })), []);
  const hidden = { ...model, network: { ...net, projects: [] } };
  assert.deepEqual(analyticsScripts(hidden, page()), []);
});

test("a site with no network is unchanged", () => {
  assert.deepEqual(analyticsScripts(site(config()), page()), []);
});
