// Rebuilding shared content: a fragment, a nested include, or a parameter is an input of every page that consumes it,
// and of no other page. Each case edits one input, checks which pages the render cache reused, and compares the
// incremental output with a full build byte for byte.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "../../src/pipeline/build.ts";
import { outputNodeId } from "../../src/pipeline/dependency-graph.ts";

const REPO = fileURLToPath(new URL("../../", import.meta.url));

/** A temporary folder holding `files`; the caller removes it. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "include-rebuild-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** Outputs and the cache live beside the site, never inside it. */
function scratch(): { parent: string; out: string; clean: string; cacheDir: string } {
  const parent = mkdtempSync(join(tmpdir(), "include-rebuild-out-"));
  return { parent, out: join(parent, "site"), clean: join(parent, "clean"), cacheDir: join(parent, "cache") };
}

/** A theme whose layout renders the page body, and nothing shared between pages. */
function makeTheme(): string {
  const root = mkdtempSync(join(tmpdir(), "include-rebuild-theme-"));
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"), "dir");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "layouts"), { recursive: true });
  writeFileSync(join(root, "src/index.ts"), 'export const theme = { name: "include-rebuild-test", folders: ["layouts"] };\n');
  writeFileSync(
    join(root, "layouts/doc.ts"),
    `import { h } from "preact";
import type { Layout } from "@velella/mizzen/contracts";

const doc: Layout = (props) =>
  h("html", null, h("body", null, h("main", { dangerouslySetInnerHTML: { __html: props.page.html } })));

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
    if (statSync(abs).isFile()) map.set(rel.split("\\").join("/"), readFileSync(abs, "latin1"));
  }
  return map;
}

const FRAGMENT = `---
params:
  product: Beacon
---
## Install {{product}}

::include[steps.md]
`;

/** Two pages share one fragment with two values; a third page consumes neither. */
function site(fragment = FRAGMENT): string {
  return tree({
    "mizzen.yml": "title: Includes\n",
    "_data/navigation.yml": "main:\n  - title: Home\n    url: /\n  - title: Alpha\n    url: /alpha/\n  - title: Beta\n    url: /beta/\n",
    "_snippets/install.md": fragment,
    "_snippets/steps.md": "Run the installer.\n",
    "index.md": "---\ntitle: Home\n---\n# Home\n",
    "alpha.md": '---\ntitle: Alpha\n---\n# Alpha\n\n::include[_snippets/install.md]{product="Orbit"}\n',
    "beta.md": "---\ntitle: Beta\n---\n# Beta\n\n::include[_snippets/install.md]\n",
    "gamma.md": "---\ntitle: Gamma\n---\n# Gamma\n\nNothing shared.\n",
  });
}

/** Builds `root` incrementally with the cache on, after the first build. */
async function warm(root: string, theme: string, cacheDir: string, out: string) {
  return build({ root, out, themeRoot: theme, defaultLayout: "doc", cache: true, cacheDir });
}

/** The incremental output is exactly what the same source produces without a cache. */
async function assertMatchesCleanBuild(root: string, theme: string, scratchDir: ReturnType<typeof scratch>): Promise<void> {
  await build({ root, out: scratchDir.clean, themeRoot: theme, defaultLayout: "doc" });
  assert.deepEqual(snapshot(scratchDir.out), snapshot(scratchDir.clean));
}

test("a fragment edit re-renders both consumers and leaves an unrelated page cached", async () => {
  const root = site();
  const theme = makeTheme();
  const dirs = scratch();
  try {
    const cold = await warm(root, theme, dirs.cacheDir, dirs.out);
    assert.equal(cold.renderedPages, 4);

    writeFileSync(join(root, "_snippets/install.md"), FRAGMENT.replace("## Install", "## Set up"));
    const result = await warm(root, theme, dirs.cacheDir, dirs.out);

    assert.equal(result.renderedPages, 2, "both consumers render");
    assert.equal(result.cachedPages, 2, "the home and unrelated pages are reused");
    assert.deepEqual(result.invalidation?.outputs.map((output) => output.id), [
      outputNodeId("/alpha/"),
      outputNodeId("/beta/"),
    ]);
    for (const page of ["alpha", "beta"]) {
      assert.match(readFileSync(join(dirs.out, page, "index.html"), "utf8"), /Set up/);
    }
    assert.doesNotMatch(readFileSync(join(dirs.out, "gamma/index.html"), "utf8"), /Set up/);
    await assertMatchesCleanBuild(root, theme, dirs);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(theme, { recursive: true, force: true });
    rmSync(dirs.parent, { recursive: true, force: true });
  }
});

test("a nested include edit re-renders both consumers, through the fragment that holds it", async () => {
  const root = site();
  const theme = makeTheme();
  const dirs = scratch();
  try {
    await warm(root, theme, dirs.cacheDir, dirs.out);

    writeFileSync(join(root, "_snippets/steps.md"), "Run the installer, then restart.\n");
    const result = await warm(root, theme, dirs.cacheDir, dirs.out);

    assert.equal(result.renderedPages, 2, "both consumers render");
    assert.equal(result.cachedPages, 2, "the home and unrelated pages are reused");
    assert.deepEqual(result.invalidation?.outputs.map((output) => output.id), [
      outputNodeId("/alpha/"),
      outputNodeId("/beta/"),
    ]);
    assert.deepEqual(result.invalidation?.outputs[1]!.transitive[0]!.chain.map((step) => step.path), [
      "/beta/",
      "beta.md",
      "_snippets/install.md",
      "_snippets/steps.md",
    ]);
    assert.match(readFileSync(join(dirs.out, "beta/index.html"), "utf8"), /then restart/);
    await assertMatchesCleanBuild(root, theme, dirs);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(theme, { recursive: true, force: true });
    rmSync(dirs.parent, { recursive: true, force: true });
  }
});

test("a call-site parameter change re-renders only the page that owns it", async () => {
  const root = site();
  const theme = makeTheme();
  const dirs = scratch();
  try {
    await warm(root, theme, dirs.cacheDir, dirs.out);

    writeFileSync(
      join(root, "beta.md"),
      '---\ntitle: Beta\n---\n# Beta\n\n::include[_snippets/install.md]{product="Comet"}\n',
    );
    const result = await warm(root, theme, dirs.cacheDir, dirs.out);

    assert.equal(result.renderedPages, 1, "only the page whose value changed renders");
    assert.equal(result.cachedPages, 3);
    assert.deepEqual(result.invalidation?.outputs.map((output) => output.id), [outputNodeId("/beta/")]);
    assert.match(readFileSync(join(dirs.out, "beta/index.html"), "utf8"), /Install Comet/);
    assert.match(readFileSync(join(dirs.out, "alpha/index.html"), "utf8"), /Install Orbit/);
    await assertMatchesCleanBuild(root, theme, dirs);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(theme, { recursive: true, force: true });
    rmSync(dirs.parent, { recursive: true, force: true });
  }
});

test("a declared default change re-renders the page that uses it, and not the page with its own value", async () => {
  const root = site();
  const theme = makeTheme();
  const dirs = scratch();
  try {
    await warm(root, theme, dirs.cacheDir, dirs.out);

    writeFileSync(join(root, "_snippets/install.md"), FRAGMENT.replace("product: Beacon", "product: Comet"));
    const result = await warm(root, theme, dirs.cacheDir, dirs.out);

    assert.equal(result.renderedPages, 1, "beta reads the default; alpha supplies its own value");
    assert.equal(result.cachedPages, 3);
    assert.match(readFileSync(join(dirs.out, "beta/index.html"), "utf8"), /Install Comet/);
    assert.match(readFileSync(join(dirs.out, "alpha/index.html"), "utf8"), /Install Orbit/);
    await assertMatchesCleanBuild(root, theme, dirs);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(theme, { recursive: true, force: true });
    rmSync(dirs.parent, { recursive: true, force: true });
  }
});
