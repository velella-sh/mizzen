/**
 * Issue #566: a snippet reads a file that discovery may skip, so that file's bytes are a build input. Editing,
 * moving, or deleting it must miss the whole-build cache, and a warm build must equal a clean one.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../src/config/load.ts";
import { build } from "../../src/pipeline/build.ts";
import { cacheKey, type CacheKeyOptions } from "../../src/pipeline/cache.ts";

const REPO = fileURLToPath(new URL("../../", import.meta.url));

/** A temporary folder holding `files`. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "code-snippets-rebuild-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** The fixture site: one page renders the source, another does not. */
const SOURCE = "export const one = 1;\nexport const two = 2;\n";
function site(): string {
  return tree({
    "mizzen.yml": "title: Snippets\n",
    "_examples/example.ts": SOURCE,
    "guide.md": "---\ntitle: Guide\n---\n# Guide\n\n::include[_examples/example.ts]{lines=1-2}\n",
    "index.md": "---\ntitle: Home\n---\n# Home\n",
  });
}

/** A theme whose layout renders the page body. */
function makeTheme(): string {
  const root = mkdtempSync(join(tmpdir(), "code-snippets-theme-"));
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"), "dir");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "layouts"), { recursive: true });
  writeFileSync(join(root, "src/index.ts"), 'export const theme = { name: "snippet-rebuild", folders: ["layouts"] };\n');
  writeFileSync(
    join(root, "layouts/doc.ts"),
    `import { h } from "preact";
import type { Layout } from "@velella/mizzen/contracts";

const doc: Layout = (props) => h("html", null, h("body", null, h("main", { dangerouslySetInnerHTML: { __html: props.page.html } })));

export default doc;
`,
  );
  return root;
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

test("a changed, moved, or deleted snippet source changes the whole-build key", async () => {
  const root = site();
  const theme = mkdtempSync(join(tmpdir(), "code-snippets-rebuild-theme-"));
  const outputs = mkdtempSync(join(tmpdir(), "code-snippets-rebuild-outputs-"));
  try {
    const options: CacheKeyOptions = {
      root,
      sourceDir: root,
      config: loadConfig(root).config,
      themeRoot: theme,
      outputsDir: outputs,
      out: join(root, ".out"),
    };
    const base = await cacheKey(options);

    writeFileSync(join(root, "_examples/example.ts"), "export const one = 10;\nexport const two = 2;\n");
    const changed = await cacheKey(options);
    assert.notEqual(changed, base, "an edited source is a different input");

    renameSync(join(root, "_examples/example.ts"), join(root, "_examples/moved.ts"));
    const moved = await cacheKey(options);
    assert.notEqual(moved, changed, "a moved source is a different input");

    rmSync(join(root, "_examples/moved.ts"));
    const deleted = await cacheKey(options);
    assert.notEqual(deleted, moved, "a deleted source is a different input");

    writeFileSync(join(root, "_examples/example.ts"), SOURCE);
    assert.equal(await cacheKey(options), base, "the same files give the same key");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(theme, { recursive: true, force: true });
    rmSync(outputs, { recursive: true, force: true });
  }
});

/** One way a source changes, and the text the page shows when it still renders code. */
const CHANGES: readonly { readonly name: string; readonly mutate: (root: string) => void; readonly rendered?: RegExp }[] = [
  {
    name: "edited",
    mutate: (root) => writeFileSync(join(root, "_examples/example.ts"), "export const one = 1;\nexport const two = 22;\n"),
    rendered: /export const two = 22;/,
  },
  { name: "moved", mutate: (root) => renameSync(join(root, "_examples/example.ts"), join(root, "_examples/moved.ts")) },
  { name: "deleted", mutate: (root) => rmSync(join(root, "_examples/example.ts")) },
];

test("a changed, moved, or deleted source rebuilds its page only, and the incremental output equals a clean build", async () => {
  for (const change of CHANGES) {
    const root = site();
    const theme = makeTheme();
    const parent = mkdtempSync(join(tmpdir(), "code-snippets-rebuild-out-"));
    const out = join(parent, "site");
    const clean = join(parent, "clean");
    const cacheDir = join(parent, "cache");
    try {
      const cold = await build({ root, out, themeRoot: theme, defaultLayout: "doc", cache: true, cacheDir });
      assert.equal(cold.renderedPages, 2, `${change.name}: the first build renders every page`);

      change.mutate(root);
      const warm = await build({ root, out, themeRoot: theme, defaultLayout: "doc", cache: true, cacheDir });
      assert.equal(warm.renderedPages, 1, `${change.name}: only the page that renders the source renders again`);
      assert.equal(warm.cachedPages, 1, `${change.name}: the unrelated page stays cached`);

      await build({ root, out: clean, themeRoot: theme, defaultLayout: "doc" });
      assert.deepEqual(snapshot(out), snapshot(clean), `${change.name}: the warm build writes the clean build's bytes`);
      if (change.rendered !== undefined) {
        assert.match(readFileSync(join(out, "guide/index.html"), "utf8"), change.rendered);
        assert.doesNotMatch(readFileSync(join(out, "index.html"), "utf8"), change.rendered);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(theme, { recursive: true, force: true });
      rmSync(parent, { recursive: true, force: true });
    }
  }
});
