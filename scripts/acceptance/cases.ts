/**
 * The public acceptance cases a release must pass. Each case writes a small project in a fresh temporary folder and
 * runs the installed `mizzen` binary, so it exercises the same CLI, configuration, and outputs a user gets from the
 * published tarball. The file imports only `node:` builtins: it must run from a checkout while the binary under test
 * comes from npm.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

/** Runs one CLI command and returns its exit status and output. */
export interface RunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** What a case may use: its own temporary folder and the CLI under test. */
export interface CaseContext {
  readonly dir: string;
  readonly mizzen: (args: readonly string[], cwd?: string) => RunResult;
}

/** One stable acceptance case. The id is written in the release scope and never renamed. */
export interface AcceptanceCase {
  readonly id: string;
  readonly title: string;
  readonly run: (ctx: CaseContext) => void;
}

/** Writes `files` under `root`, creating parent folders. */
function tree(root: string, files: Readonly<Record<string, string>>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

/** Fails the case with a readable message unless `condition` holds. */
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Fails unless the command succeeded, quoting what it printed. */
function ok(result: RunResult, what: string): void {
  check(result.status === 0, `${what} exited ${result.status}\n${result.stdout}${result.stderr}`);
}

/** Reads a built file as UTF-8, failing the case when it is missing. */
function read(root: string, path: string): string {
  check(existsSync(join(root, path)), `${path} was not written`);
  return readFileSync(join(root, path), "utf8");
}

/** A minimal theme; each case adds the layouts its pages need. */
function theme(root: string, layouts: Readonly<Record<string, string>> = {}): string {
  const dir = join(root, "theme");
  tree(dir, {
    "src/index.ts": 'export const theme = { name: "acceptance", folders: ["layouts"] };\n',
    ...Object.fromEntries(
      Object.entries({
        doc: 'export default (p: any) => `<html><body>${p.page.html}</body></html>`;\n',
        ...layouts,
      }).map(([name, body]) => [`layouts/${name}.ts`, body]),
    ),
  });
  return dir;
}

/** Builds `site` with the case's theme and returns the output folder. */
let nextOut = 0;
function build(ctx: CaseContext, site: string, themeRoot: string, extra: readonly string[] = []): string {
  const out = join(ctx.dir, `out-${++nextOut}`);
  ok(ctx.mizzen(["build", site, "--out", out, "--theme", themeRoot, ...extra], ctx.dir), `build ${site}`);
  return out;
}

/** Every file under `root`, relative and sorted. */
function filesUnder(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else found.push(relative(root, path));
    }
  };
  walk(root);
  return found.sort();
}

const POST = (title: string, author: string, extra = ""): string =>
  `---\ntitle: ${title}\ndate: 2026-01-12\nauthor: ${author}${extra}\n---\n\n${title} body.\n`;

const blog: AcceptanceCase = {
  id: "blog",
  title: "Blog routes and Atom output exclude drafts",
  run: (ctx) => {
    const site = join(ctx.dir, "blog-site");
    const list = 'export default (p: any) => `<html><body><ul>${(p.page.frontMatter.blog?.posts ?? []).map((post: any) => `<li>${post.slug}</li>`).join("")}</ul></body></html>`;\n';
    const themeRoot = theme(site, { post: 'export default (p: any) => `<html><body>${p.page.html}</body></html>`;\n', list });
    tree(site, {
      "mizzen.yml": "title: Blog\nurl: https://example.org\nblog:\n  posts: posts\n",
      "_data/authors.yml": "armin:\n  name: Armin\n",
      "posts/alpha.md": POST("Alpha", "armin"),
      "posts/beta.md": POST("Beta", "armin"),
      "posts/draft.md": POST("Draft", "armin", "\ndraft: true"),
    });
    const out = build(ctx, site, themeRoot);
    check(existsSync(join(out, "blog/alpha/index.html")), "the alpha post was not written");
    check(existsSync(join(out, "blog/beta/index.html")), "the beta post was not written");
    check(!existsSync(join(out, "blog/draft/index.html")), "a draft got a public page");
    const feed = read(out, "blog/feed.xml");
    check(feed.includes("https://example.org/blog/alpha/"), "the feed lacks the alpha entry");
    check(!feed.includes("Draft"), "the feed includes a draft");
    const archive = read(out, "blog/archive/index.html");
    check(archive.includes("alpha") && archive.includes("beta") && !archive.includes("draft"), "the archive is wrong");
  },
};

const apiReference: AcceptanceCase = {
  id: "api-reference",
  title: "Generated OpenAPI routes and navigation",
  run: (ctx) => {
    const site = join(ctx.dir, "api-site");
    const themeRoot = theme(site, {
      "api-reference": 'export default (p: any) => `<html><body><h1>${p.page.title}</h1><p>${p.page.frontMatter.apiReference.operation.method} ${p.page.frontMatter.apiReference.operation.path}</p></body></html>`;\n',
      "api-reference-index": 'export default (p: any) => `<html><body><h1>${p.page.frontMatter.apiReference.title}</h1><p>${p.page.frontMatter.apiReference.version}</p><pre>${JSON.stringify(p.site.nav.docs)}</pre></body></html>`;\n',
    });
    tree(site, {
      "mizzen.yml": "title: API\nurl: https://example.org\napiReference:\n  source: api/openapi.yaml\n",
      "api/openapi.yaml": `openapi: 3.1.0
info:
  title: Pet API
  version: 1.2.0
paths:
  /pets:
    get:
      operationId: listPets
      summary: List pets
      tags: [pets]
      responses:
        "200":
          description: OK
`,
    });
    const out = build(ctx, site, themeRoot);
    check(read(out, "reference/index.html").includes("/reference/listPets/"), "the reference index lacks the operation");
    const operation = read(out, "reference/listPets/index.html");
    check(operation.includes("List pets") && operation.includes("get /pets"), "the operation page is wrong");
    check(read(out, "reference/listPets/index.md").includes("GET /pets"), "the operation twin is wrong");
    check(read(out, "sitemap.xml").includes("https://example.org/reference/listPets/"), "the sitemap lacks the operation");
    check(read(out, "reference/index.html").includes("reference/listPets"), "the navigation lacks the operation");
  },
};

const annotations: AcceptanceCase = {
  id: "annotations",
  title: "Line annotation data and diagnostics",
  run: (ctx) => {
    const site = join(ctx.dir, "annotation-site");
    const themeRoot = theme(site);
    tree(site, {
      "mizzen.yml": "title: Annotations\n",
      "guide/page.md": "---\ntitle: Annotations\n---\n\n```ts annotations={1: reads the token once | 3: logs it}\nconst token = read();\nconst client = connect(token);\nlog(token);\n```\n",
    });
    const out = build(ctx, site, themeRoot);
    const html = read(out, "guide/page/index.html");
    const raw = /data-code="([^"]*)"/.exec(html)?.[1] ?? "";
    const meta = JSON.parse(raw.replace(/&#x22;|&quot;/g, '"').replace(/&#x26;|&amp;/g, "&")) as {
      annotations?: { from: number; text: string }[];
    };
    check((meta.annotations ?? []).some((entry) => entry.from === 1 && entry.text === "reads the token once"), "the data-code attribute lacks the annotation");

    // A bad annotation is a diagnostic through the public check command, with the fence's line.
    const invalid = join(ctx.dir, "invalid-site");
    tree(invalid, {
      "mizzen.yml": "title: Invalid\n",
      "guide/page.md": "---\ntitle: Invalid\n---\n\n```ts annotations={9: past the end}\none\n```\n",
    });
    const result = ctx.mizzen(["check", invalid, "--theme", theme(invalid), "--format", "json"], ctx.dir);
    const report = JSON.parse(result.stdout) as { diagnostics: { id: string; pos?: { file?: string } }[] };
    const found = report.diagnostics.find((diagnostic) => diagnostic.id === "code.annotation-range");
    check(found !== undefined, "the out-of-range annotation was not reported");
    check(found.pos?.file === "guide/page.md", "the annotation finding names another file");
  },
};

const versions: AcceptanceCase = {
  id: "versions",
  title: "Selected docs version at the canonical URL",
  run: (ctx) => {
    const site = join(ctx.dir, "versions-site");
    const themeRoot = theme(site, {
      doc: 'export default (p: any) => { const canonical = p.page.frontMatter.canonical_url ?? p.page.url; return `<html><head><link rel="canonical" href="https://example.org${canonical}"></head><body>${p.page.html}</body></html>`; };\n',
    });
    tree(site, {
      "mizzen.yml": "title: Versions\nurl: https://example.org\ndefaults:\n  - path: \"\"\n    values:\n      layout: doc\n",
      "_data/versions.yml": "default: v2\nold: [v1]\n",
      "guide/install.md": "---\ntitle: Install\n---\n\nCurrent install.\n",
      "v1/guide/install.md": "---\ntitle: Install v1\n---\n\nVersion 1 install.\n",
      "v2/guide/install.md": "---\ntitle: Install v2\n---\n\nVersion 2 install.\n",
    });
    const out = build(ctx, site, themeRoot);
    const canonical = read(out, "guide/install/index.html");
    check(canonical.includes("Version 2 install."), "the canonical URL does not show the default version");
    check(canonical.includes('rel="canonical" href="https://example.org/guide/install/"'), "the canonical link is wrong");
    check(read(out, "v1/guide/install/index.html").includes("Version 1 install."), "the old version is unreachable");
    check(read(out, "v2/guide/install/index.html").includes('rel="canonical" href="https://example.org/guide/install/"'), "the versioned copy is not an alias");
    const listed = JSON.parse(read(out, "versions.json")) as { byUrl: Record<string, string> };
    check(listed.byUrl["/v1/guide/install/"] === "guide/install.md", "versions.json lost v1");
    check(listed.byUrl["/v2/guide/install/"] === "guide/install.md", "versions.json lost v2");
  },
};

const imports: AcceptanceCase = {
  id: "imports",
  title: "All four site importers through the CLI",
  run: (ctx) => {
    const sources: Record<string, Readonly<Record<string, string>>> = {
      docusaurus: {
        "docusaurus.config.js": 'module.exports = { presets: [["classic", { docs: { path: "docs", routeBasePath: "docs" } }]] };\n',
        "docs/intro.md": "---\ntitle: Intro\n---\n\n# Intro\n",
      },
      mkdocs: {
        "mkdocs.yml": "site_name: Example\ndocs_dir: content\n",
        "content/index.md": "# Home\n",
      },
      starlight: {
        "astro.config.mjs": 'import starlight from "@astrojs/starlight";\nexport default { integrations: [starlight({ title: "Example" })], srcDir: "./src" };\n',
        "src/content/docs/index.md": "---\ntitle: Home\n---\n\n# Home\n",
      },
      vitepress: {
        ".vitepress/config.mjs": 'export default { srcDir: "docs", title: "Example" };\n',
        "docs/index.md": "# Home\n",
      },
    };
    for (const [name, files] of Object.entries(sources)) {
      const source = join(ctx.dir, `${name}-source`);
      tree(source, files);
      const out = join(ctx.dir, `${name}-out`);
      const result = ctx.mizzen(["import", name, source, "--out", out], ctx.dir);
      ok(result, `import ${name}`);
      check(existsSync(join(out, "mizzen.yml")), `${name} wrote no mizzen.yml`);
      const markdown = filesUnder(out).filter((path) => path.endsWith(".md"));
      check(markdown.length > 0, `${name} wrote no page`);
      check(markdown.some((path) => read(out, path).includes("Home") || read(out, path).includes("Intro")), `${name} lost the page text`);
    }
  },
};

const diff: AcceptanceCase = {
  id: "diff",
  title: "Semantic change review by stable block id",
  run: (ctx) => {
    const themeRoot = theme(ctx.dir);
    const make = (name: string, body: string): string => {
      const site = join(ctx.dir, name);
      tree(site, {
        "mizzen.yml": "title: Diff\n",
        "index.md": `# Home {#home}\n\n<!-- {#p} -->\n${body}\n`,
      });
      return build(ctx, site, themeRoot, ["--update-blocks"]);
    };
    const before = make("diff-before", "alpha");
    const after = make("diff-after", "beta");
    const result = ctx.mizzen(["diff", before, after, "--format", "json"], ctx.dir);
    ok(result, "diff");
    const report = JSON.parse(result.stdout) as { schemaVersion?: number; pages?: { changed?: { blocks?: { kind: string; id?: string }[] }[] } };
    check(report.schemaVersion === 1, "the diff report has no version 1 schema");
    const blocks = (report.pages?.changed ?? []).flatMap((page) => page.blocks ?? []);
    check(blocks.some((block) => block.kind === "edited" || block.kind === "moved-edited"), "the paragraph edit was not reported");
    check(blocks.some((block) => block.id === "p"), "the change lost its stable block id");
  },
};

const blocks: AcceptanceCase = {
  id: "blocks",
  title: "Stable block ids in the lock, HTML, and twin",
  run: (ctx) => {
    const site = join(ctx.dir, "blocks-site");
    const themeRoot = theme(site);
    tree(site, {
      "mizzen.yml": "title: Blocks\n",
      "guide/page.md": "---\ntitle: Blocks\n---\n\n# Intro {#intro}\n\nA paragraph.\n",
    });
    const out = build(ctx, site, themeRoot, ["--update-blocks"]);
    const lock = JSON.parse(read(site, "blocks.lock.json")) as { blocks: Record<string, { file: string }> };
    check(lock.blocks.intro?.file === "guide/page.md", "the lock lost the declared block id");
    check(read(out, "guide/page/index.html").includes('data-block="intro"'), "the HTML lost the block id");
  },
};

const references: AcceptanceCase = {
  id: "references",
  title: "Stored references resolve after a build",
  run: (ctx) => {
    const site = join(ctx.dir, "references-site");
    const themeRoot = theme(site);
    tree(site, {
      "mizzen.yml": "title: References\n",
      "guide/install.md": "---\ntitle: Install\n---\n\n# Install {#install}\n\n## Steps {#steps}\n\nInstall it.\n",
    });
    build(ctx, site, themeRoot, ["--update-blocks"]);
    const file = join(ctx.dir, "references.json");
    writeFileSync(file, `${JSON.stringify([{ version: 1, page: "guide/install.md", block: "steps" }])}\n`);
    const result = ctx.mizzen(["references", "check", file, site], ctx.dir);
    ok(result, "references check");
    const resolutions = JSON.parse(result.stdout) as { status: string; url?: string }[];
    check(resolutions[0]?.status === "resolved", "the reference did not resolve");
    check(resolutions[0]?.url === "/guide/install/", "the reference resolved to another URL");
  },
};

const performance: AcceptanceCase = {
  id: "performance",
  title: "Identical output with one and four workers",
  run: (ctx) => {
    const make = (name: string): { site: string; themeRoot: string } => {
      const site = join(ctx.dir, name);
      const themeRoot = theme(site);
      tree(site, {
        "mizzen.yml": "title: Workers\n",
        "index.md": "# Home\n\nOne.\n",
        "guide/install.md": "# Install\n\nTwo.\n",
        "guide/deploy.md": "# Deploy\n\nThree.\n",
      });
      return { site, themeRoot };
    };
    const one = make("one-worker");
    const four = make("four-workers");
    const outOne = build(ctx, one.site, one.themeRoot, ["--workers", "1"]);
    const outFour = build(ctx, four.site, four.themeRoot, ["--workers", "4"]);
    const left = filesUnder(outOne);
    const right = filesUnder(outFour);
    check(left.join("\n") === right.join("\n"), "the two builds wrote different files");
    for (const path of left) {
      check(readFileSync(join(outOne, path)).equals(readFileSync(join(outFour, path))), `${path} differs between worker counts`);
    }
  },
};

const schema: AcceptanceCase = {
  id: "schema",
  title: "Collection schema evolution and migration preview",
  run: (ctx) => {
    const site = join(ctx.dir, "schema-site");
    tree(site, {
      "mizzen.yml": "collections:\n  items:\n    source: _data/items.yml\n    schema: _data/items.schema.json\n    schemaRenames:\n      slug: legacy\n",
      "_data/items.schema.json": JSON.stringify({
        type: "object",
        required: ["title", "slug"],
        properties: { id: { type: "string" }, title: { type: "string" }, slug: { type: "string" } },
      }),
      "_data/items.yml": "- id: a\n  title: A\n  legacy: old-a\n",
    });
    const result = ctx.mizzen(["data", "migrate", "items", site], ctx.dir);
    ok(result, "data migrate");
    check(result.stdout.includes("1 renamed"), "the migration preview did not name the renamed field");
    check(result.stdout.includes('"slug":"old-a"'), "the migration preview did not show the migrated record");
  },
};

const quality: AcceptanceCase = {
  id: "quality",
  title: "Data quality rules through the public command",
  run: (ctx) => {
    const site = join(ctx.dir, "quality-site");
    tree(site, {
      "mizzen.yml": "title: Quality\ncollections:\n  items:\n    source: _data/items.yml\nquality:\n  rules:\n    - kind: completeness\n      collection: items\n      fields: [author]\n",
      "_data/items.yml": "- id: a\n  author: Ada\n- id: b\n",
    });
    const result = ctx.mizzen(["data", "quality", site, "--json"], ctx.dir);
    ok(result, "data quality");
    const report = JSON.parse(result.stdout) as { findings: { id: string; record: string; field: string }[] };
    const finding = report.findings.find((entry) => entry.record === "b" && entry.field === "author");
    check(finding !== undefined, "the missing field was not reported");
    check(finding.id.includes("completeness"), "the finding lost its rule");
  },
};

const lifecycle: AcceptanceCase = {
  id: "lifecycle",
  title: "Retired records redirect to their replacement",
  run: (ctx) => {
    const site = join(ctx.dir, "lifecycle-site");
    const themeRoot = theme(site, {
      record: 'export default (p: any) => `<html><body><h1>${p.record?.id}</h1>${p.page.html}</body></html>`;\n',
    });
    tree(site, {
      "mizzen.yml": "title: Lifecycle\ncollections:\n  items:\n    source: _data/items.yml\n    template: _templates/item.md\n    permalink: /items/{slug}/\n    lifecycle:\n      states: [current, retired]\n      retired: [retired]\n      replacement: replacedBy\n      url: redirect\n",
      "_data/items.yml": "- id: old\n  slug: before\n  state: retired\n  replacedBy: new\n- id: new\n  slug: after\n",
      "_templates/item.md": "---\ntitle: \"{id}\"\n---\n\n# :field[id]\n",
    });
    const out = build(ctx, site, themeRoot);
    check(read(out, "_redirects").includes("/items/before/ /items/after/ 301"), "the retired URL does not redirect");
    check(existsSync(join(out, "items/after/index.html")), "the replacement has no page");
  },
};

const preview: AcceptanceCase = {
  id: "preview",
  title: "Pull request preview with canonical policy and a baseline diff",
  run: (ctx) => {
    const site = join(ctx.dir, "preview-site");
    const themeRoot = theme(site, {
      doc: [
        'export default (p: any) => `<html><head>',
        '${p.head.links.map((link: any) => `<link rel="${link.rel}" href="${link.href}">`).join("")}',
        '${p.head.meta.map((meta: any) => `<meta ${meta.property ? "property" : "name"}="${meta.name}" content="${meta.content}">`).join("")}',
        '</head><body>${p.page.html}</body></html>`;',
        "",
      ].join(""),
    });
    tree(site, {
      "mizzen.yml": "title: Preview\n",
      "guide/page.md": "---\ntitle: Page\n---\n\nAlpha.\n",
    });
    const baseline = build(ctx, site, themeRoot);
    tree(site, { "guide/page.md": "---\ntitle: Page\n---\n\nBeta.\n" });
    const out = join(ctx.dir, "preview-out");
    ok(ctx.mizzen(["build", site, "--out", out, "--theme", themeRoot, "--base", "/preview/pr-1", "--preview-canonical", "https://preview.example.com", "--commit", "0123456789abcdef", "--baseline", baseline], ctx.dir), "preview build");
    const diff = JSON.parse(read(out, ".mizzen/preview-diff.json")) as { version: number; baseline: { hash: string }; diff: { identical: boolean } };
    check(diff.version === 1, "the preview diff lost its version");
    check(diff.diff.identical === false, "the preview diff missed the edit");
    const page = read(out, "guide/page/index.html");
    check(/<meta name="robots" content="noindex"/.test(page), "the preview page is not noindex");
    check(page.includes('rel="canonical" href="https://preview.example.com/preview/pr-1/guide/page/"'), "the preview canonical is wrong");
  },
};

const starters: AcceptanceCase = {
  id: "starters",
  title: "First project starters list and copy",
  run: (ctx) => {
    const themeRoot = join(ctx.dir, "starter-theme");
    tree(themeRoot, {
      "src/index.ts": 'export const theme = { name: "acceptance", folders: ["layouts"] };\n',
      "layouts/doc.ts": 'export default (p: any) => `<html><body>${p.page.html}</body></html>`;\n',
      "starters/catalog/starter.json": JSON.stringify({ title: "Catalog", description: "A small catalog." }),
      "starters/catalog/mizzen.yml": "title: Catalog\n",
      "starters/catalog/index.md": "# Catalog\n",
    });
    const listed = ctx.mizzen(["init", "--list", "--theme", themeRoot], ctx.dir);
    ok(listed, "init --list");
    check(listed.stdout.includes("Catalog") && listed.stdout.includes("A small catalog."), "the starter is not listed");
    const out = join(ctx.dir, "catalog-site");
    const copied = ctx.mizzen(["init", out, "--starter", "catalog", "--theme", themeRoot], ctx.dir);
    ok(copied, "init --starter");
    check(existsSync(join(out, "mizzen.yml")), "the starter wrote no mizzen.yml");
    check(!existsSync(join(out, "starter.json")), "the starter metadata was copied");
    const built = build(ctx, out, themeRoot);
    check(existsSync(join(built, "index.html")), "the copied starter does not build");
  },
};

const records: AcceptanceCase = {
  id: "records",
  title: "Record changes in the semantic diff",
  run: (ctx) => {
    const site = join(ctx.dir, "records-site");
    const themeRoot = theme(site, {
      list: 'export default (p: any) => `<html><body><ul>${(p.list?.records ?? []).map((record: any) => `<li>${record.title}</li>`).join("")}</ul></body></html>`;\n',
      record: 'export default (p: any) => `<html><body><h1>${p.record?.id}</h1>${p.page.html}</body></html>`;\n',
    });
    tree(site, {
      "mizzen.yml": "title: Records\ncollections:\n  posts:\n    source: _data/posts.yml\n    template: _templates/post.md\n    permalink: /posts/{id}/\n",
      "posts.md": "---\ntitle: Posts\nlayout: list\nlist:\n  collection: posts\n---\n\n# Posts\n",
      "_templates/post.md": "---\ntitle: \"{title}\"\n---\n\n# :field[title]\n",
      "_data/posts.yml": "- id: a\n  title: Alpha\n- id: b\n  title: Beta\n",
    });
    const before = build(ctx, site, themeRoot);
    tree(site, { "_data/posts.yml": "- id: a\n  title: Alpha edited\n- id: b\n  title: Beta\n- id: c\n  title: Gamma\n" });
    const after = build(ctx, site, themeRoot);
    const result = ctx.mizzen(["diff", before, after, "--format", "json"], ctx.dir);
    ok(result, "records diff");
    const report = JSON.parse(result.stdout) as {
      summary: { records: { added: number; changed: number } };
      records: { collection: string; added: { id: string }[]; changed: { id: string; fields?: string[] }[] }[];
    };
    check(report.summary.records.changed === 1 && report.summary.records.added === 1, "the record counts are wrong");
    const collection = report.records.find((entry) => entry.collection === "posts");
    check(collection?.changed.some((record) => record.id === "a"), "the edited record is missing");
    check(collection?.added.some((record) => record.id === "c"), "the added record is missing");
    const markdown = ctx.mizzen(["diff", before, after, "--format", "markdown"], ctx.dir);
    ok(markdown, "records diff markdown");
    check(markdown.stdout.includes("posts") && markdown.stdout.includes("Alpha edited"), "the Markdown report lost the record change");
  },
};

/** Every required case, in the order a release runs them. */
export const CASES: readonly AcceptanceCase[] = [
  blog,
  apiReference,
  annotations,
  versions,
  imports,
  diff,
  records,
  schema,
  quality,
  lifecycle,
  preview,
  starters,
  blocks,
  references,
  performance,
];
