import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { loadConfigText } from "../src/config/load.ts";
import { loadTemplates } from "../src/data/template.ts";

test("public settings that name a private field are rejected before the build", () => {
  const result = loadConfigText(
    [
      "title: Site",
      "collections:",
      "  people:",
      "    source: _data/people.yml",
      "    template: _templates/person.md",
      "    permalink: /people/{author.email}/",
      "    public: [title, author.name]",
      "    seo:",
      "      canonical: secret",
      "      noindex: hidden",
      "      lastmod: publishedAt",
      "      jsonLd:",
      '        "@type": Person',
      '        name: "{title}"',
      '        email: "{author.email}"',
      "    search:",
      "      filters: [title, secret]",
      "      sort: [publishedAt]",
      "      meta: [secret]",
      "      aliases: oldId",
      "    json:",
      "      fields: [title, secret]",
      "    index:",
      "      fields: [title, secret]",
      "api:",
      "  collections:",
      "    people:",
      "      fields: [title, secret]",
      "feeds:",
      "  people:",
      "    collection: people",
      "    date: publishedAt",
      "    fields: [title, secret]",
      "    idField: secret",
      "",
    ].join("\n"),
    "mizzen.yml",
    "Site",
  );
  const errors = result.diagnostics.filter((finding) => finding.id === "data.public-reference");
  const messages = errors.map((finding) => finding.message).join("\n");
  for (const field of ["author.email", "secret", "hidden", "publishedAt", "oldId"]) {
    assert.match(messages, new RegExp(`"${field}"`), field);
  }
  assert.equal(errors.every((finding) => finding.severity === "error"), true);
});

test("a public setting that names only allowed fields reports nothing", () => {
  const result = loadConfigText(
    [
      "title: Site",
      "collections:",
      "  people:",
      "    source: _data/people.yml",
      "    template: _templates/person.md",
      "    permalink: /people/{title}/",
      "    public: [id, title, author.name, publishedAt]",
      "    seo:",
      "      canonical: title",
      '      jsonLd: { "@type": Person, name: "{author.name}" }',
      "    search:",
      "      filters: [title]",
      "      sort: [publishedAt]",
      "",
    ].join("\n"),
    "mizzen.yml",
    "Site",
  );
  assert.deepEqual(result.diagnostics.filter((finding) => finding.id === "data.public-reference"), []);
});

test("a template directive or front-matter placeholder that names a private field is reported", async () => {
  const root = mkdtempSync(join(tmpdir(), "public-template-"));
  try {
    mkdirSync(join(root, "_templates"), { recursive: true });
    writeFileSync(
      join(root, "_templates", "person.md"),
      ["---", 'title: "{secret}"', "---", "", ":field[title]", ":field[author.email]", ":::each{field=secret}", "x", ":::", ""].join("\n"),
    );
    const config = loadConfigText(
      [
        "title: Site",
        "collections:",
        "  people:",
        "    source: _data/people.yml",
        "    template: _templates/person.md",
        "    permalink: /people/{id}/",
        "    public: [title, author.name]",
        "",
      ].join("\n"),
      "mizzen.yml",
      "Site",
    ).config;
    const loaded = await loadTemplates({ root, config });
    const errors = loaded.diagnostics.filter((finding) => finding.id === "data.public-reference");
    const messages = errors.map((finding) => finding.message).join("\n");
    assert.match(messages, /"secret"/);
    assert.match(messages, /author\.email/);
    assert.equal(errors.every((finding) => finding.severity === "error"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
