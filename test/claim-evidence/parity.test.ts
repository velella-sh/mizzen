import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { build } from "../../src/pipeline/build.ts";
import { site } from "../data-record-site.ts";

const FILES = {
  "mizzen.yml":
    "title: Claim evidence fixture\n" +
    "collections:\n" +
    "  findings:\n" +
    "    source: _data/findings.yml\n" +
    "    id: id\n" +
    "    template: _templates/finding.md\n" +
    "    permalink: /findings/{id}/\n" +
    "    evidence: claims\n",
  "_data/findings.yml":
    "- id: ebb-node-18\n" +
    "  statement: Node 18 reaches end of life.\n" +
    "  eol: 2025-04-30\n" +
    "  claims:\n" +
    "    eol:\n" +
    "      - id: node-18-schedule\n" +
    "        title: Node.js release schedule\n" +
    "        url: https://nodejs.org/en/about/previous-releases#release-schedule\n" +
    "      - id: node-18-announcement\n" +
    "        title: Node.js 18 release announcement\n" +
    "        url: https://nodejs.org/en/blog/announcements/v18-release-announce\n" +
    "- id: offing-checkout-v3\n" +
    "  statement: Workflows still pin actions/checkout v3.\n" +
    "  openWorkflows: 1204\n" +
    "  claims:\n" +
    "    openWorkflows:\n" +
    "      id: workflow-inventory\n" +
    "      title: Workflow inventory, 2026-03-01\n" +
    "      url: https://offing.example.org/runs/2026-03-01/workflows.json\n" +
    "      note: Counted by scripts/inventory.ts; not published.\n",
  "_templates/finding.md":
    "---\ntitle: \"{statement}\"\nlayout: doc\n---\n" +
    ":field[statement]\n\n" +
    ":::if{field=eol}\nEnd of life: :field[eol] (:evidence[eol]).\n:::\n\n" +
    ":::if{field=openWorkflows}\nOpen workflows: :field[openWorkflows] (:evidence[openWorkflows]).\n:::\n\n" +
    "Raw: :field[claims]\n",
};

interface Claim {
  readonly id: string;
  readonly title: string;
  readonly url: string;
}

/** A theme with one layout, which prints the page body the build made. */
function theme(): string {
  const root = mkdtempSync(join(tmpdir(), "claim-evidence-theme-"));
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "claim-evidence-theme", type: "module" }),
    "src/index.ts": 'export const theme = { name: "claim-evidence-theme", folders: ["layouts"] };\n',
    "layouts/doc.ts":
      "export default function doc({ page }) {\n" +
      '  return `<!DOCTYPE html>\\n<html lang="en"><body>${page.html}</body></html>\\n`;\n' +
      "}\n",
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** The links the page HTML carries, in document order. */
function linksOf(html: string): Array<{ readonly title: string; readonly url: string }> {
  return [...html.matchAll(/<a href="([^"]*)">([^<]*)<\/a>/g)].map((match) => ({
    url: match[1]!,
    title: match[2]!,
  }));
}

/** The claims a page JSON publishes for one field. */
function evidenceOf(json: Record<string, unknown>, field: string): Claim[] {
  const record = json.record as { readonly evidence?: Record<string, readonly Claim[]> } | undefined;
  return [...(record?.evidence?.[field] ?? [])];
}

/** The HTML links paired with the JSON ids in the same positions. */
function parityOf(
  html: string,
  claims: readonly Claim[],
): Array<{ readonly id: string | undefined; readonly title: string; readonly url: string }> {
  return linksOf(html).map((link, index) => ({ id: claims[index]?.id, ...link }));
}

test("HTML and page JSON carry the same date and number claims, each from its own source", async () => {
  const root = site(FILES);
  const themeRoot = theme();
  const out = mkdtempSync(join(tmpdir(), "claim-evidence-out-"));
  try {
    const result = await build({ root, out, themeRoot, defaultLayout: "doc" });
    assert.deepEqual(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error"), []);

    const dateHtml = readFileSync(join(out, "findings/ebb-node-18/index.html"), "utf8");
    const dateJson = JSON.parse(readFileSync(join(out, "findings/ebb-node-18/index.json"), "utf8")) as Record<string, unknown>;
    const dateClaims = evidenceOf(dateJson, "eol");
    assert.deepEqual(parityOf(dateHtml, dateClaims), dateClaims);
    assert.deepEqual(dateClaims.map((claim) => claim.id), ["node-18-schedule", "node-18-announcement"]);
    assert.match(dateHtml, /End of life: <span[^>]*>2025-04-30<\/span> \(/);
    assert.doesNotMatch(dateHtml, /workflow-inventory|Workflow inventory|offing\.example\.org/);

    const numberHtml = readFileSync(join(out, "findings/offing-checkout-v3/index.html"), "utf8");
    const numberJson = JSON.parse(readFileSync(join(out, "findings/offing-checkout-v3/index.json"), "utf8")) as Record<string, unknown>;
    const numberClaims = evidenceOf(numberJson, "openWorkflows");
    assert.deepEqual(parityOf(numberHtml, numberClaims), numberClaims);
    assert.deepEqual(numberClaims.map((claim) => claim.id), ["workflow-inventory"]);
    assert.match(numberHtml, /Open workflows: <span[^>]*>1204<\/span> \(/);
    assert.doesNotMatch(numberHtml, /node-18-schedule|Node\.js release schedule|nodejs\.org/);

    for (const [html, json] of [[dateHtml, dateJson], [numberHtml, numberJson]] as const) {
      assert.ok(!html.includes("Counted by"), "the private note never reaches HTML");
      assert.ok(!JSON.stringify(json).includes("Counted by"), "the private note never reaches JSON");
      const record = json.record as { readonly fields: Record<string, unknown> };
      assert.ok(!("claims" in record.fields), "the raw evidence field is not a public field");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(themeRoot, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test("the comparison fails when either side loses a source", () => {
  const claims: Claim[] = [
    { id: "a", title: "First source", url: "https://example.org/first" },
    { id: "b", title: "Second source", url: "https://example.org/second" },
  ];
  const html = '<a href="https://example.org/first">First source</a>, <a href="https://example.org/second">Second source</a>';
  assert.deepEqual(parityOf(html, claims), claims);
  assert.throws(() => assert.deepEqual(parityOf(html.replace("first", "elsewhere"), claims), claims));
  assert.throws(() => assert.deepEqual(parityOf(html, claims.slice(1)), claims));
});
