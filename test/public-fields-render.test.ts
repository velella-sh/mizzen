import assert from "node:assert/strict";
import { test } from "node:test";
import type { Collection, DataRecord, Page, Site, SiteConfig } from "../src/contracts/index.ts";
import { buildRecordPages } from "../src/data/pages.ts";
import { recordPropsOf } from "../src/data/record-context.ts";
import type { Template } from "../src/data/template.ts";

const pos = { file: "_data/people.yml", startLine: 3, startColumn: 1, endLine: 7, endColumn: 1 };

function record(id: string, fields: Record<string, unknown>, derived?: Record<string, unknown>): DataRecord {
  return { id, fields: { id, ...fields }, position: pos, fieldPositions: {}, ...(derived === undefined ? {} : { derived }) };
}

function config(authorPolicy: readonly string[] | undefined): SiteConfig {
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
    collections: {
      people: {
        source: "_data/people.yml",
        template: "_templates/person.md",
        permalink: "/people/{id}/",
        references: { team: "teams" },
        ...(authorPolicy === undefined ? {} : { public: authorPolicy }),
      },
      teams: { source: "_data/teams.yml", template: "_templates/team.md", permalink: "/teams/{id}/", public: ["name"] },
    },
    feeds: {},
    defaults: [],
    theme: { options: {} },
    search: {},
    redirects: {},
    outputs: {},
  };
}

function page(url: string, collection: string, id: string): Page {
  return {
    url,
    source: { file: "_templates/person.md", line: 1, column: 1, endLine: 1, endColumn: 1 },
    frontMatter: {},
    title: id,
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "",
    markdown: "",
    kind: "doc",
    record: { collection, id, position: pos, template: "_templates/person.md", templateLine: 1, fallbacks: [] },
  };
}

const people = record(
  "ada",
  { title: "Ada", author: { name: "Ada", email: "ada@example.test" }, team: "core", secret: "q" },
  { daysLeft: 3, internalScore: 9 },
);
const teams = record("core", { name: "Core", internalBudget: 42 });

function site(overrides: Partial<SiteConfig> = {}): Site {
  const collections: Record<string, Collection> = {
    people: { name: "people", source: "_data/people.yml", records: [people] },
    teams: { name: "teams", source: "_data/teams.yml", records: [teams] },
  };
  return {
    config: { ...config(["title", "author.name", "team", "daysLeft"]), ...overrides },
    pages: [page("/people/ada/", "people", "ada"), page("/teams/core/", "teams", "core")],
    nav: {},
    collections,
    data: {},
  };
}

test("record props carry only public fields, derived values, and relation fields", () => {
  const props = recordPropsOf(site(), page("/people/ada/", "people", "ada"));
  assert.ok(props);
  assert.deepEqual(props.fields, { id: "ada", title: "Ada", author: { name: "Ada" }, team: "core", daysLeft: 3 });
  assert.deepEqual(props.derived, { daysLeft: 3 });
  assert.deepEqual(props.links, { team: "/teams/core/" });
  assert.deepEqual(props.related, {
    team: [{ collection: "teams", id: "core", url: "/teams/core/", fields: { id: "core", name: "Core" } }],
  });
  assert.equal(JSON.stringify(props).includes("ada@example.test"), false);
  assert.equal(JSON.stringify(props).includes("internalBudget"), false);
});

test("a record template sees no private value through a field directive or records block", async () => {
  const root = new URL("../test/fixtures/public-fields-none", import.meta.url).pathname;
  const template: Template = {
    collection: "people",
    path: "_templates/person.md",
    frontMatter: { title: "{title}" },
    body: [
      "# {title}",
      "",
      ":field[title]",
      "",
      ":field[author.email]",
      "",
      ":::records{from=teams}",
      ":field[name] :field[internalBudget]",
      ":::",
    ].join("\n"),
    bodyLine: 1,
    localized: {},
  };
  const result = await buildRecordPages({
    root,
    config: config(["title", "author.name", "team"]),
    collections: site().collections,
    templates: { people: template },
    views: {},
  });
  assert.equal(result.pages.length, 1);
  const markdown = result.pages[0]!.markdown;
  assert.match(markdown, /Ada/);
  assert.equal(markdown.includes("ada@example.test"), false);
  assert.equal(markdown.includes("42"), false);
  assert.equal(JSON.stringify(result.diagnostics).includes("ada@example.test"), false);
});
