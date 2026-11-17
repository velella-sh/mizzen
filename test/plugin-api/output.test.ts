import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  Output,
  OutputContext,
  OutputFile,
  Page,
  Site,
  SiteConfig,
  SourcePos,
} from "../../src/contracts/index.ts";
import { runDeclaredOutputs, type DeclaredOutput } from "../../src/plugins/output-extension.ts";

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

function page(url: string): Page {
  return {
    url,
    source: installPos,
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

function site(): Site {
  return { config: config(), pages: [page("/install/")], nav: { lists: [] }, collections: {}, data: {} };
}

function context(): OutputContext {
  return { renderPage: async () => "<!doctype html>", report: () => undefined };
}

/** An output that writes `files`; its name is what the collision checks read. */
function output(name: string, files: readonly OutputFile[]): Output {
  return { name, run: async () => files };
}

test("a declared output writes its files from the fixed site model", async () => {
  const inventory: Output = {
    name: "inventory",
    async run(site) {
      return [{ path: "plugin-api/inventory.json", contents: `${site.pages.length}\n` }];
    },
  };
  const declared: DeclaredOutput[] = [{ plugin: "write-inventory", output: inventory }];

  const result = await runDeclaredOutputs(declared, site(), context(), ["sitemap"]);

  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.files, [{ path: "plugin-api/inventory.json", contents: "1\n" }]);
});

test("a path outside the output folder drops the whole output, with one error", async () => {
  const declared: DeclaredOutput[] = [
    {
      plugin: "write-inventory",
      output: output("inventory", [
        { path: "inventory.json", contents: "kept\n" },
        { path: "../escape.json", contents: "never\n" },
      ]),
    },
  ];

  const result = await runDeclaredOutputs(declared, site(), context(), []);

  assert.deepEqual(result.files, [], "no file of the output is published");
  assert.equal(result.diagnostics.length, 1);
  const [diagnostic] = result.diagnostics;
  assert.equal(diagnostic?.id, "output.bad-path");
  assert.equal(diagnostic?.severity, "error");
  assert.ok(diagnostic?.message.includes('"write-inventory"'), diagnostic?.message ?? "");
  assert.ok(diagnostic?.message.includes('"inventory"'), diagnostic?.message ?? "");
  assert.ok(diagnostic?.message.includes('"../escape.json"'), diagnostic?.message ?? "");
});

test("a name collision skips only the colliding declaration", async () => {
  const declared: DeclaredOutput[] = [
    { plugin: "first", output: output("inventory", [{ path: "first.txt", contents: "first\n" }]) },
    { plugin: "second", output: output("inventory", [{ path: "second.txt", contents: "second\n" }]) },
    { plugin: "built-in", output: output("sitemap", [{ path: "sitemap.xml", contents: "no\n" }]) },
  ];

  const result = await runDeclaredOutputs(declared, site(), context(), ["sitemap"]);

  assert.deepEqual(result.files, [{ path: "first.txt", contents: "first\n" }]);
  assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.id), [
    "output.duplicate-name",
    "output.duplicate-name",
  ]);
  const [earlier, builtin] = result.diagnostics;
  assert.ok(earlier?.message.includes('Plugin "second"'), earlier?.message ?? "");
  assert.ok(earlier?.message.includes('"inventory"'), earlier?.message ?? "");
  assert.ok(earlier?.message.includes('plugin "first"'), earlier?.message ?? "");
  assert.ok(builtin?.message.includes('Plugin "built-in"'), builtin?.message ?? "");
  assert.ok(builtin?.message.includes("the build"), builtin?.message ?? "");
});
