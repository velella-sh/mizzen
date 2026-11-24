/**
 * #1365: access controls for decision memory, applied to the records and to their citations.
 *
 * A record with an audience is left out unless the caller may read it. The read policy's page allowlist covers the page
 * a record lives on, and the same policy covers the citation the record carries, so a visible record cannot become a
 * way to read a page the policy refuses. A private rationale, source, or alternative is replaced with a placeholder.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import type { AccessPolicy } from "../src/contracts/index.ts";
import { citationReadable, decisionReadable, publishedCitation } from "../src/decisions/access.ts";
import { loadDecisions } from "../src/decisions/load.ts";
import { decisionReportOf } from "../src/decisions/report.ts";
import { why } from "../src/decisions/why.ts";
import { buildModel } from "../src/model/build.ts";
import { defaultAccessPolicy } from "../src/permissions/policy.ts";

const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;
const reportSchema = JSON.parse(
  readFileSync(new URL("../schema/decision-report.schema.json", import.meta.url), "utf8"),
) as object;

/** A temporary site holding `files`. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "decisions-access-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const STAFF_RECORD = `---
id: ADR-9
title: Rotate the signing key
status: accepted
date: 2025-04-01
source:
  value: https://example.test/private/rfc
  public: true
audience: [staff]
behaviors: [rotate-key]
public: true
---

## Decision

Rotate the key every ninety days.

## Rationale

A leaked key is contained by rotation.
`;

const PUBLIC_RECORD = `---
id: ADR-10
title: Publish the changelog
status: accepted
date: 2025-04-02
source: https://example.test/rfcs/10
behaviors: [changelog]
---

## Decision

Publish the changelog weekly.

## Rationale

private-reason-77
`;

test("#1365 a record with an audience is left out unless the caller may read it", async () => {
  const root = tree({
    "mizzen.yml": "title: T\ndecisions:\n  dir: docs/decisions\n",
    "index.md": "# Home\n",
    "docs/decisions/0009.md": STAFF_RECORD,
    "docs/decisions/0010.md": PUBLIC_RECORD,
  });
  try {
    const { site } = await buildModel(root);
    const loaded = await loadDecisions({ root, site, dir: "docs/decisions" });

    const anonymous = decisionReportOf(loaded.records);
    assert.equal(anonymous.entries.some((entry) => entry.id === "ADR-9"), false, "a staff record is not public");

    const staff = decisionReportOf(loaded.records, { allow: ["staff"] });
    assert.equal(staff.entries.some((entry) => entry.id === "ADR-9"), true);

    // The why answer applies the same audience rule: an anonymous caller cannot trace a staff decision.
    const hidden = why("behavior:rotate-key", loaded.records, { lifecycle: loaded.lifecycle });
    assert.equal(hidden.current, undefined);
    const visible = why("behavior:rotate-key", loaded.records, { lifecycle: loaded.lifecycle, allow: ["staff"] });
    assert.equal(visible.current?.id, "ADR-9");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1365 a private rationale and source are replaced, never quoted", async () => {
  const root = tree({
    "mizzen.yml": "title: T\ndecisions:\n  dir: docs/decisions\n",
    "index.md": "# Home\n",
    "docs/decisions/0010.md": PUBLIC_RECORD,
  });
  try {
    const { site } = await buildModel(root);
    const loaded = await loadDecisions({ root, site, dir: "docs/decisions" });
    const report = decisionReportOf(loaded.records);
    const entry = report.entries.find((candidate) => candidate.id === "ADR-10")!;
    assert.equal(entry.redacted, true);
    assert.equal(entry.source, "[source withheld]");
    assert.equal(entry.rationale, "[text withheld]");
    assert.doesNotMatch(JSON.stringify(report), /private-reason-77|example\.test\/rfcs\/10/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1365 the same read policy covers the citation a record carries", async () => {
  const root = tree({
    "mizzen.yml": "title: T\ndecisions:\n  dir: docs/decisions\n",
    "index.md": "# Home\n",
    "docs/decisions/0010.md": PUBLIC_RECORD,
  });
  try {
    const { site } = await buildModel(root);
    const loaded = await loadDecisions({ root, site, dir: "docs/decisions" });
    const record = loaded.records[0]!;

    const permissive = defaultAccessPolicy();
    assert.equal(citationReadable(record, permissive), true);

    // A policy that narrows pages to the guide refuses the cited page, so the citation is withheld.
    const narrowed: AccessPolicy = { ...permissive, read: { ...permissive.read, pages: ["/guide/"] } };
    assert.equal(citationReadable(record, narrowed), false);
    assert.equal(publishedCitation(record, narrowed, true), "[source withheld]");
    assert.equal(decisionReadable(record, undefined, narrowed), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the report conforms to its schema and never leaks a private value", async () => {
  const root = tree({
    "mizzen.yml": "title: T\ndecisions:\n  dir: docs/decisions\n",
    "index.md": "# Home\n",
    "docs/decisions/0009.md": STAFF_RECORD,
    "docs/decisions/0010.md": PUBLIC_RECORD,
  });
  try {
    const { site } = await buildModel(root);
    const loaded = await loadDecisions({ root, site, dir: "docs/decisions" });
    const report = decisionReportOf(loaded.records, { allow: ["staff"], problems: loaded.problems });
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(reportSchema);
    assert.equal(validate(report), true, JSON.stringify(validate.errors));
    assert.doesNotMatch(JSON.stringify(report), /private-reason-77/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
