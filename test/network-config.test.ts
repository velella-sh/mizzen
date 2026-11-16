import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfigText } from "../src/config/load.ts";

const load = (text: string) => loadConfigText(text, "mizzen.yml", "site");

test("a valid network key is kept", () => {
  const { config, diagnostics } = load("network:\n  source: https://example.org/network.json\n  project: alpha\n  maxAgeDays: 7\n");
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(config.network, { source: "https://example.org/network.json", project: "alpha", maxAgeDays: 7 });
});

test("a site without the key has no network and no finding", () => {
  const { config, diagnostics } = load("title: Solo\n");
  assert.deepEqual(diagnostics, []);
  assert.equal(config.network, undefined);
  assert.equal("network" in config, false);
});

test("the key needs a source and a project, and has no default source", () => {
  const missing = load("network:\n  project: alpha\n");
  assert.ok(missing.diagnostics.some((d) => d.id === "config.invalid" && /source/.test(d.message)));
  assert.equal(missing.config.network, undefined);
  const bad = load("network:\n  source: ./network.json\n  project: Alpha Beta\n");
  assert.ok(bad.diagnostics.some((d) => d.severity === "error" && d.pos?.line === 3));
});

test("an unknown key inside network is an error at its line", () => {
  const { diagnostics } = load("network:\n  source: ./n.json\n  project: alpha\n  mirror: x\n");
  assert.equal(diagnostics[0]?.id, "config.unknown-key");
  assert.equal(diagnostics[0]?.pos?.line, 4);
});
