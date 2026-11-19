import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { runGraph } from "../src/cli/graph.ts";
import { buildModel } from "../src/model/build.ts";
import { tool } from "../src/mcp/tools/query_graph.ts";
import type { SiteState } from "../src/mcp/site.ts";

const FILES = {
  "mizzen.yml": [
    "title: Graph surfaces",
    "collections:",
    "  findings:",
    "    source: _data/findings.yml",
    "    template: _templates/finding.md",
    "    permalink: /findings/{id}/",
    "    evidence: claims",
    "",
  ].join("\n"),
  "guide.md": [
    "---",
    "title: Guide",
    "---",
    "# Guide {#guide}",
    "",
    "<!-- {#docs-block} -->",
    "Use `add(a, b)` from `src/math.ts:1`.",
    "",
    "::include[snippets/note.md]",
    "",
  ].join("\n"),
  "src/math.ts": "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
  "snippets/note.md": "A note.\n",
  "_data/findings.yml": [
    "- id: eol",
    "  statement: Node 18 reaches end of life.",
    "  claims:",
    "    statement:",
    "      - id: schedule",
    "        title: Node release schedule",
    "        url: https://nodejs.org/en/about/previous-releases",
    "",
  ].join("\n"),
  "_templates/finding.md": '---\ntitle: "{statement}"\n---\n# :field[statement]\n',
} as const;

function tree(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "graph-surfaces-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

test("the CLI and MCP return the same path and node ids", async () => {
  const root = tree(FILES);
  try {
    const cliLog: string[] = [];
    const cliErrors: string[] = [];
    const code = await runGraph(
      [root, "--from", "page:guide.md", "--to", "symbol:src/math.ts#add", "--depth", "8"],
      { log: (message) => cliLog.push(message), error: (message) => cliErrors.push(message) },
    );
    assert.equal(code, 0, cliErrors.join("\n"));
    const cli = JSON.parse(cliLog.join("\n")) as { found?: boolean; path?: { node: { id: string } }[]; snapshot: string };
    assert.equal(cli.found, true, cliLog.join("\n"));
    assert.deepEqual(cli.path?.map((step) => step.node.id), [
      "page:guide.md",
      "snippet:guide.md#1",
      "symbol:src/math.ts#add",
    ]);

    const model = await buildModel(root);
    const site = { root, site: model.site } as unknown as SiteState;
    const call = async (input: Record<string, unknown>) =>
      JSON.parse((await tool.handler(input, { site, signal: new AbortController().signal, runtime: null as never, session: null as never })).text) as {
        found?: boolean;
        path?: { node: { id: string } }[];
        snapshot: string;
      };
    const mcp = await call({ from: "page:guide.md", to: "symbol:src/math.ts#add", depth: 8 });
    assert.equal(mcp.found, true);
    assert.equal(mcp.snapshot, cli.snapshot);
    assert.deepEqual(mcp.path, cli.path);

    const evidence = await call({ from: "page:record:findings/eol", to: "evidence:https://nodejs.org/en/about/previous-releases", depth: 8 });
    assert.equal(evidence.found, true);
    assert.deepEqual(evidence.path?.map((step) => step.node.id), [
      "page:record:findings/eol",
      "claim:findings/eol/statement",
      "evidence:https://nodejs.org/en/about/previous-releases",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
