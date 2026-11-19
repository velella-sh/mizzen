import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "../src/contracts/index.ts";
import type { AccessPolicy } from "../src/contracts/permissions.ts";
import type { SiteState } from "../src/mcp/site.ts";
import { tool as getDiagnostics } from "../src/mcp/tools/get_diagnostics.ts";
import { tool as getPage } from "../src/mcp/tools/get_page.ts";
import { tool as searchDocs } from "../src/mcp/tools/search_docs.ts";
import { parseAccessPolicy } from "../src/permissions/policy.ts";

function policy(value: Record<string, unknown>): AccessPolicy {
  const result = parseAccessPolicy({ version: 1, ...value });
  assert.equal(result.problems.length, 0, JSON.stringify(result.problems));
  assert.ok(result.policy !== undefined);
  return result.policy;
}

const privatePage: Page = {
  url: "/secret/",
  source: { file: "secret.md", line: 1, column: 1, endLine: 1, endColumn: 1 },
  frontMatter: { title: "Secret title" },
  title: "Secret title",
  lang: "en",
  dir: "ltr",
  headings: [],
  html: "",
  markdown: "# Secret title\n\nHidden body.\n",
  kind: "doc",
};

const publicPage: Page = {
  ...privatePage,
  url: "/guide/",
  source: { file: "guide.md", line: 1, column: 1, endLine: 1, endColumn: 1 },
  frontMatter: { title: "Public guide" },
  title: "Public guide",
  markdown: "# Public guide\n\nVisible body.\n",
};

const access = policy({ read: { pages: ["guide.md"] } });
const signal = AbortSignal.timeout(1000);

test("MCP get_page answers a denied page exactly like an unknown one", async () => {
  const site = {
    access,
    find: () => ({ page: privatePage, source: "secret.md", sections: [], trust: "unknown" }),
    readable: () => false,
  } as unknown as SiteState;
  const result = await getPage.handler({ page: "/secret/" }, { site, signal, runtime: null as never, session: null as never });
  assert.equal(result.isError, true);
  assert.equal(result.text.includes("Secret title"), false);
  assert.equal(result.text.includes("secret.md"), false);
  assert.equal(result.text.includes("unknown-page"), true);
});

test("MCP search_docs never ranks a page the policy denies", async () => {
  const site = {
    access,
    readablePages: [{ page: publicPage, source: "guide.md", sections: [], trust: "unknown" }],
    site: { config: { base: "" } },
  } as unknown as SiteState;
  const result = await searchDocs.handler({ query: "hidden" }, { site, signal, runtime: null as never, session: null as never });
  const data = result.data as { total: number; results: readonly unknown[] };
  assert.equal(data.total, 0);
  assert.deepEqual(data.results, []);
  assert.equal(result.text.includes("Secret title"), false);
  assert.equal(result.text.includes("secret.md"), false);
  assert.equal(result.text.includes("Hidden body"), false);
});

test("MCP get_diagnostics drops a finding whose file the policy denies", async () => {
  const site = {
    access,
    diagnostics: [
      {
        id: "private.issue",
        severity: "error",
        message: "Secret title is broken",
        pos: { file: "secret.md", line: 1, column: 1, endLine: 1, endColumn: 1 },
      },
      {
        id: "public.issue",
        severity: "error",
        message: "Public guide is broken",
        pos: { file: "guide.md", line: 1, column: 1, endLine: 1, endColumn: 1 },
      },
    ],
    readableSource: (file: string) => file !== "secret.md",
  } as unknown as SiteState;
  const result = await getDiagnostics.handler({}, { site, signal, runtime: null as never, session: null as never });
  assert.equal(result.text.includes("Secret title"), false);
  assert.equal(result.text.includes("secret.md"), false);
  assert.equal(result.text.includes("public.issue"), true);
});
