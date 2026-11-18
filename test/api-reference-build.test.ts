/**
 * The OpenAPI reference in a whole build: ordinary doc pages, one per operation, an index that groups them by tag, a
 * navigation group, a Markdown twin that search can read, and sitemap entries. A broken reference is a diagnostic
 * with the source file's line and no pages.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { build } from "../src/pipeline/build.ts";

function tree(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

const THEME = {
  "src/index.ts": 'export const theme = { name: "t", folders: ["layouts"] };\n',
  "layouts/doc.ts": 'export default (p: any) => `<html><body>${p.page.html}</body></html>`;\n',
  "layouts/api-reference.ts":
    'export default (p: any) => `<html><body><h1>${p.page.title}</h1><p>${p.page.frontMatter.apiReference.operation.method} ${p.page.frontMatter.apiReference.operation.path}</p></body></html>`;\n',
  "layouts/api-reference-index.ts":
    'export default (p: any) => `<html><body><h1>${p.page.frontMatter.apiReference.title}</h1><p>${p.page.frontMatter.apiReference.version}</p><pre>${JSON.stringify(p.site.nav.docs)}</pre></body></html>`;\n',
};

const OPENAPI = `openapi: 3.1.0
info:
  title: Pet API
  version: 1.2.0
  description: Pets of the shop.
paths:
  /pets:
    get:
      operationId: listPets
      summary: List pets
      description: Every pet.
      tags: [pets]
      responses:
        "200":
          description: OK
    post:
      operationId: createPet
      summary: Create a pet
      tags: [pets]
      responses:
        "201":
          description: Created
`;

/** A site with one OpenAPI file and the config that points at it. */
function site(parent: string, openapi: string): { root: string; theme: string; out: string } {
  const theme = join(parent, "theme");
  tree(theme, THEME);
  const root = join(parent, "site");
  tree(root, {
    "mizzen.yml": "title: API site\nurl: https://example.org\napiReference:\n  source: api/openapi.yaml\n",
    "api/openapi.yaml": openapi,
  });
  return { root, theme, out: join(parent, "out") };
}

test("the build writes the index and one page per operation, with navigation, a twin and a sitemap entry", async () => {
  const parent = mkdtempSync(join(tmpdir(), "api-reference-"));
  try {
    const { root, theme, out } = site(parent, OPENAPI);
    const result = await build({ root, out, themeRoot: theme, defaultLayout: "doc" });

    assert.deepEqual(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error"), []);
    for (const file of ["reference/index.html", "reference/listPets/index.html", "reference/createPet/index.html"]) {
      assert.ok(result.files.includes(file), file);
    }

    const operation = readFileSync(join(out, "reference/listPets/index.html"), "utf8");
    assert.match(operation, /List pets/);
    assert.match(operation, /get \/pets/);

    const index = readFileSync(join(out, "reference/index.html"), "utf8");
    assert.match(index, /Pet API/);
    assert.match(index, /1\.2\.0/);
    assert.match(index, /\/reference\/listPets\//);

    const twin = readFileSync(join(out, "reference/listPets/index.md"), "utf8");
    assert.match(twin, /List pets/);
    assert.match(twin, /GET \/pets/);

    const sitemap = readFileSync(join(out, "sitemap.xml"), "utf8");
    assert.match(sitemap, /https:\/\/example\.org\/reference\/listPets\//);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a broken $ref is reported at the source file and line, and no page is written", async () => {
  const parent = mkdtempSync(join(tmpdir(), "api-reference-"));
  try {
    const broken = OPENAPI.replace(
      '      tags: [pets]\n      responses:\n        "200":\n          description: OK',
      "      parameters:\n        - $ref: '#/components/parameters/missing'\n      responses:\n        \"200\":\n          description: OK",
    );
    const { root, theme, out } = site(parent, broken);
    const result = await build({ root, out, themeRoot: theme, defaultLayout: "doc" });

    const finding = result.diagnostics.find((diagnostic) => diagnostic.id === "api-reference.reference-missing");
    assert.ok(finding, "the broken reference is reported");
    assert.equal(finding.severity, "error");
    assert.equal(finding.pos?.file, "api/openapi.yaml");
    assert.ok((finding.pos?.line ?? 0) > 1);
    assert.equal(result.files.includes("reference/listPets/index.html"), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
