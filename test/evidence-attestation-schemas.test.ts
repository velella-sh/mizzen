import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import { main } from "../src/cli/index.ts";
import { canonicalJson, sha256 } from "../src/data/lock.ts";

const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;
const schema = (name: string) => JSON.parse(readFileSync(new URL(`../schema/${name}.schema.json`, import.meta.url), "utf8")) as object;

async function cli(args: readonly string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(args, { log: (line) => out.push(line), error: (line) => err.push(line) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

function validator(name: string) {
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema(name));
  return (value: unknown) => {
    assert.equal(validate(value), true, `${name}: ${JSON.stringify(validate.errors)}`);
  };
}

test("the evidence envelope, lock, and report schemas accept what ingest and build produce, and reject a malformed one", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "mizzen-evidence-schema-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const site = join(root, "site");
  const theme = join(root, "theme");
  mkdirSync(join(theme, "src"), { recursive: true });
  mkdirSync(join(theme, "layouts"));
  mkdirSync(site);
  writeFileSync(join(theme, "src/index.ts"), 'export const theme = { name: "test", folders: ["layouts"] };\n');
  writeFileSync(join(theme, "layouts/doc.ts"), 'export default () => "<html><head></head><body></body></html>";\n');
  writeFileSync(join(site, "index.md"), "# Home\n");
  writeFileSync(join(site, "mizzen.yml"), "title: Evidence\n");

  const target = { surface: "cli:install", behavior: "install" };
  const payload = {
    schema: "test-json@1",
    catalog: [{ suite: "cli", name: "install", ...target }],
    results: [{ suite: "cli", name: "install", outcome: "passed" }],
  };
  const envelope = {
    version: 1, kind: "test", id: "tests", origin: "https://ci.example/evidence", snapshot: "v1",
    executedAt: "2026-11-20T02:23:01Z", payloadSha256: sha256(canonicalJson(payload)), payload,
  };
  validator("evidence-envelope")(envelope);
  const invalid = new Ajv2020({ strict: true }).compile(schema("evidence-envelope"));
  assert.equal(invalid({ ...envelope, origin: "http://ci.example" }), false);
  assert.equal(invalid({ ...envelope, payloadSha256: "xyz" }), false);

  const envelopeFile = join(root, "envelope.json");
  writeFileSync(envelopeFile, JSON.stringify(envelope));
  const ingested = await cli(["evidence", "ingest", envelopeFile, site]);
  assert.equal(ingested.code, 0, ingested.err);

  const lock = {
    version: 1, snapshot: { id: "v1", commit: "a".repeat(40), configSha256: "b".repeat(64) }, maxAgeDays: 14,
    pins: { tests: { sha256: ingested.out } }, surfaces: [target.surface],
    claims: [{ id: "install-guide", subject: { kind: "page", id: "/" }, ...target, evidence: ["tests"] }],
  };
  validator("evidence-lock")(lock);
  writeFileSync(join(site, "evidence.lock.json"), JSON.stringify(lock));

  const out = join(root, "out");
  const built = await cli(["build", site, "--theme", theme, "--out", out, "--as-of", "2026-11-23"]);
  assert.equal(built.code, 0, built.err || built.out);
  const report = JSON.parse(readFileSync(join(out, ".mizzen", "evidence.json"), "utf8"));
  validator("evidence-report")(report);
  assert.equal(report.claims[0].status, "verified");
});

test("the site attestation schema accepts signed and unsigned attestations the CLI prints", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "mizzen-attestation-schema-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bundle = join(root, "bundle");
  mkdirSync(join(bundle, "evidence"), { recursive: true });
  writeFileSync(join(bundle, "index.html"), "<h1>Home</h1>\n");
  writeFileSync(join(bundle, "evidence/public.json"), '{"answer":42}\n');
  writeFileSync(join(root, "provenance.json"), JSON.stringify({
    site: "docs.example", sourceCommit: "a".repeat(40), snapshot: "v1", engine: "0.2.7",
    theme: { name: "@velella/lateen", version: "0.2.5" }, builtOn: "2026-11-21",
    publicEvidence: { snapshot: "v1", paths: ["evidence/public.json"] },
  }));
  writeFileSync(join(root, "private.pem"), generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }));
  const valid = validator("site-attestation");
  const signed = await cli(["published-site", "attest", bundle, join(root, "provenance.json"), "--key", join(root, "private.pem")]);
  assert.equal(signed.code, 0, signed.err);
  const signedValue = JSON.parse(signed.out);
  valid(signedValue);
  assert.equal(signedValue.payload.signing.algorithm, "ed25519");
  const unsigned = await cli(["published-site", "attest", bundle, join(root, "provenance.json")]);
  assert.equal(unsigned.code, 0, unsigned.err);
  valid(JSON.parse(unsigned.out));
  const strict = new Ajv2020({ strict: true }).compile(schema("site-attestation"));
  assert.equal(strict({ ...signedValue, extra: true }), false);
  assert.equal(strict({ ...signedValue, payload: { ...signedValue.payload, extra: 1 } }), false);
});
