/** Redirects in a published-site check: a correct landing, a wrong destination, a loop, an overlong chain, and the stops. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkRedirects,
  REDIRECT_HOP_LIMIT,
  type PublishedSiteFetchLike,
} from "../../src/published-site/redirects.ts";

const ORIGIN = "https://example.test";
const DOMAIN = "example.test";

interface Route {
  readonly status?: number;
  readonly location?: string;
}

/** A fetcher that answers the given routes and records every requested URL. */
function fakeFetch(routes: Readonly<Record<string, Route>>): { fetcher: PublishedSiteFetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetcher: PublishedSiteFetchLike = async (url, init) => {
    calls.push(url);
    assert.equal(init?.redirect, "manual");
    const route = routes[url] ?? { status: 404 };
    return new Response(null, {
      status: route.status ?? 200,
      headers: route.location === undefined ? {} : { location: route.location },
    });
  };
  return { fetcher, calls };
}

test("a redirect that lands on the expected address reports nothing", async () => {
  const { fetcher, calls } = fakeFetch({
    "https://example.test/old/": { status: 301, location: "/new/" },
    "https://example.test/new/": {},
  });
  const findings = await checkRedirects({ origin: ORIGIN, domain: DOMAIN, redirects: { "/old/": "/new/" }, fetch: fetcher });
  assert.deepEqual(findings, []);
  assert.deepEqual(calls, ["https://example.test/old/", "https://example.test/new/"]);
});

test("a map path resolves against the origin and compares after URL normalization", async () => {
  const { fetcher } = fakeFetch({
    "https://example.test/old": { status: 302, location: "https://EXAMPLE.test:443/new/#section" },
    "https://example.test/new/": {},
  });
  const findings = await checkRedirects({
    origin: ORIGIN,
    domain: DOMAIN,
    redirects: { "/old": "https://example.test/new/" },
    fetch: fetcher,
  });
  assert.deepEqual(findings, []);
});

test("a redirect to a different destination is a mismatch with both addresses", async () => {
  const { fetcher } = fakeFetch({
    "https://example.test/old/": { status: 302, location: "/other/" },
    "https://example.test/other/": {},
  });
  const findings = await checkRedirects({ origin: ORIGIN, domain: DOMAIN, redirects: { "/old/": "/new/" }, fetch: fetcher });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.id, "published-site.redirect-mismatch");
  assert.equal(findings[0]?.url, "https://example.test/old/");
  assert.equal(findings[0]?.expected, "https://example.test/new/");
  assert.equal(findings[0]?.actual, "https://example.test/other/");
  assert.match(findings[0]?.message ?? "", /ended at https:\/\/example\.test\/other\//);
});

test("a redirect back to an address already visited is a loop", async () => {
  const { fetcher, calls } = fakeFetch({
    "https://example.test/a/": { status: 301, location: "/b/" },
    "https://example.test/b/": { status: 301, location: "/a/" },
  });
  const findings = await checkRedirects({ origin: ORIGIN, domain: DOMAIN, redirects: { "/a/": "/b/" }, fetch: fetcher });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.id, "published-site.redirect-loop");
  assert.equal(findings[0]?.url, "https://example.test/a/");
  assert.equal(findings[0]?.actual, "https://example.test/a/");
  assert.deepEqual(calls, ["https://example.test/a/", "https://example.test/b/"]);
});

test("a chain beyond the hop limit is reported without requesting the next hop", async () => {
  const routes: Record<string, Route> = {};
  for (let hop = 0; hop < REDIRECT_HOP_LIMIT + 1; hop++) {
    routes[`${ORIGIN}/step-${hop}/`] = { status: 302, location: `/step-${hop + 1}/` };
  }
  routes[`${ORIGIN}/step-${REDIRECT_HOP_LIMIT + 1}/`] = {};
  const { fetcher, calls } = fakeFetch(routes);
  const findings = await checkRedirects({ origin: ORIGIN, domain: DOMAIN, redirects: { "/step-0/": "/step-6/" }, fetch: fetcher });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.id, "published-site.redirect-chain");
  assert.equal(findings[0]?.url, "https://example.test/step-0/");
  assert.equal(calls.length, REDIRECT_HOP_LIMIT + 1);
  assert.ok(!calls.includes("https://example.test/step-6/"));
  assert.match(findings[0]?.message ?? "", new RegExp(`longer than ${REDIRECT_HOP_LIMIT} hops`));
});

test("a redirect off the allowed domain is reported and not requested", async () => {
  const { fetcher, calls } = fakeFetch({
    "https://example.test/old/": { status: 301, location: "https://other.test/new/" },
    "https://other.test/new/": {},
  });
  const findings = await checkRedirects({ origin: ORIGIN, domain: DOMAIN, redirects: { "/old/": "/new/" }, fetch: fetcher });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.id, "published-site.domain");
  assert.equal(findings[0]?.url, "https://other.test/new/");
  assert.equal(findings[0]?.expected, DOMAIN);
  assert.equal(findings[0]?.actual, "other.test");
  assert.deepEqual(calls, ["https://example.test/old/"]);
});

test("a request that fails before a response is unreachable", async () => {
  const fetcher: PublishedSiteFetchLike = async () => {
    throw new Error("connection refused");
  };
  const findings = await checkRedirects({ origin: ORIGIN, domain: DOMAIN, redirects: { "/old/": "/new/" }, fetch: fetcher });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.id, "published-site.unreachable");
  assert.equal(findings[0]?.url, "https://example.test/old/");
  assert.match(findings[0]?.message ?? "", /connection refused/);
});

test("findings are sorted by address, then id", async () => {
  const { fetcher } = fakeFetch({
    "https://example.test/z/": { status: 302, location: "/z-final/" },
    "https://example.test/z-final/": {},
    "https://example.test/a/": { status: 302, location: "/a-final/" },
    "https://example.test/a-final/": {},
  });
  const findings = await checkRedirects({
    origin: ORIGIN,
    domain: DOMAIN,
    redirects: { "/z/": "/target/", "/a/": "/target/" },
    fetch: fetcher,
  });
  assert.deepEqual(findings.map((entry) => entry.url), ["https://example.test/a/", "https://example.test/z/"]);
});
