import assert from "node:assert/strict";
import { test } from "node:test";
import { buildModel } from "../src/model/build.ts";
import { ids, pageAt, withSite } from "./data-record-site.ts";

const GREGORIAN = {
  "mizzen.yml":
    "collections:\n" +
    "  posts:\n" +
    "    source: _data/posts.yml\n" +
    "    template: _templates/posts.md\n" +
    "    permalink: /posts/{id}/\n" +
    "    dates: [released]\n",
  "_data/posts.yml": '- id: release\n  name: Release\n  released: "2026-03-15"\n',
  "_templates/posts.md":
    '---\ntitle: "{name}"\n---\n' +
    "Short: :field[released]{format=short}\n\n" +
    "Long: :field[released]{format=long}\n\n" +
    "Full: :field[released]{format=full}\n\n" +
    "Raw: :field[released]\n",
};

test("short, long, and full write the date and keep the field's source span", async () => {
  await withSite(GREGORIAN, (_root, result) => {
    assert.deepEqual(result.diagnostics, []);
    const page = pageAt(result, "/posts/release/")!;
    assert.match(page.html, /Short: <span data-src="_data\/posts\.yml:3:13-3:24">2026-03-15<\/span>/);
    assert.match(page.html, /Long: <span data-src="_data\/posts\.yml:3:13-3:24">15 March 2026<\/span>/);
    assert.match(page.html, /Full: <span data-src="_data\/posts\.yml:3:13-3:24">Sunday, 15 March 2026<\/span>/);
    assert.match(page.markdown, /Short: 2026-03-15/);
    assert.match(page.markdown, /Long: 15 March 2026/);
    assert.match(page.markdown, /Full: Sunday, 15 March 2026/);
    assert.equal(page.dates, true);
  });
});

test("a no-format field prints the value as written", async () => {
  await withSite(GREGORIAN, (_root, result) => {
    const page = pageAt(result, "/posts/release/")!;
    assert.match(page.html, /Raw: <span data-src="_data\/posts\.yml:3:13-3:24">2026-03-15<\/span>/);
    assert.match(page.markdown, /Raw: 2026-03-15/);
  });
});

test("a Persian site with the Jalali calendar writes the day in Jalali", async () => {
  await withSite(
    {
      "mizzen.yml":
        "lang: fa\n" +
        "dates:\n" +
        "  calendar: jalali\n" +
        "collections:\n" +
        "  posts:\n" +
        "    source: _data/posts.yml\n" +
        "    template: _templates/posts.md\n" +
        "    permalink: /posts/{id}/\n" +
        "    dates: [released]\n",
      "_data/posts.yml": '- id: nowruz\n  name: Nowruz\n  released: "2026-03-21"\n',
      "_templates/posts.md":
        '---\ntitle: "{name}"\n---\n' +
        "Long: :field[released]{format=long}\n\n" +
        "Short: :field[released]{format=short}\n",
    },
    (_root, result) => {
      assert.deepEqual(result.diagnostics, []);
      const page = pageAt(result, "/posts/nowruz/")!;
      assert.match(page.html, /Long: <span data-src="_data\/posts\.yml:3:13-3:24">۱ فروردین ۱۴۰۵<\/span>/);
      assert.match(page.html, /Short: <span data-src="_data\/posts\.yml:3:13-3:24">۱۴۰۵-۰۱-۰۱<\/span>/);
      assert.match(page.markdown, /Long: ۱ فروردین ۱۴۰۵/);
      assert.match(page.markdown, /Short: ۱۴۰۵-۰۱-۰۱/);
    },
  );
});

test("a partial date is written to its precision", async () => {
  await withSite(
    {
      "mizzen.yml":
        "collections:\n" +
        "  posts:\n" +
        "    source: _data/posts.yml\n" +
        "    template: _templates/posts.md\n" +
        "    permalink: /posts/{id}/\n",
      // A partial value is not a whole day, so the collection does not declare it under `dates`.
      "_data/posts.yml": '- id: partial\n  name: Partial\n  month: "2026-03"\n  year: "2026"\n',
      "_templates/posts.md":
        '---\ntitle: "{name}"\n---\n' +
        "Month: :field[month]{format=long}\n\n" +
        "Year: :field[year]{format=long}\n",
    },
    (_root, result) => {
      assert.deepEqual(result.diagnostics, []);
      const page = pageAt(result, "/posts/partial/")!;
      assert.match(page.html, /Month: <span[^>]*>March 2026<\/span>/);
      assert.match(page.html, /Year: <span[^>]*>2026<\/span>/);
      assert.match(page.markdown, /Month: March 2026/);
      assert.match(page.markdown, /Year: 2026/);
    },
  );
});

test("a format on a field that is not a date is an error and leaves the directive", async () => {
  await withSite(
    {
      "mizzen.yml":
        "collections:\n" +
        "  posts:\n" +
        "    source: _data/posts.yml\n" +
        "    template: _templates/posts.md\n" +
        "    permalink: /posts/{id}/\n",
      "_data/posts.yml": '- id: release\n  name: Button\n  released: "2026-03-15"\n',
      "_templates/posts.md": '---\ntitle: "{name}"\n---\nText: :field[name]{format=short}\n',
    },
    (_root, result) => {
      assert.deepEqual(ids(result), ["data.field-not-date"]);
      assert.equal(result.diagnostics[0]!.pos?.file, "_templates/posts.md");
      assert.equal(result.diagnostics[0]!.pos?.line, 4);
      const page = pageAt(result, "/posts/release/")!;
      assert.match(page.html, /Text: :field\[name\]<\/p>/);
      assert.match(page.markdown, /Text: :field\[name\]/);
    },
  );
});

test("a format name outside short, long, and full is an error", async () => {
  await withSite(
    {
      "mizzen.yml":
        "collections:\n" +
        "  posts:\n" +
        "    source: _data/posts.yml\n" +
        "    template: _templates/posts.md\n" +
        "    permalink: /posts/{id}/\n",
      "_data/posts.yml": '- id: release\n  name: Release\n  released: "2026-03-15"\n',
      "_templates/posts.md": '---\ntitle: "{name}"\n---\nTiny: :field[released]{format=tiny}\n',
    },
    (_root, result) => {
      assert.deepEqual(ids(result), ["data.field-format"]);
      assert.match(result.diagnostics[0]!.message, /tiny/);
      const page = pageAt(result, "/posts/release/")!;
      assert.match(page.html, /Tiny: :field\[released\]<\/p>/);
    },
  );
});

test("page.dates is set by a formatted date or a printed date field, not by a text field", async () => {
  const template = (body: string) => `---\ntitle: "{title}"\n---\n${body}\n`;
  await withSite(
    {
      "mizzen.yml":
        "collections:\n" +
        "  formatted:\n    source: _data/formatted.yml\n    template: _templates/formatted.md\n    permalink: /formatted/{id}/\n    dates: [released]\n" +
        "  raw:\n    source: _data/raw.yml\n    template: _templates/raw.md\n    permalink: /raw/{id}/\n    dates: [released]\n" +
        "  plain:\n    source: _data/plain.yml\n    template: _templates/plain.md\n    permalink: /plain/{id}/\n    dates: [released]\n",
      "_data/formatted.yml": '- id: one\n  title: Formatted\n  released: "2026-03-15"\n',
      "_data/raw.yml": '- id: two\n  title: Raw\n  released: "2026-03-15"\n',
      "_data/plain.yml": '- id: three\n  title: Plain\n  name: Button\n  released: "2026-03-15"\n',
      "_templates/formatted.md": template("Date: :field[released]{format=long}"),
      "_templates/raw.md": template("Date: :field[released]"),
      "_templates/plain.md": template("Name: :field[name]"),
    },
    (_root, result) => {
      assert.deepEqual(ids(result), []);
      assert.equal(pageAt(result, "/formatted/one/")!.dates, true);
      assert.equal(pageAt(result, "/raw/two/")!.dates, true);
      assert.equal(pageAt(result, "/plain/three/")!.dates, undefined);
    },
  );
});

test("the formatted text is the same on a second build", async () => {
  await withSite(GREGORIAN, async (root, result) => {
    const again = await buildModel(root);
    const first = pageAt(result, "/posts/release/")!;
    const second = pageAt(again, "/posts/release/")!;
    assert.equal(second.html, first.html);
    assert.equal(second.markdown, first.markdown);
    assert.match(second.html, /Full: <span[^>]*>Sunday, 15 March 2026<\/span>/);
  });
});
