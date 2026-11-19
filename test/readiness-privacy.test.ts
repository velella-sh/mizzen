/**
 * Public reports and badges: no machine paths, tokens, private pages, or page content. Issue #1268.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { ReadinessFinding, ReadinessReport } from "../src/contracts/readiness.ts";
import { badgeSvg } from "../src/readiness/badge.ts";
import { readinessDigest, readinessReport, verifyReadinessReport } from "../src/readiness/report.ts";
import { redactReadinessReport } from "../src/readiness/redact.ts";
import { finding, pageScope } from "../src/readiness/findings.ts";
import { scanBuild } from "../src/readiness/scan.ts";
import { buildFixture, type BuiltFixture } from "./readiness-fixture.ts";

let built: BuiltFixture;
let report: ReadinessReport;

before(async () => {
  built = await buildFixture();
  report = readinessReport(await scanBuild(built.out));
});

after(() => built.cleanup());

/** A report with these findings, re-digested so it is otherwise valid. */
function withFindings(findings: readonly ReadinessFinding[], evidence?: string): ReadinessReport {
  const { digest: _digest, ...rest } = report;
  const next = { ...rest, findings, ...(evidence === undefined ? {} : { evidence }) };
  return { ...next, digest: readinessDigest(next) };
}

test("the scan report carries no page text, description, prompt, or machine path", () => {
  const json = JSON.stringify(report);
  assert.equal(json.includes(built.parent), false);
  assert.equal(json.includes("/Users/"), false);
  assert.equal(json.includes("How to use the fixture."), false);
  assert.equal(json.includes("console.log"), false);
  assert.equal(json.includes("Edit this file."), false);
});

test("a non-http evidence link is dropped instead of published", async () => {
  const scan = await scanBuild(built.out);
  const local = readinessReport({ ...scan, outcomes: [] }, { evidence: "file:///Users/me/report.html" });
  assert.equal(local.evidence, undefined);
  const publicLink = readinessReport({ ...scan, outcomes: [] }, { evidence: "https://ci.example/builds/1" });
  assert.equal(publicLink.evidence, "https://ci.example/builds/1");
});

test("redaction drops private pages and private sources, and removes paths, tokens, and credentials", () => {
  const dirty = withFindings(
    [
      finding("context.packs", {
        scope: pageScope("/private/secret/"),
        message: "The private page at /Users/me/site/private/secret.md has no pack.",
        evidence: "read /Users/me/site/private/secret.md",
      }),
      finding("structure.sourcemap", {
        scope: pageScope("/guide/"),
        message: "A span came from /home/me/work/site/guide/index.md.",
        evidence: "see https://ci.example/log?token=abc123&job=7 and Bearer abc.def.ghi",
        pos: { file: "guide/index.md", line: 1, column: 1, endLine: 1, endColumn: 2 },
      }),
      finding("maintenance.state", {
        scope: pageScope("/guide/"),
        message: "Source secret/page.md is private.",
        evidence: "key=secret-value",
        pos: { file: "secret/page.md", line: 2, column: 1, endLine: 2, endColumn: 4 },
      }),
      finding("verification.digest", {
        scope: pageScope("/reference/"),
        message: "Password: hunter2",
        evidence: "api_key=top-secret",
      }),
    ],
    "https://ci.example/build?access_token=leak-me",
  );

  const clean = redactReadinessReport(dirty, { privatePages: ["/private/"], privateSources: ["secret/"] });
  const json = JSON.stringify(clean);
  assert.equal(json.includes("/private/secret/"), false, "private page is dropped");
  assert.equal(json.includes("secret/page.md"), false, "private source is dropped");
  assert.equal(json.includes("/Users/me"), false);
  assert.equal(json.includes("/home/me"), false);
  assert.equal(json.includes("abc123"), false);
  assert.equal(json.includes("abc.def.ghi"), false);
  assert.equal(json.includes("hunter2"), false);
  assert.equal(json.includes("top-secret"), false);
  assert.equal(json.includes("leak-me"), false);
  assert.match(clean.evidence ?? "", /<redacted>/);
  assert.equal(clean.privacy.public, true);
  assert.equal(clean.privacy.redacted > 0, true);
  assert.equal(verifyReadinessReport(clean), true, "the redacted digest is recomputed");
  assert.notEqual(clean.digest, report.digest);
  assert.equal(clean.findings.length, 2);
  assert.equal(clean.findings.some((entry) => entry.scope.page === "/private/secret/"), false);
  assert.equal(badgeSvg(clean).includes("leak-me"), false);
});

test("redaction keeps an already clean report byte-identical", () => {
  const clean = redactReadinessReport(report);
  assert.deepEqual(clean, report);
});

test("redaction is deterministic", () => {
  const dirty = withFindings(
    [finding("structure.sourcemap", { scope: pageScope("/guide/"), message: "path /Users/me/x", evidence: "token=abc" })],
    "https://ci.example/?token=abc",
  );
  const first = redactReadinessReport(dirty);
  const second = redactReadinessReport(dirty);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});
