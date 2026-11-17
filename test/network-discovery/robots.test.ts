/** `mizzen network sitemap` keeps the root site's robots rules, points one Sitemap line at the index, and the index reaches every file. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runNetwork } from "../../src/cli/network.ts";
import { networkSite } from "../helpers-network.ts";

const ORIGIN = "https://example.org";
const ROOT_MAP = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url>\n    <loc>https://example.org/</loc>\n  </url>\n</urlset>\n';

/** Writes the independent projects' own sitemaps under `out`, as their deploys would. */
function projectSitemaps(out: string): void {
  for (const project of ["docs", "blog"]) {
    mkdirSync(join(out, project), { recursive: true });
    writeFileSync(join(out, project, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" />\n`);
  }
}

test("the build's robots rules stay, and one Sitemap line points at the index", async () => {
  const root = await networkSite();
  const out = mkdtempSync(join(tmpdir(), "mizzen-netmap-"));
  writeFileSync(join(out, "sitemap.xml"), ROOT_MAP);
  projectSitemaps(out);
  writeFileSync(join(out, "robots.txt"), `User-agent: *\nDisallow: /private/\n\nSitemap: ${ORIGIN}/sitemap.xml\n`);

  const errors: string[] = [];
  const code = await runNetwork(["sitemap", root, "--url", ORIGIN, "--out", out], { log: () => {}, error: (line) => errors.push(line) });
  assert.equal(code, 0, errors.join("\n"));

  const text = readFileSync(join(out, "robots.txt"), "utf8");
  assert.equal(text, `User-agent: *\nDisallow: /private/\n\nSitemap: ${ORIGIN}/sitemap.xml\n`);
  assert.equal(text.match(/^Sitemap:/gm)?.length, 1);
});

test("following the robots reference reaches the index and every sitemap it lists", async () => {
  const root = await networkSite();
  const out = mkdtempSync(join(tmpdir(), "mizzen-netmap-"));
  writeFileSync(join(out, "sitemap.xml"), ROOT_MAP);
  projectSitemaps(out);
  await runNetwork(["sitemap", root, "--url", ORIGIN, "--out", out], { log: () => {}, error: () => {} });

  const reference = readFileSync(join(out, "robots.txt"), "utf8").match(/^Sitemap: (\S+)$/m)?.[1];
  assert.equal(reference, `${ORIGIN}/sitemap.xml`);
  const index = readFileSync(join(out, new URL(reference).pathname), "utf8");
  const listed = [...index.matchAll(/<loc>([^<]*)<\/loc>/g)].map((match) => match[1]!);
  assert.deepEqual(listed, [
    "https://example.org/blog/sitemap.xml",
    "https://example.org/docs/sitemap.xml",
    "https://example.org/sitemap-pages.xml",
  ]);
  for (const loc of listed) assert.ok(existsSync(join(out, new URL(loc).pathname)), loc);
});
