import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { main } from "../src/cli/index.ts";
import { canonicalJson } from "../src/data/lock.ts";

const evidencePath = "evidence/public.json";
const keys = generateKeyPairSync("ed25519");
const privatePem = keys.privateKey.export({ format: "pem", type: "pkcs8" });
const publicPem = keys.publicKey.export({ format: "pem", type: "spki" });

async function cli(args: readonly string[]) {
  const lines: string[] = [];
  const errors: string[] = [];
  const code = await main(["published-site", ...args], {
    log: (line) => lines.push(line),
    error: (line) => errors.push(line),
  });
  return { code, out: lines.join("\n"), err: errors.join("\n") };
}

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "mizzen-attest-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "bundle");
  mkdirSync(join(dir, ".mizzen"), { recursive: true });
  mkdirSync(join(dir, "evidence"));
  writeFileSync(join(dir, "index.html"), "<h1>Home</h1>\n");
  writeFileSync(join(dir, "index.md"), "# Home\n");
  writeFileSync(join(dir, ".mizzen", "manifest.json"), "{}\n");
  writeFileSync(join(dir, evidencePath), '{"answer":42}\n');
  const pem = join(root, "private.pem");
  writeFileSync(pem, privatePem);
  const provenancePath = join(root, "provenance.json");
  const attestationPath = join(root, "attestation.json");
  const policyPath = join(root, "policy.json");
  const provenance = {
    site: "docs.example", sourceCommit: "a".repeat(40), snapshot: "v1",
    engine: "0.2.7", theme: { name: "@velella/lateen", version: "0.2.4" }, builtOn: "2026-11-21",
    publicEvidence: { snapshot: "v1", paths: [evidencePath] },
    privateNote: "publisher-only"
  };
  const policy = { site: provenance.site, snapshot: "v1", formats: [1], minimumEvidence: 1, unsigned: "reject", keys: [publicPem] };

  async function attest(signingKey: string | null = pem, bundle = dir) {
    writeFileSync(provenancePath, JSON.stringify(provenance));
    return cli(["attest", bundle, provenancePath, ...(signingKey === null ? [] : ["--key", signingKey])]);
  }

  async function verify(attestation: string, overrides: Record<string, unknown> = {}, bundle = dir) {
    writeFileSync(attestationPath, attestation);
    writeFileSync(policyPath, JSON.stringify({ ...policy, ...overrides }));
    return cli(["verify", bundle, attestationPath, policyPath]);
  }

  return { root, dir, pem, provenance, attest, verify };
}

function findings(out: string): [string, string][] {
  return JSON.parse(out).issues.map(({ code, path }: { code: string; path: string }) => [code, path]);
}

test("detached signatures are reproducible after moving the bundle and cover all its files", async (t) => {
  const { root, dir, attest, verify } = fixture(t);
  const signed = await attest();
  assert.equal(signed.code, 0, signed.err);
  const { payload, signature } = JSON.parse(signed.out);
  assert.equal(payload.format, 1);
  assert.equal(payload.engine, "0.2.7");
  assert.equal(payload.sourceCommit, "a".repeat(40));
  assert.deepEqual(payload.theme, { name: "@velella/lateen", version: "0.2.4" });
  assert.equal(payload.signing.algorithm, "ed25519");
  assert.equal(Buffer.from(signature, "base64").length, 64);
  assert.deepEqual(Object.keys(payload.build.files), [".mizzen/manifest.json", evidencePath, "index.html", "index.md"]);
  assert.deepEqual(payload.evidence.files, { [evidencePath]: payload.build.files[evidencePath] });
  for (const privateValue of [root, "publisher-only", "PRIVATE KEY", "answer"]) {
    assert.equal(signed.out.includes(privateValue), false);
  }
  const moved = join(root, "moved");
  cpSync(dir, moved, { recursive: true });
  assert.equal((await attest(undefined, moved)).out, signed.out);
  const result = await verify(signed.out, {}, moved);
  assert.equal(result.code, 0, result.out);
  assert.deepEqual(JSON.parse(result.out).warnings, []);
});

test("verification reports altered pages, swapped evidence, missing files, and added files", async (t) => {
  const { dir, attest, verify } = fixture(t);
  const signed = await attest();
  writeFileSync(join(dir, "index.html"), "<h1>Other</h1>\n");
  writeFileSync(join(dir, evidencePath), '{"answer":43}\n');
  rmSync(join(dir, "index.md"));
  writeFileSync(join(dir, "extra.json"), "{}\n");
  const result = await verify(signed.out);
  assert.equal(result.code, 1);
  assert.deepEqual(findings(result.out), [
    ["evidence-changed", evidencePath], ["file-added", "extra.json"],
    ["file-changed", "index.html"], ["file-missing", "index.md"],
  ]);
  rmSync(join(dir, evidencePath));
  assert.deepEqual(findings((await verify(signed.out)).out)[0], ["evidence-missing", evidencePath]);
});

test("the trust policy binds site, signer, format, snapshot, evidence and freshness", async (t) => {
  const { attest, verify } = fixture(t);
  const signed = await attest();
  for (const [overrides, code] of [
    [{ keys: [] }, "signer-untrusted"],
    [{ formats: [2] }, "format-rejected"],
    [{ site: "other" }, "site-mismatch"],
    [{ snapshot: "v2" }, "snapshot-mismatch"],
    [{ minimumEvidence: 2 }, "evidence-insufficient"],
    [{ freshness: { notBefore: "2026-11-22", stale: "reject" } }, "stale"],
  ] as const) {
    const result = await verify(signed.out, overrides);
    assert.equal(result.code, 1);
    assert.equal(findings(result.out)[0]?.[0], code);
  }
  const stale = await verify(signed.out, { freshness: { notBefore: "2026-11-22", stale: "allow" } });
  assert.equal(stale.code, 0);
  assert.equal(JSON.parse(stale.out).warnings[0].code, "stale");

  const unsigned = await attest(null);
  assert.deepEqual(JSON.parse(unsigned.out).payload.signing, { algorithm: "none" });
  assert.equal(JSON.parse(unsigned.out).signature, null);
  assert.equal(findings((await verify(unsigned.out)).out)[0]?.[0], "unsigned");
  const allowed = await verify(unsigned.out, { unsigned: "allow", keys: [] });
  assert.equal(allowed.code, 0);
  assert.equal(JSON.parse(allowed.out).warnings[0].code, "unsigned");
});

test("even a trusted signature cannot bind detached hashes or evidence from another snapshot", async (t) => {
  const { provenance, attest, verify } = fixture(t);
  const signed = await attest();
  const edited = JSON.parse(signed.out);
  edited.payload.evidence.snapshot = "other";
  edited.payload.evidence.files[evidencePath] = "0".repeat(64);
  assert.equal(findings((await verify(JSON.stringify(edited))).out)[0]?.[0], "signature-invalid");

  const bytes = Buffer.from(`mizzen-site-attestation\0${canonicalJson(edited.payload)}`);
  edited.signature = sign(null, bytes, keys.privateKey).toString("base64");
  assert.deepEqual(findings((await verify(JSON.stringify(edited))).out), [
    ["evidence-snapshot-mismatch", evidencePath], ["evidence-detached", evidencePath],
  ]);
  edited.payload.build.hash = "0".repeat(64);
  edited.signature = sign(null, Buffer.from(`mizzen-site-attestation\0${canonicalJson(edited.payload)}`), keys.privateKey).toString("base64");
  assert.equal(findings((await verify(JSON.stringify(edited))).out)[0]?.[0], "build-hash-mismatch");
  provenance.publicEvidence.snapshot = "other";
  assert.match((await attest()).err, /must match the build snapshot/);
});

test("invalid metadata, policies, keys and unsupported bundle entries fail closed", async (t) => {
  const { root, dir, pem, provenance, attest, verify } = fixture(t);
  const signed = await attest();
  const parsed = JSON.parse(signed.out);
  parsed.payload.format = 2;
  assert.equal(findings((await verify(JSON.stringify(parsed), { formats: [2] })).out)[0]?.[0], "format-rejected");
  assert.equal(findings((await verify("{")).out)[0]?.[0], "attestation-unreadable");
  assert.equal(findings((await verify("{}")).out)[0]?.[0], "attestation-malformed");
  const badPolicy = await verify(signed.out, { unsigned: "maybe" });
  assert.equal(badPolicy.code, 2);
  assert.match(badPolicy.err, /trust policy/);
  assert.match((await verify(signed.out, { keys: [privatePem] })).err, /public PEM/);
  assert.equal(findings((await verify(signed.out, {}, join(root, "missing"))).out)[0]?.[0], "bundle-unreadable");

  const nestedKey = join(dir, "private.pem");
  cpSync(pem, nestedKey);
  assert.match((await attest(nestedKey)).err, /outside the public bundle/);
  rmSync(nestedKey);
  if (process.platform !== "win32") {
    symlinkSync(pem, join(dir, "link"));
    assert.deepEqual(findings((await verify(signed.out)).out), [["bundle-entry-unsupported", "link"]]);
    rmSync(join(dir, "link"));
  }
  provenance.publicEvidence.paths = ["../private.pem"];
  assert.match((await attest()).err, /relative bundle paths/);
  provenance.publicEvidence.paths = ["missing.json"];
  assert.match((await attest()).err, /evidence is missing/);
  provenance.site = root;
  assert.match((await attest()).err, /provenance needs/);
});
