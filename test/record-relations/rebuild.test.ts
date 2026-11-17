/** Rebuilding pages affected by a related record: sorted dependencies, and a warm build identical to a clean one. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { relationDependenciesOf } from "../../src/data/relations/dependencies.ts";
import { build } from "../../src/pipeline/build.ts";
import { pageAt, withSite } from "../data-record-site.ts";

const REPO = fileURLToPath(new URL("../../", import.meta.url));

const CONFIG =
  "title: Relations\n" +
  "url: https://example.test\n" +
  "collections:\n" +
  "  products:\n" +
  "    source: _data/products.yml\n" +
  "    template: _templates/products.md\n" +
  "    permalink: /products/{id}/\n" +
  "    references:\n" +
  "      rule: rules\n" +
  "  release-lines:\n" +
  "    source: _data/release-lines.yml\n" +
  "    template: _templates/release-lines.md\n" +
  "    permalink: /releases/{id}/\n" +
  "    references:\n" +
  "      product: products\n" +
  "      rules: rules\n" +
  "  rules:\n" +
  "    source: _data/rules.yml\n" +
  "    template: _templates/rules.md\n" +
  "    permalink: /rules/{id}/\n";

const FILES = {
  "mizzen.yml": CONFIG,
  "_data/products.yml": "- id: starling\n  name: Starling\n  rule: hold\n",
  "_data/release-lines.yml": "- id: rel-1\n  product: starling\n  rules: [hold, draft]\n- id: rel-2\n  product: starling\n  rules: [hold]\n",
  "_data/rules.yml": "- id: draft\n  title: Draft\n  summary: Not yet\n- id: hold\n  title: Hold\n  summary: Holds work\n",
  "_templates/products.md": "---\nlayout: doc\ntitle: \"{name}\"\n---\n# :field[name]\n",
  "_templates/release-lines.md": "---\nlayout: doc\ntitle: \"Release {id}\"\n---\n# :field[id]\n",
  "_templates/rules.md": "---\nlayout: doc\ntitle: \"Rule {id}\"\n---\n# :field[id]\n",
  "releases/index.md": "---\nlayout: doc\ntitle: Releases\nlist:\n  collection: release-lines\n---\n# Releases\n",
};

/** A theme that shows every related record's `title` on record and list pages, read from the site model. */
function makeTheme(): string {
  const root = mkdtempSync(join(tmpdir(), "relations-rebuild-theme-"));
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"), "dir");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "layouts"), { recursive: true });
  writeFileSync(join(root, "src/index.ts"), 'export const theme = { name: "relations-rebuild-test", folders: ["layouts"] };\n');
  writeFileSync(
    join(root, "layouts/doc.ts"),
    `import { h } from "preact";
import type { Layout } from "@velella/mizzen/contracts";

const relatedTitles = (props, collection, fields) => {
  const references = props.site.config.collections[collection]?.references ?? {};
  const lines = [];
  for (const field of Object.keys(references).sort()) {
    const value = fields[field];
    const ids = Array.isArray(value) ? value : [value];
    for (const id of ids) {
      if (typeof id !== "string" && typeof id !== "number") continue;
      const target = props.site.collections[references[field]]?.records.find((record) => record.id === String(id));
      lines.push(field + "=" + String(target?.fields["title"] ?? "missing"));
    }
  }
  return lines;
};

const doc: Layout = (props) => {
  const rows =
    props.record !== undefined
      ? ["record " + props.record.id + " " + relatedTitles(props, props.record.collection, props.record.fields).join(",")]
      : (props.list?.records ?? []).map((record) => "row " + record.id + " " + relatedTitles(props, record.collection, record.fields).join(","));
  return h(
    "html",
    null,
    h(
      "body",
      null,
      h("main", { dangerouslySetInnerHTML: { __html: props.page.html } }),
      h("pre", { id: "relations" }, rows.join("\\n")),
    ),
  );
};

export default doc;
`,
  );
  return root;
}

/** A temporary site from a path-to-text map. */
function tree(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "relations-rebuild-site-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** Outputs and the cache live beside the site, never inside it. */
function scratch(): { parent: string; out: string; clean: string; cacheDir: string } {
  const parent = mkdtempSync(join(tmpdir(), "relations-rebuild-out-"));
  return { parent, out: join(parent, "site"), clean: join(parent, "clean"), cacheDir: join(parent, "cache") };
}

/** Every file under `dir` as path → bytes, so two builds compare byte for byte. */
function snapshot(dir: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rel of readdirSync(dir, { recursive: true }) as string[]) {
    const abs = join(dir, rel);
    if (statSync(abs).isFile()) map.set(rel.split("\\").join("/"), readFileSync(abs).toString("latin1"));
  }
  return map;
}

const nested = (dependencies: readonly { readonly field: string; readonly collection: string; readonly id: string }[]) =>
  dependencies.map((dependency) => `${dependency.field}/${dependency.collection}/${dependency.id}`);

test("a record and a list depend on every related record, sorted and deduplicated", async () => {
  await withSite(FILES, (_root, result) => {
    assert.deepEqual(result.diagnostics, []);
    const dependencies = relationDependenciesOf(result.site);

    assert.deepEqual(nested(dependencies(pageAt(result, "/releases/rel-1/")!)), [
      "product/products/starling",
      "rules/rules/draft",
      "rules/rules/hold",
    ]);
    assert.deepEqual(nested(dependencies(pageAt(result, "/products/starling/")!)), ["rule/rules/hold"]);
    assert.deepEqual(nested(dependencies(pageAt(result, "/releases/")!)), [
      "product/products/starling",
      "rules/rules/draft",
      "rules/rules/hold",
    ]);
    assert.deepEqual(dependencies(pageAt(result, "/rules/hold/")!), []);
  });
});

test("changing a related record re-renders its record and list pages, and the warm output equals a clean build", async () => {
  const root = tree(FILES);
  const theme = makeTheme();
  const { parent, out, clean, cacheDir } = scratch();
  try {
    const base = { root, themeRoot: theme, defaultLayout: "doc", cache: true, cacheDir } as const;
    const cold = await build({ ...base, out });
    assert.deepEqual(cold.diagnostics, []);

    const file = join(root, "_data/rules.yml");
    writeFileSync(file, readFileSync(file, "utf8").replace("title: Hold", "title: Held"));

    const warm = await build({ ...base, out });
    assert.deepEqual(warm.diagnostics, []);
    assert.equal(warm.renderedPages, 5, "the dependent record pages and the list render again");
    assert.equal(warm.cachedPages, 1, "the rule that does not depend on the change is reused");
    assert.match(readFileSync(join(out, "products/starling/index.html"), "utf8"), /rule=Held/);
    assert.match(readFileSync(join(out, "releases/rel-1/index.html"), "utf8"), /rules=Held/);
    assert.match(readFileSync(join(out, "releases/index.html"), "utf8"), /rules=Held/);

    await build({ root, out: clean, themeRoot: theme, defaultLayout: "doc" });
    assert.deepEqual(snapshot(out), snapshot(clean));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(theme, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("deleting a related record re-renders its record and list pages, and the warm output equals a clean build", async () => {
  const root = tree(FILES);
  const theme = makeTheme();
  const { parent, out, clean, cacheDir } = scratch();
  try {
    const base = { root, themeRoot: theme, defaultLayout: "doc", cache: true, cacheDir } as const;
    const cold = await build({ ...base, out });
    assert.deepEqual(cold.diagnostics, []);

    const file = join(root, "_data/rules.yml");
    writeFileSync(file, readFileSync(file, "utf8").replace("- id: hold\n  title: Hold\n  summary: Holds work\n", ""));

    const warm = await build({ ...base, out });
    assert.ok(warm.diagnostics.some((diagnostic) => diagnostic.id === "data.reference-missing"));
    assert.match(readFileSync(join(out, "products/starling/index.html"), "utf8"), /rule=missing/);
    assert.match(readFileSync(join(out, "releases/rel-1/index.html"), "utf8"), /rules=missing/);
    assert.match(readFileSync(join(out, "releases/index.html"), "utf8"), /rules=missing/);

    await build({ root, out: clean, themeRoot: theme, defaultLayout: "doc" });
    assert.deepEqual(snapshot(out), snapshot(clean));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(theme, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});
