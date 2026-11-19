import assert from "node:assert/strict";
import { test } from "node:test";
import type { Collection, ContextRequest, Page, Site, SiteConfig } from "../src/contracts/index.ts";
import type { AccessPolicy } from "../src/contracts/permissions.ts";
import { buildGraph } from "../src/graph/build.ts";
import { queryGraph } from "../src/graph/query.ts";
import { compilePack } from "../src/packs/compile.ts";
import { parseAccessPolicy } from "../src/permissions/policy.ts";

const config: SiteConfig = {
  title: "Access",
  base: "",
  lang: "en",
  dir: "ltr",
  languages: [],
  source: ".",
  include: [],
  exclude: [],
  navigation: "_data/navigation.yml",
  collections: { notes: { source: "_data/notes.yml" } },
  feeds: {},
  defaults: [],
  theme: { options: {} },
  search: {},
  redirects: {},
  outputs: {},
};

const pos = { file: "public.md", line: 1, column: 1, endLine: 1, endColumn: 1 };

function page(file: string, title: string, text: string, audience?: string): Page {
  const slug = file.replace(/\.md$/, "");
  return {
    url: `/${slug}/`,
    source: { ...pos, file },
    frontMatter: { title, ...(audience === undefined ? {} : { audience }) },
    title,
    lang: "en",
    dir: "ltr",
    headings: [],
    blocks: [{ id: `${slug}-block`, pos: { ...pos, file, line: 3, endLine: 3 }, declared: true }],
    html: "",
    markdown: text,
    kind: "doc",
  };
}

const record: Collection["records"][number] = {
  id: "secret",
  fields: { title: "Public note", statement: "Internal secret statement", audience: "staff" },
  position: { file: "_data/notes.yml", startLine: 1, startColumn: 1, endLine: 3, endColumn: 1 },
  fieldPositions: {},
};

const site: Site = {
  config,
  nav: {},
  data: {},
  pages: [page("public.md", "Public guide", "# Public guide\n\nPublic body for deploy.\n"), page("secret.md", "Secret title", "# Secret title\n\nSecret body.\n"), page("staff.md", "Staff title", "# Staff title\n\nStaff body.\n", "staff")],
  collections: { notes: { name: "notes", source: "_data/notes.yml", records: [record] } },
};

function policy(value: Record<string, unknown>): AccessPolicy {
  const result = parseAccessPolicy({ version: 1, ...value });
  assert.equal(result.problems.length, 0, JSON.stringify(result.problems));
  assert.ok(result.policy !== undefined);
  return result.policy;
}

const request: ContextRequest = {
  version: 1,
  task: { goal: "deploy" },
  include: [],
  exclude: [],
  constraints: {},
  budget: { maxTokens: 6000 },
  requiredEvidence: { refs: [], source: false, versions: false, warnings: false, dependencies: false },
};

const context = {
  renderPage: () => Promise.reject(new Error("pack builds no pages")),
  report: () => undefined,
};

test("graph denies a page, block, audience, collection, and field the policy leaves out", () => {
  const policyValue = policy({ read: { pages: ["public.md"], blocks: ["public-block"], collections: ["notes"], fields: { notes: ["title"] } } });
  const { graph } = buildGraph({ site, links: [{ page: "public.md", href: "/secret/", pos, internal: true, target: "secret.md" }] });
  const result = queryGraph(graph, { snapshot: graph.snapshot.id, from: "page:public.md", depth: 4, nodes: 100, access: policyValue });
  const text = JSON.stringify(result);
  assert.equal(text.includes("Secret title"), false);
  assert.equal(text.includes("page:secret.md"), false);
  assert.equal(text.includes("Staff title"), false);
  assert.equal(text.includes("secret-block"), false);
  assert.ok(text.includes("public-block"));

  const field = queryGraph(graph, { snapshot: graph.snapshot.id, from: "field:notes/secret/title", depth: 2, access: policyValue });
  assert.ok(JSON.stringify(field).includes("title"));
  const deniedField = queryGraph(graph, { snapshot: graph.snapshot.id, from: "field:notes/secret/statement", depth: 2, access: policyValue });
  assert.equal(JSON.stringify(deniedField.neighbors).includes("statement"), false);

  const hiddenStart = queryGraph(graph, { snapshot: graph.snapshot.id, from: "page:secret.md", access: policyValue });
  assert.equal(hiddenStart.status, "unknown");
  assert.equal(JSON.stringify(hiddenStart).includes("Secret title"), false);
});

test("a previous snapshot cannot report a hidden page as deleted", () => {
  const previous = buildGraph({ site }).graph;
  const current = buildGraph({ site: { ...site, pages: site.pages.slice(1) } }).graph;
  const access = policy({ read: { pages: ["public.md"] } });
  const result = queryGraph(current, {
    snapshot: current.snapshot.id,
    from: "page:secret.md",
    previous,
    access,
  });
  assert.equal(result.status, "unknown");
  assert.equal(JSON.stringify(result).includes("Secret title"), false);
});

test("pack denies a page the policy leaves out and names no title, URL, or source", async () => {
  const compiled = await compilePack(site, request, context, { access: policy({ read: { pages: ["public.md"] } }) });
  assert.ok(compiled !== undefined);
  const text = `${compiled.markdown}\n${JSON.stringify(compiled.evidence)}`;
  assert.equal(text.includes("Secret title"), false);
  assert.equal(text.includes("secret.md"), false);
  assert.equal(text.includes("Staff title"), false);
  assert.ok(text.includes("Public guide"));
});

test("a required page the policy denies is a located denial, not a leak", async () => {
  const diagnostics: { id: string; message: string }[] = [];
  const compiled = await compilePack(
    site,
    { ...request, requiredEvidence: { ...request.requiredEvidence, refs: ["/secret/"] } },
    { renderPage: context.renderPage, report: (d) => void diagnostics.push(d) },
    { access: policy({ read: { pages: ["public.md"] } }) },
  );
  assert.equal(compiled, undefined);
  const text = JSON.stringify(diagnostics);
  assert.ok(text.includes("context-pack.evidence-denied"));
  assert.equal(text.includes("Secret title"), false);
  assert.equal(text.includes("secret.md"), false);
});
