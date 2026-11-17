/** `mizzen published-site check`: text and JSON reports, exit codes, the redirect map, and a local HTTP fixture. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { main } from "../src/cli/index.ts";

interface Route {
  readonly status?: number;
  readonly body?: string;
  readonly location?: string;
}

interface Fixture {
  readonly origin: string;
  readonly sitemap: string;
  readonly requests: string[];
  close(): Promise<void>;
}

/** A local HTTP fixture: routes are built once the port is known, so their bodies can carry absolute URLs. */
async function serve(routes: (origin: string) => Record<string, Route>): Promise<Fixture> {
  const requests: string[] = [];
  let table: Record<string, Route> = {};
  const server = createServer((request, response) => {
    const path = request.url ?? "/";
    requests.push(path);
    const route = table[path];
    if (route === undefined) {
      response.statusCode = 404;
      response.end("not found");
      return;
    }
    response.statusCode = route.status ?? 200;
    response.setHeader("content-type", "text/html; charset=utf-8");
    if (route.location !== undefined) response.setHeader("location", route.location);
    response.end(route.body ?? "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the fixture server has no port");
  const origin = `http://127.0.0.1:${address.port}`;
  table = routes(origin);
  return {
    origin,
    sitemap: `${origin}/sitemap.xml`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

/** A sitemap naming `urls` as pages. */
function sitemapOf(urls: readonly string[]): string {
  const entries = urls.map((url) => `<url><loc>${url}</loc></url>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</urlset>`;
}

/** A page naming `canonical` as its own address. */
function pageOf(canonical: string): string {
  return `<!doctype html><html><head><link rel="canonical" href="${canonical}"></head><body>ok</body></html>`;
}

/** Runs the CLI and keeps what it wrote to each stream. */
async function run(args: readonly string[]): Promise<{ code: number; out: string; errors: string[] }> {
  const out: string[] = [];
  const errors: string[] = [];
  const code = await main(args, { log: (message) => out.push(message), error: (message) => errors.push(message) });
  return { code, out: out.join("\n"), errors };
}

test("a clean site exits 0 with one summary line", async () => {
  const fixture = await serve((origin) => ({
    "/sitemap.xml": { body: sitemapOf([`${origin}/a/`, `${origin}/b/`]) },
    "/a/": { body: pageOf(`${origin}/a/`) },
    "/b/": { body: pageOf(`${origin}/b/`) },
  }));
  try {
    const result = await run(["published-site", "check", "--sitemap", fixture.sitemap]);
    assert.equal(result.code, 0, result.errors.join("\n"));
    assert.match(result.out, /URLs checked: 2; errors: 0; warnings: 0\./);
    assert.deepEqual(result.errors, []);
  } finally {
    await fixture.close();
  }
});

test("a broken page and a wrong canonical exit 1, in text and in JSON", async () => {
  const fixture = await serve((origin) => ({
    "/sitemap.xml": { body: sitemapOf([`${origin}/gone/`, `${origin}/wrong/`]) },
    "/gone/": { status: 404, body: "gone" },
    "/wrong/": { body: pageOf(`${origin}/elsewhere/`) },
  }));
  try {
    const text = await run(["published-site", "check", "--sitemap", fixture.sitemap]);
    assert.equal(text.code, 1);
    assert.match(text.out, new RegExp(`error published-site\\.status ${fixture.origin}/gone/: The page returned 404, expected 2xx\\.`));
    assert.match(text.out, /error published-site\.canonical-mismatch /);
    assert.match(text.out, /URLs checked: 2; errors: 2; warnings: 0\./);

    const json = await run(["published-site", "check", "--sitemap", fixture.sitemap, "--format", "json"]);
    assert.equal(json.code, 1);
    const report = JSON.parse(json.out) as {
      version: number;
      sitemap: string;
      domain: string;
      urls: number;
      findings: { id: string; severity: string; expected?: string; actual?: string }[];
    };
    assert.equal(report.version, 1);
    assert.equal(report.sitemap, fixture.sitemap);
    assert.equal(report.domain, "127.0.0.1");
    assert.equal(report.urls, 2);
    assert.deepEqual(report.findings.map((finding) => finding.id), ["published-site.status", "published-site.canonical-mismatch"]);
    assert.equal(report.findings[0]?.expected, "2xx");
    assert.equal(report.findings[0]?.actual, "404");
  } finally {
    await fixture.close();
  }
});

test("the redirect map passes a correct destination and fails a wrong or missing one", async () => {
  const fixture = await serve((origin) => ({
    "/sitemap.xml": { body: sitemapOf([`${origin}/new/`, `${origin}/moved/`]) },
    "/new/": { body: pageOf(`${origin}/new/`) },
    "/fresh/": { body: pageOf(`${origin}/fresh/`) },
    "/old/": { status: 301, location: "/new/" },
    "/moved/": { status: 302, location: "/fresh/" },
  }));
  const root = mkdtempSync(join(tmpdir(), "mizzen-published-site-"));
  try {
    const map = join(root, "redirects.json");
    writeFileSync(map, JSON.stringify({ "/old/": "/new/" }));
    const correct = await run(["published-site", "check", "--sitemap", fixture.sitemap, "--redirects", map]);
    assert.equal(correct.code, 1, "the unmapped /moved/ redirect is still a finding");
    assert.match(correct.out, /published-site\.redirect-unexpected/);

    writeFileSync(map, JSON.stringify({ "/old/": "/elsewhere/" }));
    const wrong = await run(["published-site", "check", "--sitemap", fixture.sitemap, "--redirects", map]);
    assert.equal(wrong.code, 1);
    assert.match(wrong.out, /published-site\.redirect-mismatch /);
  } finally {
    rmSync(root, { recursive: true, force: true });
    await fixture.close();
  }
});

test("an unusable input exits 2 before the first request", async () => {
  const fixture = await serve((origin) => ({
    "/sitemap.xml": { body: sitemapOf([`${origin}/a/`]) },
    "/a/": { body: pageOf(`${origin}/a/`) },
  }));
  const root = mkdtempSync(join(tmpdir(), "mizzen-published-site-"));
  try {
    const cases: readonly [string[], RegExp][] = [
      [["published-site", "check"], /needs --sitemap/],
      [["published-site", "check", "--sitemap", "example.org/sitemap.xml"], /absolute http or https URL/],
      [["published-site", "check", "--sitemap", fixture.sitemap, "--domain", "https://example.org"], /--domain must be one hostname/],
      [["published-site", "check", "--sitemap", fixture.sitemap, "--format", "sarif"], /--format must be text or json/],
    ];
    for (const [args, message] of cases) {
      const result = await run(args);
      assert.equal(result.code, 2, args.join(" "));
      assert.match(result.errors.join("\n"), message);
    }

    const map = join(root, "redirects.json");
    writeFileSync(map, JSON.stringify({ "/old/": "https://elsewhere.test/new/" }));
    const offDomain = await run(["published-site", "check", "--sitemap", fixture.sitemap, "--redirects", map]);
    assert.equal(offDomain.code, 2);
    assert.match(offDomain.errors.join("\n"), /not on the allowed domain/);
    assert.deepEqual(fixture.requests, [], "no request starts before every input is valid");
  } finally {
    rmSync(root, { recursive: true, force: true });
    await fixture.close();
  }
});

test("the recipe parses, is scheduled, and takes its sitemap from a repository variable", () => {
  const recipe = parse(readFileSync(new URL("../recipes/published-site-check.yml", import.meta.url), "utf8")) as {
    on: Record<string, unknown>;
    env: Record<string, string>;
    jobs: Record<string, { steps: { run?: string }[] }>;
  };
  assert.ok("schedule" in recipe.on);
  assert.match(recipe.env.SITEMAP_URL ?? "", /vars\.SITEMAP_URL/);
  const runs = Object.values(recipe.jobs).flatMap((job) => job.steps.map((step) => step.run ?? ""));
  assert.ok(runs.some((run) => run.includes("mizzen published-site check")));
});
