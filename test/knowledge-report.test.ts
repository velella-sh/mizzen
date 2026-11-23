/**
 * #1369 and #1372: scope an unknown and flag it for review against a fixed reference time, and report the gaps with
 * counts and locations that keep explicit unknowns, documentation gaps, and unsupported cases apart.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { main } from "../src/cli/index.ts";
import { compareKnowledgeReports, knowledgeReportOf } from "../src/knowledge/report.ts";
import { buildModel } from "../src/model/build.ts";

/** A temporary site holding `files`. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "knowledge-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** Captures what a command printed. */
function capture() {
  const logs: string[] = [];
  const errors: string[] = [];
  return { logs, errors, io: { log: (m: string) => logs.push(m), error: (m: string) => errors.push(m) } };
}

test("#1369 an expired declaration requires review against a fixed as-of date", async () => {
  const root = tree({
    "mizzen.yml": "title: T\n",
    "a.md": "---\ntitle: A\nknowledge:\n  status: unknown\n  expires: 2024-01-01\n---\n\n# A\n",
  });
  try {
    const { site } = await buildModel(root);
    const before = knowledgeReportOf(site, { asOf: "2023-12-31" });
    assert.equal(before.entries[0]?.declaration?.review.required, false);

    const after = knowledgeReportOf(site, { asOf: "2024-01-02" });
    assert.equal(after.entries[0]?.declaration?.review.required, true);
    assert.deepEqual(after.entries[0]?.declaration?.review.reasons, ["expired"]);
    assert.equal(after.gaps.find((gap) => gap.subject.id === "a.md")?.review, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1369 changed evidence, not the clock, flags a declaration for review", async () => {
  const root = tree({
    "mizzen.yml": "title: T\n",
    "a.md": "---\ntitle: A\nknowledge:\n  status: unverified\n  evidence: recorded-against-old\n---\n\n# A\n",
  });
  try {
    const { site } = await buildModel(root);
    // The declaration recorded its evidence as `recorded-against-old`; the current page hash differs, so review is
    // required. Two runs on the same input give the same answer because no clock is read.
    const first = knowledgeReportOf(site);
    const second = knowledgeReportOf(site);
    assert.deepEqual(first, second);
    assert.deepEqual(first.entries[0]?.declaration?.review.reasons, ["evidence-changed"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1372 the CLI prints counts and locations, keeping unknowns, gaps, and unsupported apart", async () => {
  const root = tree({
    "mizzen.yml": "title: T\n",
    "known-as-unknown.md": "---\ntitle: A\nknowledge:\n  status: unknown\n---\n\n# A\n",
    "unsupported.md": "---\ntitle: B\nknowledge:\n  status: unsupported\n---\n\n# B\n",
    "undocumented.md": "---\ntitle: C\n---\n\n# C\n",
  });
  try {
    const { logs, io } = capture();
    assert.equal(await main(["knowledge", root, "--json"], io), 0);
    const report = JSON.parse(logs.join("\n")) as {
      counts: Record<string, number>;
      gaps: { subject: { id: string }; kind: string }[];
    };
    assert.equal(report.counts.unknown, 1);
    assert.equal(report.counts.unsupported, 1);
    assert.equal(report.counts.missing, 1);
    const kinds = report.gaps.map((gap) => `${gap.subject.id}:${gap.kind}`).sort();
    assert.deepEqual(kinds, [
      "known-as-unknown.md:unknown",
      "undocumented.md:documentation-gap",
      "unsupported.md:unsupported",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1372 a snapshot comparison reports each added, removed, and changed subject", async () => {
  const root = tree({
    "mizzen.yml": "title: T\n",
    "a.md": "---\ntitle: A\nknowledge:\n  status: unknown\n---\n\n# A\n",
    "b.md": "---\ntitle: B\n---\n\n# B\n",
  });
  try {
    const { site } = await buildModel(root);
    const baseline = knowledgeReportOf(site);

    // A second site: `a` becomes unsupported, `b` is removed, and `c` is added.
    const next = tree({
      "mizzen.yml": "title: T\n",
      "a.md": "---\ntitle: A\nknowledge:\n  status: unsupported\n---\n\n# A\n",
      "c.md": "---\ntitle: C\nknowledge:\n  status: unknown\n---\n\n# C\n",
    });
    try {
      const current = knowledgeReportOf((await buildModel(next)).site);
      const comparison = compareKnowledgeReports(baseline, current);
      const changes = comparison.changes.map((change) => `${change.subject.id}:${change.change}`);
      assert.deepEqual(changes, ["a.md:changed", "b.md:removed", "c.md:added"]);
      assert.equal(comparison.delta.unknown, 0);
      assert.equal(comparison.delta.unsupported, 1);
      assert.equal(comparison.delta.missing, -1);
    } finally {
      rmSync(next, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1372 --fail-on gates on a gap kind without confusing it with a declared status", async () => {
  const root = tree({
    "mizzen.yml": "title: T\n",
    "a.md": "---\ntitle: A\nknowledge:\n  status: unknown\n---\n\n# A\n",
  });
  try {
    const gated = capture();
    assert.equal(await main(["knowledge", root, "--fail-on", "unknown"], gated.io), 1);
    assert.match(gated.errors.join("\n"), /knowledge gaps: 1 unknown/);

    const gapOnly = capture();
    assert.equal(await main(["knowledge", root, "--fail-on", "missing"], gapOnly.io), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
