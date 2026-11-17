import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Diagnostic } from "../../src/contracts/index.ts";
import { convertComponents } from "../../src/import/docusaurus/components.ts";
import { convertCustomComponents } from "../../src/import/docusaurus/diagnostics.ts";
import { build } from "../../src/pipeline/build.ts";
import { formatText } from "../../src/pipeline/diagnostics.ts";

const FIXTURE = "fixtures/import-docusaurus/docs/configure-a-token.mdx";
const SOURCE = readFileSync(new URL(`../../${FIXTURE}`, import.meta.url), "utf8");
const THEME = fileURLToPath(new URL("../../../lateen", import.meta.url));

/**
 * The fixture after an import. Custom components go first: the diagnostics pass needs the `@theme/` imports to tell
 * Docusaurus's own components from a site's, and the component pass removes those imports.
 */
const converted = (() => {
  const { markdown, diagnostics } = convertCustomComponents(SOURCE, FIXTURE);
  return { markdown: convertComponents(markdown), diagnostics };
})();

/** Writes the converted page beside its link target in a real site, builds it, and returns the page and findings. */
async function buildPage(): Promise<{ html: string; diagnostics: readonly Diagnostic[] }> {
  const root = mkdtempSync(join(tmpdir(), "import-docusaurus-"));
  const out = mkdtempSync(join(tmpdir(), "import-docusaurus-out-"));
  try {
    mkdirSync(join(root, "guide"), { recursive: true });
    writeFileSync(join(root, "guide/configure-a-token.md"), converted.markdown);
    writeFileSync(join(root, "guide/configuration.md"), "---\ntitle: Configuration\n---\n# Configuration\n");
    const result = await build({ root, out: join(out, "site"), themeRoot: THEME, defaultLayout: "doc" });
    const html = readFileSync(join(out, "site/guide/configure-a-token/index.html"), "utf8");
    return { html, diagnostics: result.diagnostics };
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
}

test("the converted fixture builds into readable tabs, callouts, and a link", async () => {
  const page = await buildPage();

  assert.deepEqual(page.diagnostics.filter((d) => d.severity === "error"), []);
  assert.deepEqual(page.diagnostics.filter((d) => d.id === "link.missing-page"), []);
  assert.doesNotMatch(page.html, /<Tabs\b|<TabItem\b|<Card\b|@theme\/|@site\/|::::/);

  const labels = [...page.html.matchAll(/<button\b[^>]*role="tab"[^>]*>([^<]*)<\/button>/g)].map((match) => match[1]);
  assert.deepEqual(labels, ["Bash", "PowerShell"], "panels keep the fixture's order");
  assert.match(page.html, /<button[^>]*aria-selected="true"[^>]*>Bash<\/button>/, "the default panel opens first");
  assert.equal((page.html.match(/<div role="tabpanel"/g) ?? []).length, 2);

  assert.match(page.html, /<h2 id="set-the-token"/);
  assert.match(page.html, /class="callout callout-note"/);
  assert.match(page.html, /A token is read when a command starts\./);
  assert.match(page.html, /class="callout callout-tip"/);
  assert.match(page.html, />Write it once</);
  assert.match(page.html, /Add the token to your shell profile, then start a new shell:/);
  assert.match(page.html, /<ol\b[^>]*>/);
  assert.match(page.html, /<code>export BEACON_TOKEN=&#x3C;token>/);
  assert.match(page.html, /<code>beacon login<\/code>/);
  assert.match(page.html, /data-lang="powershell"/);
  assert.match(page.html, /Add the token to your profile, then start a new shell:/);
  assert.match(page.html, /Run <code>beacon token rotate<\/code> before the expiry date\./);
  assert.match(page.html, /Every shell reads <code>BEACON_TOKEN<\/code>; see <a href="configuration.md">Configuration<\/a>\./);
});

test("the report names every case the fixture needs converted by hand", () => {
  const report = formatText(converted.diagnostics);

  assert.match(report, new RegExp(`${FIXTURE}:38:1\\s+import\\.component\\s+Custom MDX component <Card>`));
  assert.match(report, /^0 errors, 1 warning$/m);
});
