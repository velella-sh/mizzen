import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import type { Heading, NavTree, Page, Plugin, Site, SiteConfig, SourcePos } from "../../src/contracts/index.ts";
import { CODE_CONFIG_FILE, loadCodeConfig, runContentHooks, runModelHooks } from "../../src/plugins/hooks.ts";

const installPos: SourcePos = { file: "guide/install.md", line: 4, column: 3, endLine: 9, endColumn: 1 };

/** A site config with the defaults a build fills in. */
function config(): SiteConfig {
  return {
    title: "Mizzen",
    base: "",
    lang: "en",
    dir: "ltr",
    languages: [],
    source: ".",
    include: [],
    exclude: [],
    navigation: "_data/navigation.yml",
    collections: {},
    feeds: {},
    defaults: [],
    theme: { options: {} },
    search: {},
    redirects: {},
    outputs: {},
  };
}

function page(url: string, source: SourcePos = installPos): Page {
  return {
    url,
    source,
    frontMatter: { description: "Install Mizzen." },
    title: url,
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "",
    markdown: "",
    kind: "doc",
  };
}

function site(pages: readonly Page[]): Site {
  const nav: NavTree = { lists: [] };
  return { config: config(), pages, nav, collections: {}, data: {} };
}

/** A site folder holding the given files; the caller removes it when the test ends. */
function siteRoot(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "plugin-api-"));
  for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
  return root;
}

/** A site's code file: `body` declares the plugins and `list` names them in the default export. */
function codeFile(body: string, list: string): Record<string, string> {
  const importPlugin = `import type { Plugin } from ${JSON.stringify(
    pathToFileURL(join(process.cwd(), "src/contracts/index.ts")).href,
  )};\n`;
  return { [CODE_CONFIG_FILE]: `${importPlugin}${body}export default { plugins: [${list}] };\n` };
}

test("the plugin-api fixture lists its plugins in the declared order", async () => {
  const loaded = await loadCodeConfig(join(process.cwd(), "fixtures/plugin-api"));
  assert.deepEqual(loaded.diagnostics, []);
  assert.deepEqual(
    loaded.plugins.map((plugin) => plugin.name),
    ["require-description", "reading-time", "inventory", "write-inventory"],
  );
});

test("hooks run in the order the code file lists them, sync or async, each on the value before it", async () => {
  const order: string[] = [];
  const plugins: Plugin[] = [
    {
      name: "z-first",
      content: (value) => {
        order.push("z-first");
        return { ...value, title: "first" };
      },
    },
    {
      name: "a-second",
      content: async (value) => {
        await Promise.resolve();
        order.push(`a-second:${value.title}`);
        return { ...value, title: "second" };
      },
    },
    {
      name: "m-third",
      content: (value) => {
        order.push(`m-third:${value.title}`);
        return value;
      },
    },
  ];

  const result = await runContentHooks(plugins, page("/install/"));
  assert.deepEqual(order, ["z-first", "a-second:first", "m-third:second"], "declaration order, async awaited");
  assert.equal(result.value.title, "second");
  assert.deepEqual(result.diagnostics, []);
});

test("a plugin named like an earlier one is dropped and reported", async () => {
  const root = siteRoot(
    codeFile(
      `const first: Plugin = { name: "same", content: (p) => p };\nconst second: Plugin = { name: "same" };\nconst good: Plugin = { name: "good" };\n`,
      "first, second, good",
    ),
  );
  try {
    const loaded = await loadCodeConfig(root);
    assert.deepEqual(
      loaded.plugins.map((plugin) => plugin.name),
      ["same", "good"],
      "the first name is kept and the sound plugin after the duplicate still runs",
    );
    assert.equal(loaded.diagnostics.length, 1);
    const [diagnostic] = loaded.diagnostics;
    assert.equal(diagnostic?.id, "plugin.duplicate-name");
    assert.equal(diagnostic?.severity, "error");
    assert.ok(diagnostic?.message.includes("Plugin 2"), diagnostic?.message);
    assert.ok(diagnostic?.message.includes(`"same"`), diagnostic?.message);
    assert.deepEqual(diagnostic?.pos, { file: CODE_CONFIG_FILE, line: 1, column: 1, endLine: 1, endColumn: 1 });
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("a sync hook error names the plugin and stage at the page source, and later plugins run", async () => {
  const plugins: Plugin[] = [
    { name: "good", content: (value) => ({ ...value, title: "kept" }) },
    {
      name: "broken",
      content: () => {
        throw new Error("boom");
      },
    },
    { name: "after", content: (value) => ({ ...value, lang: "fa" }) },
  ];
  const input = page("/install/");

  const result = await runContentHooks(plugins, input);
  assert.equal(result.diagnostics.length, 1);
  const [diagnostic] = result.diagnostics;
  assert.equal(diagnostic?.id, "plugin.hook-failed");
  assert.ok(diagnostic?.message.includes(`"broken"`), diagnostic?.message);
  assert.ok(diagnostic?.message.includes("content hook"), diagnostic?.message);
  assert.ok(diagnostic?.message.includes("boom"), diagnostic?.message);
  assert.deepEqual(diagnostic?.pos, installPos, "the error points at the page that caused it");
  assert.equal(result.value.title, "kept", "the value from the failed plugin's predecessor is kept");
  assert.equal(result.value.lang, "fa", "the plugin after the failed one still runs");
  assert.deepEqual(input, page("/install/"), "the page handed in is not changed");
});

test("an async hook rejection names the plugin and stage at the page source", async () => {
  const plugins: Plugin[] = [
    {
      name: "rejecter",
      content: async () => {
        throw new Error("no description");
      },
    },
  ];

  const result = await runContentHooks(plugins, page("/install/"));
  assert.equal(result.diagnostics.length, 1);
  const [diagnostic] = result.diagnostics;
  assert.equal(diagnostic?.id, "plugin.hook-failed");
  assert.ok(diagnostic?.message.includes(`"rejecter"`), diagnostic?.message);
  assert.ok(diagnostic?.message.includes("content hook"), diagnostic?.message);
  assert.ok(diagnostic?.message.includes("no description"), diagnostic?.message);
  assert.deepEqual(diagnostic?.pos, installPos);
  assert.equal(result.value.title, "/install/");
});

test("a hook that mutates its input and fails does not change the value the next plugin gets", async () => {
  const shared = { notes: ["original"] };
  const input = page("/install/");
  (input.frontMatter as Record<string, unknown>).shared = shared;
  const plugins: Plugin[] = [
    {
      name: "mutator",
      content: (value) => {
        (value.frontMatter as Record<string, unknown>).title = "mutated";
        (value.headings as Heading[]).push({ depth: 1, id: "mutated", text: "Mutated", pos: installPos });
        ((value.frontMatter as Record<string, { notes: string[] }>).shared!).notes.push("mutated");
        throw new Error("boom");
      },
    },
    {
      name: "observer",
      content: (value) => {
        assert.equal(value.frontMatter.title, undefined, "a mutation before a failure does not reach the next plugin");
        assert.deepEqual(value.frontMatter.shared, { notes: ["original"] }, "leaves of the value are copied too");
        assert.deepEqual(value.headings, [], "the page the next plugin gets is the value before the failed hook");
        return value;
      },
    },
  ];

  const result = await runContentHooks(plugins, input);
  assert.equal(result.diagnostics.length, 1);
  assert.ok(result.diagnostics[0]?.message.includes("mutator"), result.diagnostics[0]?.message ?? "");
  assert.equal(result.value.frontMatter.title, undefined, "the stage keeps the value before the failed plugin");
  assert.deepEqual(result.value.headings, []);
  assert.deepEqual(shared, { notes: ["original"] }, "the page handed in is not changed");
});

test("a model hook failure still points at the code file, not at a page", async () => {
  const plugins: Plugin[] = [
    {
      name: "broken",
      model: () => {
        throw new Error("boom");
      },
    },
  ];

  const result = await runModelHooks(plugins, site([page("/install/")]));
  assert.equal(result.diagnostics.length, 1);
  assert.deepEqual(result.diagnostics[0]?.pos, { file: CODE_CONFIG_FILE, line: 1, column: 1, endLine: 1, endColumn: 1 });
  assert.ok(result.diagnostics[0]?.message.includes("model hook"), result.diagnostics[0]?.message);
});
