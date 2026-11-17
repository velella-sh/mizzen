import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import { loadConfig } from "../src/config/load.ts";
import type { Page, Site, SiteConfig } from "../src/contracts/index.ts";
import type { OutputContext, OutputFile } from "../src/contracts/output.ts";
import { buildModel } from "../src/model/build.ts";
import { buildHashOf, MANIFEST_PATH, recordBuildHash } from "../src/outputs/build-hash.ts";
import { manifest } from "../src/outputs/manifest.ts";
import { renderSettingsKey } from "../src/pipeline/cache.ts";
import { renderPageKey } from "../src/pipeline/render-cache.ts";

const THEME = fileURLToPath(new URL("../../lateen", import.meta.url));

type Schema = {
  properties?: Record<string, Schema>;
  $defs?: Record<string, Schema>;
  [key: string]: unknown;
};

const schema = JSON.parse(readFileSync(new URL("../schema/manifest.schema.json", import.meta.url), "utf8")) as Schema;

// ajv is CommonJS: its default export is the class at run time, but its types name it.
const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;
const ajv = new Ajv2020({ strict: true, allErrors: true });
const validate = ajv.compile(schema);

const pos = { file: "guide/install.md", line: 1, column: 1, endLine: 1, endColumn: 1 };

/** A site config with the defaults a build fills in, plus the given overrides. */
function config(overrides: Partial<SiteConfig> = {}): SiteConfig {
  return {
    title: "Example",
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
    ...overrides,
  };
}

function page(url: string, frontMatter: Page["frontMatter"] = {}): Page {
  return {
    url,
    source: pos,
    frontMatter,
    title: url,
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "",
    markdown: "",
    kind: "doc",
  };
}

function site(pages: readonly Page[], overrides: Partial<SiteConfig> = {}): Site {
  return { config: config(overrides), pages, nav: {}, collections: {}, data: {} };
}

/** The manifest reads only the model, so rendering a page here would be a bug. */
const ctx: OutputContext = {
  renderPage: () => Promise.reject(new Error("the manifest never renders a page")),
  report: () => {},
};

async function run(model: Site): Promise<OutputFile> {
  const files = await manifest.run(model, ctx);
  assert.equal(files.length, 1, "the manifest writes one file");
  return files[0]!;
}

/** A temporary folder holding `files`, whose parent the caller removes. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "dates-cache-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

interface Manifest {
  readonly version: number;
  readonly pages: readonly unknown[];
  readonly asOf?: string;
  readonly build?: { readonly hash: string; readonly files: Readonly<Record<string, string>> };
}

function manifestOf(root: string): Manifest {
  return JSON.parse(readFileSync(join(root, MANIFEST_PATH), "utf8")) as Manifest;
}

test("a page that reads the as-of date records it in the manifest, which still validates", async () => {
  const model = site([{ ...page("/daily/"), dates: true }], { asOf: "2026-06-01" });
  const built = JSON.parse(String((await run(model)).contents)) as Manifest;

  assert.equal(built.asOf, "2026-06-01");
  assert.equal(validate(built), true, ajv.errorsText(validate.errors));
});

test("a site without a date-dependent page leaves asOf out of the manifest", async () => {
  const built = JSON.parse(String((await run(site([page("/a/")], { asOf: "2026-06-01" }))).contents)) as Manifest;

  assert.equal("asOf" in built, false);
  assert.equal(validate(built), true, ajv.errorsText(validate.errors));
});

test("buildHashOf folds the as-of date in only when it is given", () => {
  const files = { "a/index.html": "a".repeat(64), "index.html": "b".repeat(64) };

  const first = buildHashOf(files, "2026-06-01");
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.notEqual(buildHashOf(files, "2026-06-02"), first, "a new day is a new hash");
  assert.equal(buildHashOf(files, "2026-06-01"), first, "the same day is the same hash");

  const noDate = buildHashOf(files);
  assert.match(noDate, /^[0-9a-f]{64}$/);
  assert.equal(buildHashOf(files), noDate, "no date is stable");
  assert.notEqual(noDate, first, "a dated build differs from an undated one");
});

test("recordBuildHash follows the date, and the manifest never moves its own hash", async () => {
  const root = tree({
    [MANIFEST_PATH]: `${JSON.stringify({ version: 1, pages: [] })}\n`,
    "index.html": "home\n",
  });
  try {
    const undated = await recordBuildHash(root);
    assert.match(undated ?? "", /^[0-9a-f]{64}$/);
    assert.equal(manifestOf(root).build?.hash, undated, "the record lands in the manifest");
    assert.deepEqual(Object.keys(manifestOf(root).build?.files ?? {}), ["index.html"], "the manifest is left out");

    const dated = await recordBuildHash(root, "2026-06-01");
    assert.notEqual(dated, undated, "a new as-of date changes the build hash");
    assert.equal(manifestOf(root).build?.hash, dated);

    assert.equal(await recordBuildHash(root), undated, "omitting the date restores the earlier hash");

    // The manifest's own bytes are not part of the identity: a different `build` field does not move the hash.
    const changed = manifestOf(root);
    assert.ok(changed.build);
    writeFileSync(
      join(root, MANIFEST_PATH),
      `${JSON.stringify({ ...changed, build: { hash: "f".repeat(64), files: {} } }, null, 2)}\n`,
    );
    assert.equal(await recordBuildHash(root), undated);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("renderSettingsKey ignores a moving asOf, even though the config file has none", async () => {
  const root = tree({
    "mizzen.yml": "title: Dates\n",
    "index.md": "---\ntitle: Home\n---\n\n# Home\n",
    "_data/navigation.yml": "main:\n  - title: Home\n    url: /\n",
  });
  const outputsDir = mkdtempSync(join(tmpdir(), "dates-outputs-"));
  try {
    const loaded = loadConfig(root);
    assert.equal(loaded.config.asOf, undefined, "the config file has no asOf");
    const options = {
      root,
      sourceDir: root,
      themeRoot: THEME,
      outputsDir,
    };

    const first = await renderSettingsKey({ ...options, config: { ...loaded.config, asOf: "2026-06-01" } });
    const second = await renderSettingsKey({ ...options, config: { ...loaded.config, asOf: "2026-06-02" } });

    assert.match(first, /^[0-9a-f]{64}$/);
    assert.equal(second, first, "the as-of date is per page, not part of the shared settings");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outputsDir, { recursive: true, force: true });
  }
});

test("renderPageKey includes the as-of date only when one is passed", async () => {
  const root = tree({
    "mizzen.yml": "title: Dates\n",
    "index.md": "---\ntitle: Home\n---\n\n# Home\n",
    "_data/navigation.yml": "main:\n  - title: Home\n    url: /\n",
  });
  try {
    const { site: model } = await buildModel(root);
    const first = model.pages.find((entry) => entry.kind === "doc");
    assert.ok(first, "the site has a page");
    const settings = "a".repeat(64);

    const june = renderPageKey(settings, first, "doc", "", "", "2026-06-01");
    assert.notEqual(renderPageKey(settings, first, "doc", "", "", "2026-06-02"), june, "a new day retires the page");
    assert.equal(renderPageKey(settings, first, "doc", "", "", "2026-06-01"), june, "the same day reuses the page");
    assert.notEqual(renderPageKey(settings, first, "doc", "", ""), june, "a page that reads no date keys without one");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
