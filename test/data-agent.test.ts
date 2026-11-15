import assert from "node:assert/strict";
import { test } from "node:test";
import { agentsMd } from "../src/outputs/agents-md.ts";
import { editLinksOf } from "../src/outputs/edit-links.ts";
import { pageAgent } from "../src/outputs/page-agent.ts";
import type { OutputContext } from "../src/contracts/index.ts";
import { withSite } from "./data-record-site.ts";

const files = {
  "mizzen.yml":
    "repository:\n  url: https://github.com/example/site\n" +
    "collections:\n" +
    "  components:\n" +
    "    source: _data/components.yml\n" +
    "    template: _templates/components.md\n" +
    "    permalink: /components/{id}/\n",
  "_data/components.yml": "- id: button\n  name: Button\n  note: Press it.\n",
  "_templates/components.md": "---\ntitle: \"{name}\"\nlayout: record\n---\n# :field[name]\n\nShared wording.\n",
};

const context = (): OutputContext => ({ renderPage: async () => "", report: () => {} });

test("the edit link points at the data file and the record's lines", async () => {
  await withSite(files, (_root, result) => {
    const link = editLinksOf(result.site).find((entry) => entry.url === "/components/button/")!;
    assert.equal(link.source, "_data/components.yml");
    assert.equal(link.line, 1);
    assert.equal(link.endLine, 3);
    assert.equal(
      link.editUrl,
      "https://github.com/example/site/edit/main/_data/components.yml#L1-L3",
    );
  });
});

test("the page's agent.json names the data file, the record, and the template", async () => {
  await withSite(files, async (_root, result) => {
    const file = (await pageAgent.run(result.site, context())).find((entry) =>
      entry.path.endsWith("components/button/agent.json"),
    )!;
    const body = JSON.parse(String(file.contents)) as {
      source: string;
      record?: { collection: string; id: string; template: string; line: number; endLine: number };
    };
    assert.equal(body.source, "_data/components.yml");
    assert.deepEqual(body.record, {
      collection: "components",
      id: "button",
      template: "_templates/components.md",
      line: 1,
      endLine: 3,
    });
  });
});

test("the generated AGENTS.md says where a record page is edited", async () => {
  await withSite(files, async (_root, result) => {
    const text = String((await agentsMd.run(result.site, context()))[0]!.contents);
    assert.match(text, /## Pages built from data/);
    assert.match(text, /Collection `components` builds one page per record from the template `_templates\/components\.md`/);
    assert.match(text, /Edit a page's own wording in its record in `_data\/components\.yml`/);
  });
});
