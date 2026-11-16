import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { copyFixture, harness, type Harness } from "./mcp-helpers.ts";

let h: Harness;
before(async () => {
  h = await harness(copyFixture("data-site"));
});
after(() => h.close());

test("resources/list names llms.txt, AGENTS.md, and the Markdown twins", async () => {
  const r = await h.rpc("resources/list");
  const uris: string[] = r.result.resources.map((x: { uri: string }) => x.uri);
  assert.ok(uris.includes("mizzen://site/llms.txt"));
  assert.ok(uris.includes("mizzen://site/AGENTS.md"));
  assert.ok(uris.includes("mizzen://site/components/button/index.md"));
});

test("resources/read returns the text with its type", async () => {
  const r = await h.rpc("resources/read", { uri: "mizzen://site/components/button/index.md" });
  assert.equal(r.result.contents[0].mimeType, "text/markdown");
  assert.match(r.result.contents[0].text, /Button/);
});

test("a resource that is not listed or lies outside the site is refused", async () => {
  for (const uri of ["mizzen://site/../mizzen.yml", "mizzen://site/sourcemap.json", "mizzen://site/nope.md", "file:///etc/passwd", "mizzen://site//etc/passwd"]) {
    const r = await h.rpc("resources/read", { uri });
    assert.ok(r.error, uri);
  }
});

test("listing pages through a cursor reaches every resource once", async () => {
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const r = await h.rpc("resources/list", cursor === undefined ? {} : { cursor });
    for (const x of r.result.resources) {
      assert.ok(!seen.has(x.uri));
      seen.add(x.uri);
    }
    cursor = r.result.nextCursor;
  } while (cursor !== undefined);
  assert.ok(seen.size > 3);
  assert.ok((await h.rpc("resources/list", { cursor: "bogus" })).error);
});

test("resource templates list is empty and answers", async () => {
  assert.deepEqual((await h.rpc("resources/templates/list")).result.resourceTemplates, []);
});
