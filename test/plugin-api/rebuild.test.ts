import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Plugin } from "../../src/contracts/index.ts";
import { pluginInputs } from "../../src/plugins/dependencies.ts";
import { build } from "../../src/pipeline/build.ts";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const CONTRACTS = pathToFileURL(join(REPO, "src/contracts/index.ts")).href;
const CODE = "mizzen.config.ts";

type RunCounter = { pluginRuns?: number };

function runs(): number {
  return (globalThis as RunCounter).pluginRuns ?? 0;
}

function resetRuns(): void {
  (globalThis as RunCounter).pluginRuns = 0;
}

/** A temporary site holding `files`, so a test can edit one input between builds. */
function siteRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "plugin-rebuild-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** A theme whose layout prints the page title, the one thing the test plugin changes. */
function makeTheme(): string {
  const root = mkdtempSync(join(tmpdir(), "plugin-rebuild-theme-"));
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"), "dir");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "layouts"), { recursive: true });
  writeFileSync(join(root, "src/index.ts"), 'export const theme = { name: "plugin-rebuild-test", folders: ["layouts"] };\n');
  writeFileSync(
    join(root, "layouts/doc.ts"),
    `import { h } from "preact";
import type { Layout } from "@velella/mizzen/contracts";

const doc: Layout = (props) =>
  h("html", null, h("body", null, h("pre", { id: "title" }, props.page.title), h("div", { dangerouslySetInnerHTML: { __html: props.page.html } })));

export default doc;
`,
  );
  return root;
}

/**
 * A code file listing one plugin: it counts its content runs, reads the site's `stamp.txt` — beside the code file, so
 * outside the source folder — and puts that text in the page title.
 */
function pluginCode(fields: string): string {
  return `import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from ${JSON.stringify(CONTRACTS)};

const plugin: Plugin = {
  name: "stamp",
  ${fields}
  content(page) {
    const globals = globalThis as { pluginRuns?: number };
    globals.pluginRuns = (globals.pluginRuns ?? 0) + 1;
    const stamp = readFileSync(join(import.meta.dirname, "stamp.txt"), "utf8").trim();
    return { ...page, title: \`\${page.title} \${stamp}\` };
  },
};

export default { plugins: [plugin] };
`;
}

/** The site's sources and its one declared input; `stamp.txt` sits outside `src/`, so only the declaration tracks it. */
const SITE = {
  "mizzen.yml": "title: Rebuild\nurl: https://example.com\nsource: src\n",
  "src/index.md": "---\ntitle: Home\n---\n# Home\n",
  "stamp.txt": "one\n",
};

/** A temporary output and cache folder. */
function scratch(): { parent: string; out: string; cacheDir: string } {
  const parent = mkdtempSync(join(tmpdir(), "plugin-rebuild-out-"));
  return { parent, out: join(parent, "site"), cacheDir: join(parent, "cache") };
}

/** Every file under `dir` as path → bytes, so two builds can be compared byte for byte. */
function snapshot(dir: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rel of readdirSync(dir, { recursive: true }) as string[]) {
    const abs = join(dir, rel);
    if (statSync(abs).isFile()) map.set(rel.split("\\").join("/"), readFileSync(abs, "latin1"));
  }
  return map;
}

/** The cache entry folders: the ones named after a key. */
function entries(cacheDir: string): string[] {
  if (!existsSync(cacheDir)) return [];
  return readdirSync(cacheDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[0-9a-f]{64}$/.test(entry.name))
    .map((entry) => entry.name);
}

test("two builds with fixed input reuse the cache and write identical bytes", async () => {
  const root = siteRoot({ ...SITE, [CODE]: pluginCode('version: "1",\n  settings: { label: "one" },\n  inputs: ["stamp.txt"],') });
  const theme = makeTheme();
  const { parent, out, cacheDir } = scratch();
  try {
    resetRuns();
    const first = await build({ root, out, themeRoot: theme, defaultLayout: "doc", cache: true, cacheDir });
    assert.ok(runs() > 0, "the cold build ran the plugin");
    const cold = snapshot(out);

    resetRuns();
    const second = await build({ root, out, themeRoot: theme, defaultLayout: "doc", cache: true, cacheDir });
    assert.equal(runs(), 0, "the cache hit did not run the plugin");
    assert.deepEqual(second.files, first.files);
    assert.deepEqual(second.diagnostics, first.diagnostics);
    assert.deepEqual(snapshot(out), cold, "the cached build wrote the cold build's bytes");
    assert.equal(entries(cacheDir).length, 1, "the site has one whole-build entry");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(theme, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a plugin version or settings change moves the declared input digest", async () => {
  const root = siteRoot({ "stamp.txt": "one\n" });
  const base: Plugin = {
    name: "stamp",
    version: "1",
    settings: { label: "one", list: [1, 2] },
    inputs: ["stamp.txt"],
    content: (page) => page,
  };
  try {
    const key = await pluginInputs([base], root);
    assert.match(key ?? "", /^[0-9a-f]{64}$/, "a tracked plugin has a digest");
    assert.equal(await pluginInputs([base], root), key, "the same declarations give one digest");
    assert.equal(
      await pluginInputs([{ ...base, settings: { list: [1, 2], label: "one" } }], root),
      key,
      "settings compare by value, not by key order",
    );
    assert.notEqual(await pluginInputs([{ ...base, version: "2" }], root), key, "a version change is a miss");
    assert.notEqual(await pluginInputs([{ ...base, settings: { label: "two" } }], root), key, "a settings change is a miss");
    assert.equal(
      await pluginInputs([{ ...base, inputs: ["stamp.txt", "stamp.txt"] }], root),
      key,
      "the order and repeats of declared files are not inputs",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a declared input outside the source folder misses the cache when its bytes change", async () => {
  const root = siteRoot({ ...SITE, [CODE]: pluginCode('inputs: ["stamp.txt"],') });
  const theme = makeTheme();
  const { parent, out, cacheDir } = scratch();
  try {
    resetRuns();
    await build({ root, out, themeRoot: theme, defaultLayout: "doc", cache: true, cacheDir });
    assert.ok(runs() > 0, "the cold build ran the plugin");
    const cold = snapshot(out);
    assert.match(cold.get("index.html") ?? "", /Home one/);

    resetRuns();
    await build({ root, out, themeRoot: theme, defaultLayout: "doc", cache: true, cacheDir });
    assert.equal(runs(), 0, "an unchanged declared input is a cache hit");

    writeFileSync(join(root, "stamp.txt"), "two\n");
    resetRuns();
    await build({ root, out, themeRoot: theme, defaultLayout: "doc", cache: true, cacheDir });
    assert.ok(runs() > 0, "a declared input's new bytes run the build");
    const warm = snapshot(out);
    assert.match(warm.get("index.html") ?? "", /Home two/);
    assert.notDeepEqual(warm, cold, "the rebuilt output carries the new input");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(theme, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a plugin with no inputs, or an input outside the site, builds cold every time", async () => {
  const declarations = ['', 'inputs: ["../outside.txt"],'];
  for (const fields of declarations) {
    const root = siteRoot({ ...SITE, [CODE]: pluginCode(fields) });
    const theme = makeTheme();
    const { parent, out, cacheDir } = scratch();
    try {
      resetRuns();
      await build({ root, out, themeRoot: theme, defaultLayout: "doc", cache: true, cacheDir });
      resetRuns();
      const second = await build({ root, out, themeRoot: theme, defaultLayout: "doc", cache: true, cacheDir });
      assert.ok(runs() > 0, `the second build ran the plugin for ${fields === "" ? "no inputs" : "an outside input"}`);
      assert.equal(entries(cacheDir).length, 0, "an untracked plugin site writes no whole-build entry");
      assert.equal(second.diagnostics.length, 0, JSON.stringify(second.diagnostics, null, 2));
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(theme, { recursive: true, force: true });
      rmSync(parent, { recursive: true, force: true });
    }
  }
});
