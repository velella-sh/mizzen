/** The page check: one correct page, then an HTTP error, a missing canonical, an inconsistent canonical, and a timeout. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkPage, type PageFetch } from "../../src/published-site/pages.ts";

const ORIGIN = "https://example.test";

interface Reply {
  readonly status?: number;
  readonly html?: string;
}

type Fixture = Readonly<Record<string, Reply | Error>>;

/** Answers each fixture address, and fails loudly on an address the fixture does not hold. */
function serving(pages: Fixture): PageFetch {
  return async (url) => {
    const reply = pages[url] ?? new Error(`the fixture has no page at ${url}`);
    if (reply instanceof Error) throw reply;
    return new Response(reply.html ?? "", { status: reply.status ?? 200, headers: { "content-type": "text/html" } });
  };
}

/** A small HTML page with the given head, enough for the canonical scan. */
function page(head: string): string {
  return `<!doctype html><html><head>${head}</head><body><p>ok</p></body></html>`;
}

const PAGES: Fixture = {
  [`${ORIGIN}/`]: { html: page(`<link rel="canonical" href="${ORIGIN}/">`) },
  [`${ORIGIN}/guide/`]: { html: page(`<link rel="canonical" href="./">`) },
  [`${ORIGIN}/gone/`]: { status: 404, html: page("") },
  [`${ORIGIN}/uncanonical/`]: { html: page("") },
  [`${ORIGIN}/elsewhere/`]: { html: page(`<link href="${ORIGIN}/somewhere-else/" rel="canonical">`) },
  [`${ORIGIN}/twice/`]: { html: page(`<link rel="canonical" href="${ORIGIN}/"><link rel="Canonical" href="${ORIGIN}/">`) },
  [`${ORIGIN}/slow/`]: new DOMException("The operation timed out.", "TimeoutError"),
};

test("a correct page produces no finding", async () => {
  assert.deepEqual(await checkPage(`${ORIGIN}/`, serving(PAGES)), []);
});

test("a relative canonical is resolved against the page URL", async () => {
  assert.deepEqual(await checkPage(`${ORIGIN}/guide/`, serving(PAGES)), []);
});

test("an HTTP error names the page, the status, and the expected value", async () => {
  const [finding] = await checkPage(`${ORIGIN}/gone/`, serving(PAGES));
  assert.equal(finding?.id, "published-site.status");
  assert.equal(finding?.severity, "error");
  assert.equal(finding?.url, `${ORIGIN}/gone/`);
  assert.equal(finding?.expected, "2xx");
  assert.equal(finding?.actual, "404");
  assert.equal(finding?.message, "The page returned 404, expected 2xx.");
});

test("a missing canonical names the page and the expected URL", async () => {
  const [finding] = await checkPage(`${ORIGIN}/uncanonical/`, serving(PAGES));
  assert.equal(finding?.id, "published-site.canonical-missing");
  assert.equal(finding?.url, `${ORIGIN}/uncanonical/`);
  assert.equal(finding?.expected, `${ORIGIN}/uncanonical/`);
  assert.match(finding?.message ?? "", /expected https:\/\/example\.test\/uncanonical\//);
});

test("a different canonical names both URLs", async () => {
  const [finding] = await checkPage(`${ORIGIN}/elsewhere/`, serving(PAGES));
  assert.equal(finding?.id, "published-site.canonical-mismatch");
  assert.equal(finding?.url, `${ORIGIN}/elsewhere/`);
  assert.equal(finding?.expected, `${ORIGIN}/elsewhere/`);
  assert.equal(finding?.actual, `${ORIGIN}/somewhere-else/`);
  assert.match(finding?.message ?? "", /expected https:\/\/example\.test\/elsewhere\//);
});

test("two canonicals are one mismatch, even when both are correct", async () => {
  const [finding] = await checkPage(`${ORIGIN}/twice/`, serving(PAGES));
  assert.equal(finding?.id, "published-site.canonical-mismatch");
  assert.equal(finding?.expected, `${ORIGIN}/twice/`);
  assert.equal(finding?.actual, `${ORIGIN}/, ${ORIGIN}/`);
});

test("a timeout names the page without waiting", async () => {
  const [finding] = await checkPage(`${ORIGIN}/slow/`, serving(PAGES));
  assert.equal(finding?.id, "published-site.unreachable");
  assert.equal(finding?.url, `${ORIGIN}/slow/`);
  assert.equal(finding?.message, `The request to ${ORIGIN}/slow/ timed out.`);
});
