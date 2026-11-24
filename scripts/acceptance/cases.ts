/**
 * The public acceptance cases a release must pass. Each case writes a small project in a fresh temporary folder and
 * runs the installed `mizzen` binary, so it exercises the same CLI, configuration, and outputs a user gets from the
 * published tarball. The file imports only `node:` builtins: it must run from a checkout while the binary under test
 * comes from npm.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** Runs one CLI command and returns its exit status and output. */
export interface RunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** What a case may use: its own temporary folder and the CLI under test. */
export interface CaseContext {
  readonly dir: string;
  readonly mizzen: (args: readonly string[], cwd?: string, input?: string) => RunResult;
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

/** Runs a command that must succeed and returns its stdout. */
function output(result: RunResult, what: string): string {
  ok(result, what);
  return result.stdout;
}

/** Reads a built file as UTF-8, failing the case when it is missing. */
function read(root: string, path: string): string {
  check(existsSync(join(root, path)), `${path} was not written`);
  return readFileSync(join(root, path), "utf8");
}

const PAGE = 'export default (p: any) => `<html><body>${p.page.html}</body></html>`;\n';

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

/** A loopback server for the network cases; the script writes its random origin to a file. */
let nextServer = 0;
function serve(ctx: CaseContext, script: string): { url: string; stop: () => void } {
  const dir = join(ctx.dir, `server-${++nextServer}`);
  const portFile = join(dir, "origin");
  tree(dir, { "server.mjs": script });
  const child = spawn(process.execPath, [join(dir, "server.mjs"), portFile], { stdio: "ignore" });
  const wait = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 200 && !existsSync(portFile); attempt++) Atomics.wait(wait, 0, 0, 25);
  check(existsSync(portFile), "the case server did not start");
  return { url: readFileSync(portFile, "utf8").trim(), stop: () => child.kill("SIGKILL") };
}

/** A JSON server that answers `pages[page]` at `path` with `{ data: { items: […] } }`. */
function pageService(pages: Readonly<Record<string, readonly unknown[]>>): string {
  return `
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
const pages = ${JSON.stringify(pages)};
const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/items") {
    const page = url.searchParams.get("page") ?? "1";
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: { items: pages[page] ?? [] } }));
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "not found" }));
});
server.listen(0, "127.0.0.1", () => writeFileSync(process.argv[2], \`http://127.0.0.1:\${server.address().port}\`));
`;
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

const apiFetch: AcceptanceCase = {
  id: "api-fetch",
  title: "Paginated API fetch, lock, and offline build",
  run: (ctx) => {
    const site = join(ctx.dir, "api-fetch-site");
    const themeRoot = theme(site, { record: PAGE });
    const service = serve(ctx, pageService({
      "1": [{ id: "a", name: "Alpha" }, { id: "b", name: "Beta" }],
      "2": [{ id: "c", name: "Gamma" }],
    }));
    try {
      tree(site, {
        "mizzen.yml": `title: API
collections:
  items:
    source: ${service.url}/items
    records: data.items
    id: id
    template: _templates/item.md
    permalink: /items/{id}/
    pagination:
      mode: page
      param: page
      start: 1
      pageSize: 2
      stop: short
`,
        "_templates/item.md": "---\ntitle: \"{name}\"\n---\n\n# :field[name]\n",
      });
      ok(ctx.mizzen(["data", "fetch", site], ctx.dir), "data fetch");
      const lock = read(site, "mizzen.lock.json");
      check(lock.includes("items"), "the lock has no API source");
      const out = build(ctx, site, themeRoot);
      for (const id of ["a", "b", "c"]) {
        check(existsSync(join(out, `items/${id}/index.html`)), `the API record ${id} was not built`);
      }
      ok(ctx.mizzen(["data", "fetch", site], ctx.dir), "second data fetch");
      check(read(site, "mizzen.lock.json") === lock, "a second fetch changed the lock");
      ok(ctx.mizzen(["data", "fetch", site, "--check"], ctx.dir), "data fetch --check");
    } finally {
      service.stop();
    }
  },
};

const dbInput: AcceptanceCase = {
  id: "db-input",
  title: "SQLite and NDJSON extraction with a stale-lock failure",
  run: (ctx) => {
    const site = join(ctx.dir, "db-site");
    const themeRoot = theme(site, { record: PAGE });
    tree(site, {
      "mizzen.yml": `title: DB
collections:
  products:
    source: _data/products.ndjson
    id: sku
    template: _templates/item.md
    permalink: /products/{sku}/
  parts:
    source: _data/parts.sqlite
    id: sku
    template: _templates/item.md
    permalink: /parts/{sku}/
    sqlite:
      query: SELECT sku, name FROM parts
`,
      "_templates/item.md": "---\ntitle: \"{name}\"\n---\n\n# :field[name]\n",
      "_data/products.ndjson": '{"sku":"widget","name":"Widget"}\n{"sku":"gadget","name":"Gadget"}\n',
    });
    const db = new DatabaseSync(join(site, "_data/parts.sqlite"));
    db.exec("CREATE TABLE parts (sku TEXT PRIMARY KEY, name TEXT NOT NULL)");
    db.exec("INSERT INTO parts (sku, name) VALUES ('bolt', 'Bolt'), ('nut', 'Nut')");
    db.close();

    ok(ctx.mizzen(["data", "extract", site], ctx.dir), "data extract");
    const out = build(ctx, site, themeRoot);
    check(read(out, "products/widget/index.html").includes("Widget"), "the NDJSON record was not built");
    check(read(out, "parts/bolt/index.html").includes("Bolt"), "the SQLite record was not built");

    const changed = new DatabaseSync(join(site, "_data/parts.sqlite"));
    changed.exec("INSERT INTO parts (sku, name) VALUES ('washer', 'Washer')");
    changed.close();
    const stale = ctx.mizzen(["data", "extract", site, "--check"], ctx.dir);
    check(stale.status !== 0, "a changed SQLite source passed the extraction check");
    check(`${stale.stdout}${stale.stderr}`.includes("changed parts"), "the changed extraction is not named");

    ok(ctx.mizzen(["data", "extract", site], ctx.dir), "data extract after the source changed");
    const rebuilt = build(ctx, site, themeRoot);
    check(existsSync(join(rebuilt, "parts/washer/index.html")), "the new SQLite row was not built");
  },
};

const collections: AcceptanceCase = {
  id: "collections",
  title: "Joined, aggregated, and public-only collection output",
  run: (ctx) => {
    const site = join(ctx.dir, "collections-site");
    const themeRoot = theme(site, { record: PAGE });
    tree(site, {
      "mizzen.yml": `title: Collections
collections:
  catalog:
    source: _data/catalog.yml
    id: sku
    template: _templates/catalog.md
    permalink: /catalog/{sku}/
    public: [sku, title, price, stock]
    join:
      type: left
      key: sku
      fields:
        sku: sku
        title: name
        price: price
        cost: cost
      sources:
        - collection: inventory
          fields:
            stock: stock
  inventory:
    source: _data/inventory.yml
    id: sku
  sales:
    source: _data/sales.yml
    dates: [date]
  monthly:
    source: sales
    aggregate:
      by:
        - { field: date, period: month, timezone: Europe/Berlin }
      metrics:
        orders: { op: count }
        revenue: { op: sum, field: amount, decimals: 2 }
    template: _templates/month.md
    permalink: /months/{id}/
`,
      "_data/catalog.yml": "- sku: a\n  name: Anvil\n  price: 10\n  cost: 4\n",
      "_data/inventory.yml": "- sku: a\n  stock: 3\n",
      "_data/sales.yml": "- id: s1\n  date: 2026-01-05T10:00:00Z\n  amount: 12.5\n- id: s2\n  date: 2026-01-20T10:00:00Z\n  amount: 7.5\n",
      "_templates/catalog.md": "---\ntitle: \"{title}\"\n---\n\n# :field[title]\n\nStock: :field[stock]\n",
      "_templates/month.md": "---\ntitle: \"{date}\"\n---\n\n# :field[date]\n\nOrders: :field[orders]\n\nRevenue: :field[revenue]\n",
    });
    const out = build(ctx, site, themeRoot);
    const record = JSON.parse(read(out, "catalog/a/index.json")) as { record?: { fields?: Record<string, unknown> } };
    check(record.record?.fields?.stock === 3, "the join did not supply the stock");
    check(record.record?.fields?.cost === undefined, "page JSON published a private field");
    check(!read(out, "catalog/a/index.html").includes(">4<"), "HTML published a private field");
    const month = JSON.parse(read(out, "months/2026-01/index.json")) as { record?: { fields?: Record<string, unknown> } };
    check(month.record?.fields?.orders === 2, "the aggregate lost a count");
    check(month.record?.fields?.revenue === 20, "the aggregate lost the sum");
  },
};

const transformLineage: AcceptanceCase = {
  id: "transform-lineage",
  title: "Transform preview, lineage, rule diff, and reproduce",
  run: (ctx) => {
    const site = join(ctx.dir, "transform-site");
    const themeRoot = theme(site, { record: PAGE });
    const config = (factor: number): string => `title: Transform
collections:
  catalog:
    source: _data/catalog.yml
    id: sku
    template: _templates/item.md
    permalink: /catalog/{sku}/
    transform:
      steps:
        - id: cents
          op: unit
          field: price
          factor: ${factor}
          round: 0
`;
    tree(site, {
      "mizzen.yml": config(100),
      "rules/proposed.yml": config(1000),
      "_data/catalog.yml": "- sku: a\n  name: Anvil\n  price: 10\n",
      "_templates/item.md": "---\ntitle: \"{name}\"\n---\n\n# :field[name]\n\nPrice: :field[price]\n",
    });
    ok(ctx.mizzen(["build", site, "--out", join(ctx.dir, "out-transform"), "--theme", themeRoot, "--diagnose"], ctx.dir), "diagnose build");
    ok(ctx.mizzen(["data", "transform", "catalog", site, "--json"], ctx.dir), "data transform");

    const explained = ctx.mizzen(["data", "explain", "catalog", "a", site, "--field", "price", "--json"], ctx.dir);
    ok(explained, "data explain");
    const lineage = JSON.parse(explained.stdout) as { format?: number; value?: number; chain?: { stage?: string }[] };
    check(lineage.format === 1, "the lineage report has no format 1");
    check(lineage.value === 1000, "the lineage value is not the transformed price");
    check((lineage.chain ?? []).some((event) => event.stage === "transform:cents"), "the lineage chain lost the transform rule");

    const diff = ctx.mizzen(
      ["data", "transform-diff", "mizzen.yml", "rules/proposed.yml", ".", "--collection", "catalog", "--format", "json", "--check"],
      site,
    );
    check(diff.status === 1, `transform-diff exited ${diff.status}`);
    const report = JSON.parse(diff.stdout) as {
      counts?: { changed?: number };
      records?: { fields?: { path?: string; before?: { value?: number }; after?: { value?: number } }[] }[];
    };
    check(report.counts?.changed === 1, "the rule diff missed the changed record");
    const field = report.records?.[0]?.fields?.[0];
    check(field?.path === "price" && field.before?.value === 1000 && field.after?.value === 10000, "the rule diff lost the price change");

    ok(
      ctx.mizzen(
        ["reproduce", join(site, ".mizzen/build-report.json"), site, "--out", join(ctx.dir, "out-reproduced"), "--theme", themeRoot],
        ctx.dir,
      ),
      "reproduce",
    );
  },
};

const refresh: AcceptanceCase = {
  id: "refresh",
  title: "Scheduled refresh report and build",
  run: (ctx) => {
    const site = join(ctx.dir, "refresh-site");
    const themeRoot = theme(site, { record: PAGE });
    const service = serve(ctx, pageService({ "1": [{ id: "a", name: "Alpha" }] }));
    try {
      tree(site, {
        "mizzen.yml": `title: Refresh
collections:
  items:
    source: ${service.url}/items
    records: data.items
    id: id
    template: _templates/item.md
    permalink: /items/{id}/
`,
        "_templates/item.md": "---\ntitle: \"{name}\"\n---\n\n# :field[name]\n",
      });
      const reportFile = join(ctx.dir, "refresh.json");
      ok(ctx.mizzen(["data", "refresh", site, "--collections", "items", "--report", reportFile], ctx.dir), "data refresh");
      const report = JSON.parse(readFileSync(reportFile, "utf8")) as {
        schema?: string;
        status?: string;
        changes?: { totals?: { added?: number } };
      };
      check(report.schema === "mizzen-refresh/1", "the refresh report has no schema");
      check(report.status === "changed" && report.changes?.totals?.added === 1, "the first refresh did not report the new record");

      ok(ctx.mizzen(["data", "refresh", site, "--collections", "items", "--report", reportFile], ctx.dir), "second data refresh");
      const again = JSON.parse(readFileSync(reportFile, "utf8")) as { status?: string };
      check(again.status === "unchanged", "the second refresh changed the lock");

      const out = build(ctx, site, themeRoot);
      check(existsSync(join(out, "items/a/index.html")), "the refreshed record was not built");
    } finally {
      service.stop();
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

const themeHooks: AcceptanceCase = {
  id: "theme-hooks",
  title: "Inline directives and theme overrides",
  run: (ctx) => {
    const site = join(ctx.dir, "theme-hooks-site");
    tree(join(site, "theme"), {
      "src/index.ts": 'export const theme = { name: "hooks", folders: ["layouts", "components"] };\n',
      "layouts/doc.ts": 'export default (p: any) => `<html><body class="theme">${p.page.html}</body></html>`;\n',
      "components/term/index.ts": 'export const directive = "term";\nexport default ({ props, html }: any) => `<a class="term" href="#${props.id}">${html}</a>`;\n',
    });
    tree(site, {
      "theme-own/doc.ts": 'export default (p: any) => `<html><body class="site"><main>${p.page.html}</main></body></html>`;\n',
      "theme-own/doc.css": ".site-shell { color: red; }\n",
      "index.md": "---\ntitle: Home\nlayout: doc\n---\n\nA :term[widget]{id=w1} here.\n",
      "mizzen.yml": "title: Hooks\n",
    });

    const themed = build(ctx, site, join(site, "theme"));
    const themedHtml = read(themed, "index.html");
    check(themedHtml.includes('class="theme"'), "the theme layout was not used");
    check(themedHtml.includes('<a class="term" href="#w1"'), "the inline directive did not reach the theme component");

    tree(site, { "mizzen.yml": "title: Hooks\ntheme:\n  overrides:\n    layouts:\n      doc: theme-own/doc.ts\n" });
    const overridden = build(ctx, site, join(site, "theme"));
    const html = read(overridden, "index.html");
    check(html.includes('class="site"') && html.includes("<main>"), "the site layout did not replace the theme's");
    check(!html.includes('class="theme"'), "the theme layout still drew the page");
    check(html.includes('<a class="term" href="#w1"'), "an unselected component no longer comes from the theme");
    const css = filesUnder(overridden).find((file) => file.startsWith("assets/theme/") && file.endsWith(".css"));
    check(css !== undefined, "the build wrote no CSS");
    check(read(overridden, css).includes(".site-shell{color:red}"), "the override's CSS sidecar is not bundled");

    tree(site, { "mizzen.yml": "title: Hooks\ntheme:\n  overrides:\n    components:\n      nosuch: theme-own/doc.ts\n" });
    const bad = ctx.mizzen(["build", site, "--out", join(ctx.dir, "out-bad"), "--theme", join(site, "theme")], ctx.dir);
    check(bad.status !== 0, "a bad override built successfully");
    check(`${bad.stdout}${bad.stderr}`.includes("theme.overrides.components.nosuch"), "the bad override is not named");
  },
};


const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TRACE_FIXTURE = join(ROOT, "fixtures/traces/release-trace.json");
const EVAL_SUITE = join(ROOT, "fixtures/evals");
const CONTEXT_FIXTURE = join(ROOT, "fixtures/context-compiler");
const READINESS_SITE = join(ROOT, "fixtures/readiness/site");
const READINESS_THEME = join(ROOT, "fixtures/readiness/theme");

/** A SHA-256, as the edit transaction contract writes it. */
function sha(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Writes one version 1 transaction whose patches replace the whole of each named line. */
function transaction(
  root: string,
  name: string,
  entries: readonly { readonly file: string; readonly line: number; readonly expected: string; readonly replacement: string }[],
): string {
  const files: Record<string, string> = {};
  for (const entry of entries) files[entry.file] = sha(read(root, entry.file));
  const path = join(root, name);
  writeFileSync(
    path,
    `${JSON.stringify({
      version: 1,
      task: { id: "release-acceptance" },
      snapshot: { files },
      patches: entries.map((entry) => ({
        file: entry.file,
        patches: [{
          span: { line: entry.line, column: 3, endLine: entry.line, endColumn: 3 },
          expected: entry.expected,
          replacement: entry.replacement,
          beforeHash: files[entry.file],
        }],
      })),
      preconditions: { requireBeforeHash: true, validateContent: true },
    }, null, 2)}\n`,
  );
  return path;
}

const tasks: AcceptanceCase = {
  id: "tasks",
  title: "Agent tasks register, preview, run, and cancel through the public CLI",
  run: (ctx) => {
    const site = join(ctx.dir, "tasks-site");
    tree(site, {
      "mizzen.yml": "title: Tasks\n",
      "index.md": "# Home\n\nWelcome to the task demo.\n",
      "guide/install.md": "# Install\n\nRun the installer.\n",
    });
    const capabilities = JSON.parse(output(ctx.mizzen(["agent", "capabilities"], ctx.dir), "agent capabilities")) as {
      version?: number;
      commands?: unknown;
    };
    check(capabilities.version === 1, "agent capabilities is not version 1");
    const contract = {
      version: 1,
      idempotencyKey: "release-task",
      goal: "Update the install guide",
      scope: { pages: ["/guide/install/"], blocks: [], collections: [], symbols: [], files: ["guide/install.md"] },
      snapshot: { content: "a".repeat(64), data: "b".repeat(64), config: "c".repeat(64), tooling: "d".repeat(64) },
      budget: { contextTokens: 6000, toolCalls: 20, timeMs: 60000 },
      permissions: { read: ["*"], write: ["agent"], check: ["agent"] },
      acceptance: [
        { id: "doctor", statement: "The doctor passes", check: "doctor" },
        { id: "review", statement: "A person reviewed the wording", review: true },
      ],
    };
    const registered = JSON.parse(
      output(ctx.mizzen(["agent", "task", "register", site, "--stdin"], ctx.dir, `${JSON.stringify(contract)}\n`), "agent task register"),
    ) as { created: boolean; taskId: string; task: { state: string; budget: { contextTokens: number } } };
    check(registered.created === true, "register did not create the task");
    check(registered.task.state === "draft", "a new task is not a draft");
    check(registered.task.budget.contextTokens === 6000, "the task budget was not kept");
    const status = JSON.parse(
      output(ctx.mizzen(["agent", "task", "status", registered.taskId, site], ctx.dir), "agent task status"),
    ) as { task: { state: string } };
    check(status.task.state === "draft", "status does not name the draft task");
    const preview = JSON.parse(
      output(ctx.mizzen(["agent", "task", "run", registered.taskId, site, "--dry-run"], ctx.dir), "agent task dry run"),
    ) as { ok: boolean; dryRun: boolean; outcome: string };
    check(preview.ok === true, "the dry run failed");
    check(preview.dryRun === true, "the dry run did not report a preview");
    const cancel = JSON.parse(
      output(ctx.mizzen(["agent", "task", "cancel", registered.taskId, site, "--reason", "release check"], ctx.dir), "agent task cancel"),
    ) as { task: { state: string } };
    check(cancel.task.state === "canceled", "cancel did not record the canceled state");
  },
};

const packs: AcceptanceCase = {
  id: "packs",
  title: "A task contract compiles a sourced context pack within its budget",
  run: (ctx) => {
    const site = join(ctx.dir, "context-site");
    cpSync(CONTEXT_FIXTURE, site, { recursive: true });
    const text = output(ctx.mizzen(["pack", site, "--task", join(site, "task.json"), "--format", "json"], ctx.dir), "pack --task");
    const pack = JSON.parse(text) as {
      accounting: { used: number; remaining: number; requested: number };
      answerability: { complete: boolean; shortages: readonly string[] };
      fragments: readonly { source: { block?: string; file: string; span: string } }[];
      omitted: readonly unknown[];
    };
    check(pack.accounting.used > 0 && pack.accounting.used <= pack.accounting.requested, "the pack accounting is wrong");
    check(pack.answerability.complete === true, "the fixture task is not answerable");
    check(pack.answerability.shortages.length === 0, "an answerable pack reports shortages");
    check(pack.fragments.some((fragment) => fragment.source.block === "install-steps"), "the install-steps block is missing");
    check(pack.fragments.every((fragment) => fragment.source.file !== "" && fragment.source.span !== ""), "a fragment has no source");
    check(!text.includes(ctx.dir), "the pack leaks an absolute path");
  },
};

const edits: AcceptanceCase = {
  id: "edits",
  title: "An edit transaction previews, applies atomically, proves, and rolls back",
  run: (ctx) => {
    const site = join(ctx.dir, "edits-site");
    tree(site, { "docs/a.md": "# A\n", "docs/b.md": "# B\n" });
    const tx = transaction(site, "tx.json", [
      { file: "docs/a.md", line: 1, expected: "A", replacement: "AA" },
      { file: "docs/b.md", line: 1, expected: "B", replacement: "BB" },
    ]);
    const preview = JSON.parse(
      output(ctx.mizzen(["edit", "transaction", tx, site, "--dry-run", "--format", "json"], ctx.dir), "edit transaction --dry-run"),
    ) as { applied: boolean; dryRun: boolean; diff: string };
    check(preview.applied === false && preview.dryRun === true, "the preview applied the transaction");
    check(preview.diff.includes("docs/a.md") && preview.diff.includes("docs/b.md"), "the preview diff is incomplete");
    check(read(site, "docs/a.md") === "# A\n", "the preview wrote a.md");
    const applied = JSON.parse(
      output(ctx.mizzen(["edit", "transaction", tx, site, "--format", "json"], ctx.dir), "edit transaction"),
    ) as { applied: boolean; files: readonly { file: string; afterHash: string }[] };
    check(applied.applied === true && applied.files.length === 2, "the transaction did not apply both files");
    check(read(site, "docs/a.md") === "# AA\n" && read(site, "docs/b.md") === "# BB\n", "the transaction bytes are wrong");
    const proof = `${tx}.receipt.json.proof.json`;
    check(existsSync(proof), "the transaction wrote no proof");
    ok(ctx.mizzen(["edit", "verify", proof], site), "edit verify");
    const rollback = JSON.parse(
      output(ctx.mizzen(["edit", "rollback", `${tx}.receipt.json`, site, "--format", "json"], ctx.dir), "edit rollback"),
    ) as { restored: readonly string[] };
    check(rollback.restored.length === 2, "rollback did not restore both files");
    check(read(site, "docs/a.md") === "# A\n" && read(site, "docs/b.md") === "# B\n", "rollback left edited bytes");
  },
};

const graph: AcceptanceCase = {
  id: "graph",
  title: "The knowledge graph answers a stable path through the public CLI",
  run: (ctx) => {
    const site = join(ctx.dir, "graph-site");
    tree(site, {
      "mizzen.yml": "title: Graph\n",
      "index.md": "# Home\n\nSee [install](guide/install.md).\n",
      "guide/install.md": "# Install\n\nRun the installer.\n",
    });
    const args = ["graph", site, "--from", "page:index.md", "--to", "page:guide/install.md", "--json"];
    const first = JSON.parse(output(ctx.mizzen(args, ctx.dir), "graph")) as { snapshot: string; path?: readonly { node: { id: string } }[] };
    const second = JSON.parse(output(ctx.mizzen(args, ctx.dir), "graph again")) as { snapshot: string; path?: readonly { node: { id: string } }[] };
    check(typeof first.snapshot === "string" && first.snapshot.startsWith("graph:"), "the graph has no snapshot");
    check(first.path !== undefined && first.path.length >= 2, "the graph found no path");
    check(first.path[0]?.node.id === "page:index.md", "the path does not start at the requested page");
    check(first.path.at(-1)?.node.id === "page:guide/install.md", "the path does not end at the requested page");
    check(JSON.stringify(first) === JSON.stringify(second), "two graph queries differ");
  },
};

const knowledge: AcceptanceCase = {
  id: "knowledge",
  title: "Explicit unknowns are declared, reported, redacted, and kept from a definitive graph answer",
  run: (ctx) => {
    const site = join(ctx.dir, "knowledge-site");
    tree(site, {
      "mizzen.yml": "title: Knowledge\n",
      "index.md": "---\ntitle: Home\n---\n\n# Home\n\nSee [Windows](/windows/).\n",
      "windows.md":
        "---\ntitle: Windows\nknowledge:\n  status: unknown\n  scope: [platform:windows]\n  rationale: private-reason-898\n  citation: https://secret.example/898\n  expires: 2020-01-01\n---\n\n# Windows\n\nNot established.\n",
      "plain.md": "---\ntitle: Plain\n---\n\n# Plain\n",
    });

    const text = output(ctx.mizzen(["knowledge", site, "--as-of", "2026-11-23"], ctx.dir), "knowledge");
    check(/unknown 1/.test(text), "the report does not count the explicit unknown");
    check(/missing 2/.test(text), "the report does not keep the documentation gaps apart");
    check(/documentation gap/.test(text), "the report does not name the documentation gap");
    check(/needs review/.test(text), "the expired declaration is not flagged for review");
    check(!text.includes("private-reason-898") && !text.includes("secret.example"), "the report leaks a private value");

    const json = JSON.parse(output(ctx.mizzen(["knowledge", site, "--json"], ctx.dir), "knowledge json")) as {
      counts: Record<string, number>;
      entries: readonly { declaration?: { redacted?: boolean } }[];
    };
    check(json.counts.unknown === 1 && json.counts.missing === 2, "the JSON counts are wrong");
    check(json.entries.some((entry) => entry.declaration?.redacted === true), "the JSON does not mark the redaction");
    check(!JSON.stringify(json).includes("private-reason-898"), "the JSON leaks a private rationale");

    const graph = JSON.parse(
      output(ctx.mizzen(["graph", site, "--from", "page:index.md", "--scope", "platform:linux", "--json"], ctx.dir), "graph"),
    ) as { neighbors: readonly { node: { id: string; definitive?: boolean } }[] };
    const windows = graph.neighbors.find((entry) => entry.node.id === "page:windows.md");
    check(windows?.node.definitive === false, "an out-of-scope query treated the unknown as definitive");

    const gated = ctx.mizzen(["knowledge", site, "--fail-on", "unknown"], ctx.dir);
    check(gated.status === 1, "the gate did not fail on an explicit unknown");
  },
};

const decisions: AcceptanceCase = {
  id: "decisions",
  title: "Versioned decisions answer why before and after supersession, and a private rationale is withheld",
  run: (ctx) => {
    const site = join(ctx.dir, "decisions-site");
    tree(site, {
      "mizzen.yml": "title: Decisions\ndecisions:\n  dir: docs/decisions\n  behaviors: [cache-hit]\n",
      "index.md": "---\ntitle: Home\n---\n\n# Home\n\nSee the [cache guide](/guide/caching/).\n",
      "guide/caching.md": "---\ntitle: Caching\n---\n\n# Caching\n\nHits come from memory.\n",
      "docs/decisions/0001.md":
        "---\nid: ADR-0001\ntitle: In-memory cache\nstatus: superseded\ndate: 2025-01-10\nsource: https://example.test/rfcs/1\npages: [guide/caching.md]\nvalidity:\n  versions: [v1]\npublic: true\n---\n\n## Decision\n\nCache every hit in a map.\n\n## Rationale\n\nThe working set was small.\n\n## Alternatives\n\n- **Redis** — rejected because the team ran no extra service.\n",
      "docs/decisions/0002.md":
        "---\nid: ADR-0002\ntitle: Redis cache\nstatus: accepted\ndate: 2025-03-02\nsource: https://example.test/rfcs/2\nsupersedes: [ADR-0001]\nbehaviors: [cache-hit]\npages: [guide/caching.md]\nvalidity:\n  versions: [v2]\n---\n\n## Decision\n\nCache hits in Redis.\n\n## Rationale\n\nsecret-reason-898\n\n## Alternatives\n\n- **Keep the map** — rejected because workers disagreed.\n",
    });

    const report = JSON.parse(output(ctx.mizzen(["decisions", site, "--json"], ctx.dir), "decisions")) as {
      counts: Record<string, number>;
      entries: readonly { id: string; rationale?: string; redacted?: boolean }[];
    };
    check(report.counts.accepted === 1 && report.counts.superseded === 1, "the lifecycle counts are wrong");
    check(!JSON.stringify(report).includes("secret-reason-898"), "the report leaks a private rationale");

    const before = JSON.parse(
      output(ctx.mizzen(["decisions", "why", "behavior:cache-hit", site, "--version", "v1", "--json"], ctx.dir), "why v1"),
    ) as { current?: { id: string }; history: readonly { id: string }[] };
    check(before.current?.id === "ADR-0001", "the v1 answer is not the first decision");
    check(before.history.length === 0, "the v1 answer has history it should not");

    const after = JSON.parse(
      output(ctx.mizzen(["decisions", "why", "behavior:cache-hit", site, "--version", "v2", "--json"], ctx.dir), "why v2"),
    ) as { current?: { id: string; rationale?: string; alternatives: readonly { name: string }[] }; history: readonly { id: string }[] };
    check(after.current?.id === "ADR-0002", "the v2 answer is not the replacement");
    check(after.history.length === 1 && after.history[0]?.id === "ADR-0001", "the v2 history does not name the first decision");
    check(after.current?.alternatives.length === 1, "the v2 answer lost the rejected alternative");
    check(!JSON.stringify(after).includes("secret-reason-898"), "the answer leaks a private rationale");

    const text = output(ctx.mizzen(["decisions", "why", "/guide/caching/", site, "--version", "v2"], ctx.dir), "why text");
    check(/History: ADR-0001/.test(text), "the text answer does not name the history");
  },
};

const mcp: AcceptanceCase = {
  id: "mcp",
  title: "The MCP handshake, tool list, search, and client report work over stdio",
  run: (ctx) => {
    const site = join(ctx.dir, "mcp-site");
    const themeRoot = theme(site);
    tree(site, {
      "mizzen.yml": "title: MCP\n",
      "index.md": "# Home\n\nInstall the engine with Node 24.\n",
      "guide/install.md": "# Install\n\nRun npm install @velella/mizzen.\n",
    });
    const messages = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-desktop", version: "1" } } },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_docs", arguments: { query: "install" } } },
    ].map((message) => JSON.stringify(message)).join("\n");
    const run = ctx.mizzen(["mcp", site, "--theme", themeRoot], ctx.dir, `${messages}\n`);
    ok(run, "mcp");
    const answers = new Map<number, any>();
    for (const line of run.stdout.split("\n").filter(Boolean)) {
      const value = JSON.parse(line) as { id?: number };
      if (typeof value.id === "number") answers.set(value.id, value);
    }
    const hello = answers.get(1);
    check(hello?.result?.capabilities?.experimental?.mizzen?.contractVersion === 1, "the handshake announces no contract version");
    check(hello?.result?.capabilities?.experimental?.mizzen?.tasks?.async === true, "the handshake omits the task capabilities");
    const tools = answers.get(2)?.result?.tools as readonly { name: string }[] | undefined;
    check(tools !== undefined && tools.some((tool) => tool.name === "search_docs"), "tools/list omits search_docs");
    const search = answers.get(3)?.result;
    check(search?.isError !== true, "search_docs failed");
    check(`${JSON.stringify(search)}`.includes("install"), "search_docs found no install text");
    check(!run.stdout.includes(ctx.dir), "the MCP answer leaks an absolute path");
    const config = JSON.parse(output(ctx.mizzen(["mcp", site, "--print-config", "cursor"], ctx.dir), "--print-config")) as {
      mcpServers?: { mizzen?: { command: string; args: readonly string[] } };
    };
    check(config.mcpServers?.mizzen?.command === "npx", "the client config starts no npx server");
    for (const name of ["claude-code", "claude-desktop", "cursor", "vscode"]) {
      ok(ctx.mizzen(["mcp", site, "--print-config", name], ctx.dir), `--print-config ${name}`);
    }
  },
};

const traces: AcceptanceCase = {
  id: "traces",
  title: "A recorded trace replays read-only, exports only safe fields, and hands off",
  run: (ctx) => {
    check(existsSync(TRACE_FIXTURE), "the trace fixture is missing");
    const replay = output(ctx.mizzen(["trace", "replay", TRACE_FIXTURE], ctx.dir), "trace replay");
    check(replay.includes("replay ok"), "trace replay did not pass");
    check(filesUnder(ctx.dir).length === 0, "trace replay wrote a file");
    const exported = join(ctx.dir, "export");
    ok(ctx.mizzen(["trace", "export", TRACE_FIXTURE, "--out", exported], ctx.dir), "trace export");
    const files = filesUnder(exported);
    check(files.length === 1, "trace export wrote more than one file");
    const text = read(exported, files[0]!);
    check(!text.includes(ctx.dir), "the exported trace leaks an absolute path");
    const handoff = output(ctx.mizzen(["trace", "handoff", TRACE_FIXTURE], ctx.dir), "trace handoff");
    check(handoff.trim() !== "", "trace handoff is empty");
  },
};

const permissions: AcceptanceCase = {
  id: "permissions",
  title: "An access policy refuses a write outside its capability and scope",
  run: (ctx) => {
    const site = join(ctx.dir, "policy-site");
    tree(site, { "docs/a.md": "# A\n" });
    const tx = transaction(site, "tx.json", [{ file: "docs/a.md", line: 1, expected: "A", replacement: "AA" }]);
    const policy = join(ctx.dir, "policy.json");
    writeFileSync(policy, `${JSON.stringify({ version: 1, capabilities: { write: false } }, null, 2)}\n`);
    const refused = ctx.mizzen(["edit", "transaction", tx, site, "--policy", policy, "--format", "json"], ctx.dir);
    check(refused.status !== 0, "a policy without write applied the transaction");
    check(read(site, "docs/a.md") === "# A\n", "a denied write changed the source");
    check(!existsSync(`${tx}.receipt.json`), "a denied write wrote a receipt");
    writeFileSync(
      policy,
      `${JSON.stringify({ version: 1, approvals: { write: false }, capabilities: { write: true }, write: { paths: ["docs/**"], scope: { pages: ["/guide/"] } } }, null, 2)}\n`,
    );
    const outside = ctx.mizzen(["edit", "transaction", tx, site, "--policy", policy, "--format", "json"], ctx.dir);
    check(outside.status !== 0, "a write outside the policy scope applied");
    check(read(site, "docs/a.md") === "# A\n", "an out-of-scope write changed the source");
  },
};

const evals: AcceptanceCase = {
  id: "evals",
  title: "The reference evaluation suite runs offline and reports a deterministic gate",
  run: (ctx) => {
    const text = output(ctx.mizzen(["eval", EVAL_SUITE, "--format", "json"], ctx.dir), "eval");
    const report = JSON.parse(text) as {
      version: number;
      run: { id: string; runner: { id: string } };
      cases: readonly { status: string }[];
      gate: { passed: boolean };
    };
    check(report.version === 1, "the eval report is not version 1");
    check(report.run.runner.id === "reference", "the eval did not use the offline reference runner");
    check(/^[0-9a-f]{64}$/.test(report.run.id), "the eval run id is not deterministic");
    check(report.cases.length === 11, "the reference suite has 11 cases");
    check(report.gate.passed === true, "the reference suite gate failed");
    check(!text.includes(ctx.dir), "the eval report leaks an absolute path");
  },
};

const readiness: AcceptanceCase = {
  id: "readiness",
  title: "A real build scores, gates, and badges against the public readiness rubric",
  run: (ctx) => {
    const site = join(ctx.dir, "readiness-site");
    cpSync(READINESS_SITE, site, { recursive: true });
    const out = build(ctx, site, READINESS_THEME);
    const reportPath = join(ctx.dir, "readiness.json");
    const badgePath = join(ctx.dir, "readiness.svg");
    ok(
      ctx.mizzen(["readiness", out, "--report", reportPath, "--badge", badgePath, "--min-overall", "90"], ctx.dir),
      "readiness",
    );
    const report = JSON.parse(read(ctx.dir, "readiness.json")) as {
      version: number;
      rubric: { version: string };
      status: string;
      overall: number;
      digest: string;
    };
    check(report.version === 1, "the readiness report is not version 1");
    check(report.rubric.version === "1.0.0", "the readiness rubric is not 1.0.0");
    check(report.status === "pass" && report.overall >= 90, "the readiness fixture did not pass");
    check(/^[0-9a-f]{64}$/.test(report.digest), "the readiness report has no digest");
    const badge = read(ctx.dir, "readiness.svg");
    check(badge.startsWith("<svg ") && badge.includes("readiness v1.0.0"), "the badge is not a readiness SVG");
    for (const text of [JSON.stringify(report), badge]) {
      check(!text.includes(ctx.dir), "a readiness artifact leaks an absolute path");
      check(!text.includes("PRIVATE_READINESS_SENTINEL"), "a readiness artifact leaks a private sentinel");
    }
    for (const file of filesUnder(out)) {
      check(!file.includes("private"), `the build published a private file: ${file}`);
    }
  },
};

const verifiablePublishing: AcceptanceCase = {
  id: "verifiable-publishing",
  title: "An installed Mizzen signs public output, verifies it locally, and detects tampering",
  run(ctx) {
    const site = join(ctx.dir, "site");
    tree(site, {
      "mizzen.yml": "title: Publishing acceptance\n",
      "guide/publishing.md": "---\ntitle: Publishing acceptance\n---\n\n# Publishing acceptance\n",
    });
    const themeRoot = theme(ctx.dir);
    tree(themeRoot, { "package.json": '{"name":"acceptance","version":"1.0.0","type":"module"}\n' });
    const bundle = build(ctx, site, themeRoot, ["--diagnose"]);
    const page = "guide/publishing/index.html";
    check(read(bundle, page).includes("Publishing acceptance"), "the fixture page was not built");
    const evidence = "evidence/check.json";
    tree(bundle, { [evidence]: '{"result":"pass"}\n' });
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const { tools } = JSON.parse(read(site, ".mizzen/build-report.json"));
    tree(ctx.dir, {
      "key.pem": privateKey.export({ type: "pkcs8", format: "pem" }),
      "provenance.json": JSON.stringify({
        site: "publishing-acceptance", sourceCommit: "a".repeat(40), snapshot: "fixture-v1",
        engine: tools.mizzen, theme: tools.theme, builtOn: "2026-11-21",
        publicEvidence: { snapshot: "fixture-v1", paths: [evidence] },
      }),
      "policy.json": JSON.stringify({
        site: "publishing-acceptance", snapshot: "fixture-v1", formats: [1], minimumEvidence: 1,
        unsigned: "reject", keys: [publicKey.export({ type: "spki", format: "pem" })],
      }),
    });
    const attestation = output(ctx.mizzen(["published-site", "attest", bundle, "provenance.json", "--key", "key.pem"], ctx.dir), "sign fixture");
    check(!attestation.includes(ctx.dir) && !attestation.includes("PRIVATE KEY"), "the attestation leaked a path or credential");
    tree(ctx.dir, { "attestation.json": attestation });
    const verify = () => ctx.mizzen(["published-site", "verify", bundle, "attestation.json", "policy.json"], ctx.dir);
    const accepted = verify();
    ok(accepted, "verify the signed bundle");
    check(JSON.parse(accepted.stdout).ok === true, "verification must return JSON success");

    tree(bundle, { [page]: "<p>Tampered</p>\n", [evidence]: '{"result":"fail"}\n' });
    const rejected = verify();
    check(rejected.status === 1, "tampering must fail verification");
    const findings = JSON.parse(rejected.stdout).issues as readonly { code: string; path: string }[];
    check(findings.some(({ code, path }) => code === "file-changed" && path === page), "the changed page was not located");
    check(findings.some(({ code, path }) => code === "evidence-changed" && path === evidence), "the swapped evidence was not located");
  },
};

const checkReports: AcceptanceCase = {
  id: "check-reports",
  title: "Publish check report pages and JSON",
  run(ctx) {
    const site = join(ctx.dir, "reports");
    const shared = { tool: "Example", scope: "docs", coverage: "complete", checks: [], findings: [] };
    tree(site, {
      "mizzen.yml": "title: Check reports\noutputs: { check-report: true }\n",
      "_data/report-set.json": JSON.stringify({
        schemaVersion: 1, title: "Check reports", route: "/checks/",
        runs: [
          { ...shared, id: "before", date: "2026-11-22", metrics: [{ id: "size", unit: "B", value: 10 }] },
          {
            ...shared, id: "after", date: "2026-11-23", metrics: [{ id: "size", unit: "B", value: 12 }],
            findings: [{ id: "new", severity: "unknown", message: "A finding without a severity claim" }],
          },
        ],
        comparisons: [{ base: "before", head: "after" }],
      }),
    });
    const out = build(ctx, site, theme(ctx.dir));
    const payload = JSON.parse(read(out, "checks/data.json"));
    check(payload.comparisons[0]?.changes[0]?.kind === "new", "the new finding did not reach JSON");
    check(payload.series.find((item: { id: string }) => item.id === "size")?.points[1]?.value === 12, "the metric did not reach the trend");
    check(read(out, "checks/runs/after/index.html").includes('href="/checks/data.json"'), "the run did not link to its JSON");
    check(read(out, "checks/compare/before/after/index.html").includes('href="/checks/data.json"'), "the comparison page was not built");
  },
};

/** Every required case, in the order a release runs them. */
export const CASES: readonly AcceptanceCase[] = [
  checkReports,
  blog,
  apiReference,
  annotations,
  versions,
  imports,
  apiFetch,
  dbInput,
  collections,
  transformLineage,
  refresh,
  diff,
  records,
  themeHooks,
  schema,
  quality,
  lifecycle,
  preview,
  starters,
  blocks,
  references,
  performance,
  tasks,
  packs,
  edits,
  graph,
  knowledge,
  decisions,
  mcp,
  traces,
  permissions,
  evals,
  readiness,
  verifiablePublishing,
];
