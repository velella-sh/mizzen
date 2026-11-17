/** The network-discovery recipe builds the root site, writes the index over its output, and the index reaches every sitemap. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { runNetwork } from "../../src/cli/network.ts";
import { writeNetworkLock } from "../../src/network/lock.ts";
import { build } from "../../src/pipeline/build.ts";
import { lockOf } from "../helpers-network.ts";

const THEME = fileURLToPath(new URL("../../../lateen", import.meta.url));
const RECIPE = readFileSync(new URL("../../recipes/network-discovery.yml", import.meta.url), "utf8");

interface Step { readonly run?: string }
interface Workflow { readonly env: Record<string, string>; readonly jobs: Record<string, { readonly steps: readonly Step[] }> }

test("the recipe builds, takes the domain from a repository variable, and writes the index over the output", () => {
  const workflow = parse(RECIPE) as Workflow;
  const runs = Object.values(workflow.jobs).flatMap((job) => job.steps.map((step) => step.run ?? ""));
  assert.ok(runs.some((run) => run.includes("mizzen build") && run.includes("--out dist")));
  assert.ok(runs.some((run) => run.includes('mizzen network sitemap "$SITE"') && run.includes('--url "$SITE_URL"') && run.includes("--out dist")));
  assert.match(workflow.env.SITE_URL!, /vars\.SITE_URL/);
});

test("the built fixture's index lists the root pages and every public project, and each reference resolves", async () => {
  const origin = "https://example.org";
  const root = mkdtempSync(join(tmpdir(), "mizzen-discovery-"));
  writeFileSync(join(root, "mizzen.yml"), [
    "title: Velella",
    `url: ${origin}`,
    "defaults:",
    '  - path: ""',
    "    values:",
    "      layout: doc",
    "",
  ].join("\n"));
  writeFileSync(join(root, "index.md"), "---\ntitle: Home\n---\n# Home\n\nHello.\n");
  await writeNetworkLock(root, lockOf());

  const out = mkdtempSync(join(tmpdir(), "mizzen-discovery-out-"));
  const built = await build({ root, out, themeRoot: THEME });
  assert.deepEqual(built.diagnostics.filter((diagnostic) => diagnostic.severity === "error"), []);
  // The independent projects deploy their own sitemaps below their paths.
  for (const project of ["docs", "blog"]) {
    mkdirSync(join(out, project), { recursive: true });
    writeFileSync(join(out, project, "sitemap.xml"), '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" />\n');
  }

  const errors: string[] = [];
  const code = await runNetwork(["sitemap", root, "--url", origin, "--out", out], { log: () => {}, error: (line) => errors.push(line) });
  assert.equal(code, 0, errors.join("\n"));

  const index = readFileSync(join(out, "sitemap.xml"), "utf8");
  const listed = [...index.matchAll(/<loc>([^<]*)<\/loc>/g)].map((match) => match[1]!);
  assert.deepEqual(listed, [`${origin}/blog/sitemap.xml`, `${origin}/docs/sitemap.xml`, `${origin}/sitemap-pages.xml`]);
  for (const loc of listed) assert.ok(existsSync(join(out, new URL(loc).pathname)), loc);
  assert.match(readFileSync(join(out, "sitemap-pages.xml"), "utf8"), new RegExp(`<loc>${origin}/</loc>`));
  assert.match(readFileSync(join(out, "robots.txt"), "utf8"), new RegExp(`^Sitemap: ${origin}/sitemap.xml$`, "m"));
  assert.ok(!index.includes("/internal/"));
});
