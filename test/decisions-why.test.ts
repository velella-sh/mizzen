/**
 * #1363 and #1366: the "why" query, and the two-successive-decisions fixture.
 *
 * From a behavior or a page, the answer names the decision in effect, its rationale, the rejected alternatives, and the
 * decisions it superseded, each with a citation. The fixture has two successive decisions: the answer before
 * supersession names the first, and after it names the second with the first as history, so an agent can trace the new
 * behavior to its actual rationale.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadDecisions } from "../src/decisions/load.ts";
import { why } from "../src/decisions/why.ts";
import { buildModel } from "../src/model/build.ts";

const FIXTURE = fileURLToPath(new URL("../fixtures/decisions", import.meta.url));

async function load() {
  const { site, diagnostics } = await buildModel(FIXTURE);
  assert.deepEqual(diagnostics.filter((diagnostic) => diagnostic.severity === "error"), []);
  const loaded = await loadDecisions({
    root: FIXTURE,
    site,
    dir: "docs/decisions",
  });
  return { site, loaded };
}

test("#1366 before supersession, the answer is the first decision", async () => {
  const { loaded } = await load();
  const answer = why("behavior:cache-hit", loaded.records, { lifecycle: loaded.lifecycle, query: { version: "v1" } });
  assert.equal(answer.answerable, true);
  assert.equal(answer.current?.id, "ADR-0001");
  assert.match(answer.current?.rationale ?? "", /simple and fast/);
  assert.equal(answer.history.length, 0);
});

test("#1366 after supersession, the answer is the second decision with the first as history", async () => {
  const { loaded } = await load();
  const answer = why("behavior:cache-hit", loaded.records, { lifecycle: loaded.lifecycle, query: { version: "v2" } });
  assert.equal(answer.current?.id, "ADR-0002");
  assert.match(answer.current?.rationale ?? "", /one answer across workers/);
  assert.deepEqual(answer.history.map((entry) => entry.id), ["ADR-0001"]);
  // The current answer carries the rejected alternatives, so an agent sees why the map was not kept.
  const rejected = answer.current?.alternatives.map((alternative) => alternative.name);
  assert.deepEqual(rejected, ["Keep the map", "Sticky sessions"]);
  assert.match(answer.current?.alternatives[0]?.rejectedBecause ?? "", /each worker would answer differently/);
});

test("#1363 a page URL answers the same question as a behavior", async () => {
  const { loaded } = await load();
  const byPage = why("/guide/caching/", loaded.records, { lifecycle: loaded.lifecycle, query: { version: "v2" } });
  assert.equal(byPage.current?.id, "ADR-0002");
  const bySource = why("guide/caching.md", loaded.records, { lifecycle: loaded.lifecycle, query: { version: "v2" } });
  assert.equal(bySource.current?.id, "ADR-0002");
});

test("#1363 every answer carries a citation to the original text", async () => {
  const { loaded } = await load();
  const answer = why("behavior:cache-hit", loaded.records, { lifecycle: loaded.lifecycle, query: { version: "v2" } });
  assert.match(answer.current?.span ?? "", /docs\/decisions\/0002-redis-cache\.md:\d+:\d+-\d+:\d+/);
  assert.equal(answer.current?.source, "https://example.test/rfcs/2");
});

test("#1363 a subject no decision names is not answerable", async () => {
  const { loaded } = await load();
  const answer = why("behavior:not-a-thing", loaded.records, { lifecycle: loaded.lifecycle });
  assert.equal(answer.answerable, false);
  assert.equal(answer.current, undefined);
});
