/**
 * #1364: the context compiler includes the decisions in effect for the pages a task edits, as active rules, and never a
 * superseded one. The rules carry a citation, and a private rationale is replaced with the placeholder.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { compileTaskContext, contextJson } from "../src/context/compile.ts";
import { buildModel } from "../src/model/build.ts";
import { task } from "./context-fixture.ts";

/** A temporary site holding `files`. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "decisions-context-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const ONE = `---
id: ADR-0001
title: In-memory cache
status: superseded
date: 2025-01-10
source: https://example.test/rfcs/1
pages: [guide/caching.md]
validity:
  versions: [v1]
public: true
---

## Decision

Cache every hit in a process-local map.

## Rationale

The working set was small.
`;

const TWO = `---
id: ADR-0002
title: Redis cache
status: accepted
date: 2025-03-02
source: https://example.test/rfcs/2
supersedes: [ADR-0001]
pages: [guide/caching.md]
validity:
  versions: [v2]
public: true
---

## Decision

Cache hits and misses in Redis.

## Rationale

One answer across workers.
`;

const SITE = {
  "mizzen.yml": "title: T\ndecisions:\n  dir: docs/decisions\n",
  "guide/caching.md": "---\ntitle: Caching\n---\n\n# Caching\n\nHits come from memory.\n",
  "docs/decisions/0001.md": ONE,
  "docs/decisions/0002.md": TWO,
};

async function compile() {
  const root = tree(SITE);
  try {
    const { site } = await buildModel(root);
    const context = await compileTaskContext(
      site,
      task({ goal: "Edit the caching guide", scope: { pages: ["/guide/caching/"], blocks: [], collections: [], symbols: [], files: [] } }),
      { maxTokens: 4000 },
    );
    return context;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("#1364 the pack carries the decision in effect as an active rule", async () => {
  const context = await compile();
  const rules = context.decisions?.rules ?? [];
  assert.deepEqual(rules.map((rule) => rule.decision), ["ADR-0002"]);
  assert.match(rules[0]?.rule ?? "", /Redis/);
  assert.equal(rules[0]?.citation, "decision:ADR-0002");
  assert.match(context.markdown, /## Decisions in effect/);
  assert.match(context.markdown, /Cache hits and misses in Redis/);
});

test("#1364 a superseded decision is history, never an active rule", async () => {
  const context = await compile();
  const ruleIds = (context.decisions?.rules ?? []).map((rule) => rule.decision);
  assert.equal(ruleIds.includes("ADR-0001"), false);
  assert.equal((context.decisions?.history ?? []).some((entry) => entry.decision === "ADR-0001"), true);
  assert.doesNotMatch(context.markdown, /Cache every hit in a process-local map/);
});

test("#1364 a page no decision names brings no rule", async () => {
  const root = tree({ ...SITE, "guide/other.md": "---\ntitle: Other\n---\n\n# Other\n" });
  try {
    const { site } = await buildModel(root);
    const context = await compileTaskContext(
      site,
      task({ goal: "Edit another guide", scope: { pages: ["/guide/other/"], blocks: [], collections: [], symbols: [], files: [] } }),
      { maxTokens: 4000 },
    );
    assert.equal(context.decisions, undefined);
    assert.doesNotMatch(context.markdown, /Decisions in effect/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1364 a private rationale reaches the pack as a placeholder", async () => {
  const root = tree({
    ...SITE,
    "docs/decisions/0002.md": TWO.replace("public: true", "public: true").replace("## Rationale\n\nOne answer across workers.", "## Rationale\n\nsecret-reason-77"),
  });
  try {
    const { site } = await buildModel(root);
    // A record marked public publishes its rationale, so mark it private to prove the redaction.
    const privateSite = {
      ...site,
      decisions: (site.decisions ?? []).map((record) => (record.id === "ADR-0002" ? { ...record, public: false } : record)),
    };
    const context = await compileTaskContext(
      privateSite,
      task({ goal: "Edit the caching guide", scope: { pages: ["/guide/caching/"], blocks: [], collections: [], symbols: [], files: [] } }),
      { maxTokens: 4000 },
    );
    const json = contextJson(context);
    assert.doesNotMatch(json, /secret-reason-77/);
    assert.match(json, /\[text withheld\]/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
