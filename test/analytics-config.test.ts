import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { providerOrigins, providerScript } from "../src/analytics/providers.ts";
import { loadConfig } from "../src/config/load.ts";

function load(yml: string) {
  const root = mkdtempSync(join(tmpdir(), "analytics-config-"));
  try {
    writeFileSync(join(root, "mizzen.yml"), yml);
    return loadConfig(root);
  } finally {
    rmSync(root, { recursive: true });
  }
}

test("each provider builds its script from the one table", () => {
  assert.deepEqual(providerScript({ provider: "goatcounter", site: "docs" }), {
    src: "https://gc.zgo.at/count.js",
    attrs: { "data-goatcounter": "https://docs.goatcounter.com/count" },
  });
  assert.deepEqual(providerScript({ provider: "plausible", site: "example.com" }), {
    src: "https://plausible.io/js/script.js",
    attrs: { "data-domain": "example.com" },
  });
  assert.deepEqual(providerScript({ provider: "umami", site: "abc", host: "https://stats.example.com/" }), {
    src: "https://stats.example.com/script.js",
    attrs: { "data-website-id": "abc" },
  });
  assert.deepEqual(providerScript({ provider: "cloudflare", site: "tok" }), {
    src: "https://static.cloudflareinsights.com/beacon.min.js",
    attrs: { "data-cf-beacon": '{"token":"tok"}' },
  });
  assert.deepEqual(providerScript({ provider: "custom", src: "https://a.test/x.js", attrs: { "data-k": "v" } }), {
    src: "https://a.test/x.js",
    attrs: { "data-k": "v" },
  });
  assert.deepEqual(providerOrigins({ provider: "plausible", site: "x" }), ["https://plausible.io"]);
});

test("a provider without the value it needs writes no script", () => {
  assert.equal(providerScript({ provider: "umami" }), undefined);
  assert.equal(providerScript({ provider: "custom" }), undefined);
});

test("the analytics key loads, and a site without it has none", () => {
  const ok = load("analytics:\n  provider: plausible\n  site: example.com\n");
  assert.deepEqual(ok.diagnostics, []);
  assert.equal(ok.config.analytics?.provider, "plausible");
  const none = load("title: X\n");
  assert.equal(none.config.analytics, undefined);
});

test("a missing site, a missing custom src, and an unknown provider are errors", () => {
  assert.ok(load("analytics:\n  provider: umami\n").diagnostics.some((d) => d.severity === "error"));
  assert.ok(load("analytics:\n  provider: custom\n").diagnostics.some((d) => d.severity === "error"));
  assert.ok(load("analytics:\n  provider: other\n  site: x\n").diagnostics.some((d) => d.severity === "error"));
  assert.ok(load("analytics:\n  provider: custom\n  src: http://a.test/x.js\n").diagnostics.some((d) => d.severity === "error"));
});
