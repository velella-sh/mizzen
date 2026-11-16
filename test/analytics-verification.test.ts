import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config/load.ts";
import { headMeta } from "../src/outputs/head-meta.ts";
import { verification } from "../src/outputs/verification.ts";
import { config, page, site } from "./helpers-analytics.ts";

const google = "abcdefghijklmnopqrstuvwxyz012345";
const bing = "0123456789ABCDEF0123456789ABCDEF";
const ctx = { renderPage: async () => "", report: () => {} };

test("each configured provider gets its tag on the home page only", () => {
  const model = site(config({ verify: { google, bing } }));
  const home = headMeta(model, page("/"), []).meta;
  assert.deepEqual(home.filter((m) => m.name === "google-site-verification" || m.name === "msvalidate.01"), [
    { name: "google-site-verification", content: google },
    { name: "msvalidate.01", content: bing },
  ]);
  assert.equal(headMeta(model, page("/guide/"), []).meta.some((m) => m.name === "msvalidate.01"), false);
});

test("a provider not configured writes no tag and no file", async () => {
  const model = site(config({ verify: { google } }));
  assert.equal(headMeta(model, page("/"), []).meta.some((m) => m.name === "msvalidate.01"), false);
  assert.deepEqual(await verification.run(model, ctx), []);
  assert.deepEqual(await verification.run(site(config()), ctx), []);
});

test("verification files are written at the site root", async () => {
  const files = await verification.run(site(config({ verify: { googleFile: "google0123456789abcdef.html", bingFile: bing } })), ctx);
  assert.deepEqual(files.map((f) => f.path), ["BingSiteAuth.xml", "google0123456789abcdef.html"]);
  assert.equal(files[1]!.contents, "google-site-verification: google0123456789abcdef.html\n");
  assert.match(String(files[0]!.contents), new RegExp(`<user>${bing}</user>`));
});

test("a value outside the provider's format is an error", () => {
  const root = mkdtempSync(join(tmpdir(), "verify-"));
  try {
    writeFileSync(join(root, "mizzen.yml"), 'verify:\n  google: "bad value!"\n  bingFile: "xyz"\n  googleFile: "../x.html"\n');
    const { diagnostics } = loadConfig(root);
    assert.ok(diagnostics.filter((d) => d.severity === "error").length >= 3);
  } finally {
    rmSync(root, { recursive: true });
  }
});
