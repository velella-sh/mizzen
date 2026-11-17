import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fetchFollowingRedirects,
  REDIRECT_HOP_LIMIT,
  type FetchLike,
} from "../../src/published-site/fetch.ts";

const ORIGIN = "https://example.test";
const DOMAIN = "example.test";

interface Route {
  readonly status?: number;
  readonly location?: string;
}

function serving(routes: Readonly<Record<string, Route>>): { fetcher: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetcher: FetchLike = async (url, init) => {
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

test("a same-domain redirect returns the final response and address", async () => {
  const { fetcher, calls } = serving({
    [`${ORIGIN}/old/`]: { status: 301, location: "/new/" },
    [`${ORIGIN}/new/`]: {},
  });
  const result = await fetchFollowingRedirects(`${ORIGIN}/old/`, DOMAIN, {}, fetcher);
  assert.equal(result.final, `${ORIGIN}/new/`);
  assert.equal(result.response.status, 200);
  assert.equal(result.finding, undefined);
  assert.deepEqual(calls, [`${ORIGIN}/old/`, `${ORIGIN}/new/`]);
});

test("a malformed location is a finding, not an exception", async () => {
  const { fetcher, calls } = serving({
    [`${ORIGIN}/old/`]: { status: 302, location: "http://[::1" },
  });
  const result = await fetchFollowingRedirects(`${ORIGIN}/old/`, DOMAIN, {}, fetcher);
  assert.equal(result.finding?.id, "published-site.redirect-mismatch");
  assert.equal(result.finding?.actual, "http://[::1");
  assert.deepEqual(calls, [`${ORIGIN}/old/`]);
});

test("a redirect loop stops before requesting an address twice", async () => {
  const { fetcher, calls } = serving({
    [`${ORIGIN}/a/`]: { status: 301, location: "/b/" },
    [`${ORIGIN}/b/`]: { status: 302, location: "/a/" },
  });
  const result = await fetchFollowingRedirects(`${ORIGIN}/a/`, DOMAIN, {}, fetcher);
  assert.equal(result.finding?.id, "published-site.redirect-loop");
  assert.equal(result.finding?.actual, `${ORIGIN}/a/`);
  assert.deepEqual(calls, [`${ORIGIN}/a/`, `${ORIGIN}/b/`]);
});

test("a chain beyond the hop limit stops before the next request", async () => {
  const routes: Record<string, Route> = {};
  for (let hop = 0; hop <= REDIRECT_HOP_LIMIT + 1; hop++) {
    routes[`${ORIGIN}/step-${hop}/`] = { status: 302, location: `/step-${hop + 1}/` };
  }
  const { fetcher, calls } = serving(routes);
  const result = await fetchFollowingRedirects(`${ORIGIN}/step-0/`, DOMAIN, {}, fetcher);
  assert.equal(result.finding?.id, "published-site.redirect-chain");
  assert.equal(calls.length, REDIRECT_HOP_LIMIT + 1);
  assert.ok(!calls.includes(`${ORIGIN}/step-${REDIRECT_HOP_LIMIT + 1}/`));
});
