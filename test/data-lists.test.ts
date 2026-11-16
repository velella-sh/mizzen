import assert from "node:assert/strict";
import { test } from "node:test";
import { buildModel } from "../src/model/build.ts";
import { ids, pageAt, withSite } from "./data-record-site.ts";

const DATA = [
  "- id: a",
  "  title: Alpha",
  "  status: published",
  "  date: 2026-01-05",
  "- id: b",
  "  title: Beta",
  "  status: draft",
  "  date: 2026-02-10",
  "- id: c",
  "  title: Gamma",
  "  status: published",
  "  date: 2026-03-01",
  "",
].join("\n");

const CONFIG = [
  "collections:",
  "  posts:",
  "    source: _data/posts.yml",
  "    template: _templates/posts.md",
  "    permalink: /posts/{id}/",
  "    dates: [date]",
  "",
].join("\n");

const TEMPLATE = "---\ntitle: \"{title}\"\n---\n# :field[title]\n";

/** A site with the posts collection and one page, plus the extra files a test adds. */
const files = (body: string, page = "# Blog\n"): Record<string, string> => ({
  "mizzen.yml": CONFIG,
  "_data/posts.yml": DATA,
  "_templates/posts.md": TEMPLATE,
  "blog/index.md": `---\ntitle: Blog\n${body}---\n${page}`,
});

test("a list page selects and sorts records, and page two carries the rest", async () => {
  await withSite(
    files("list:\n  collection: posts\n  where: { status: published }\n  sort: date desc\n  perPage: 1\n  fields: [title, date]\n"),
    (_root, result) => {
      assert.deepEqual(result.diagnostics, []);
      const first = pageAt(result, "/blog/")!;
      const second = pageAt(result, "/blog/page/2/")!;
      assert.equal(first.frontMatter.layout, "list");
      assert.deepEqual(first.list?.records.map((record) => record.id), ["c"]);
      assert.deepEqual(second.list?.records.map((record) => record.id), ["a"]);
      assert.deepEqual(first.list?.pagination, { page: 1, total: 2, next: "/blog/page/2/" });
      assert.deepEqual(second.list?.pagination, { page: 2, total: 2, previous: "/blog/" });
      assert.deepEqual(Object.keys(first.list!.records[0]!.fields), ["title", "date"]);
      assert.equal(first.list?.records[0]?.url, "/posts/c/");
      assert.match(first.markdown, /\| \[Gamma\]\(\/posts\/c\/\) \| 2026-03-01 \|/);
      assert.match(second.markdown, /Alpha/);
      assert.doesNotMatch(second.markdown, /Gamma/);
    },
  );
});

test("a repeated value in a grouped list appears once in the group and in its twin", async () => {
  await withSite(
    {
      ...files("list:\n  collection: posts\n  group: tags\n  fields: [title]\n"),
      "_data/posts.yml": "- id: a\n  title: Alpha\n  status: published\n  tags: [news, news]\n",
    },
    (_root, result) => {
      assert.deepEqual(result.diagnostics, []);
      const page = pageAt(result, "/blog/")!;
      assert.deepEqual(page.list?.groups.map((group) => [group.key, group.records.length]), [["news", 1]]);
      assert.equal((page.markdown.match(/\[Alpha\]/g) ?? []).length, 1);
    },
  );
});

test("a list without the key leaves the page an ordinary page", async () => {
  await withSite(
    {
      "mizzen.yml": CONFIG,
      "_data/posts.yml": DATA,
      "_templates/posts.md": TEMPLATE,
      "blog/index.md": "---\ntitle: Blog\n---\n# Blog\n",
    },
    (_root, result) => {
      assert.deepEqual(result.diagnostics, []);
      assert.equal(pageAt(result, "/blog/")?.list, undefined);
    },
  );
});

test("the declaration reports an unknown collection and a bad page size at the list key", async () => {
  await withSite(files("list:\n  collection: missing\n"), (_root, result) => {
    const finding = result.diagnostics.find((diagnostic) => diagnostic.id === "data.list-collection");
    assert.ok(finding);
    assert.equal(finding.pos?.file, "blog/index.md");
    assert.equal(finding.pos?.line, 3);
    assert.equal(pageAt(result, "/blog/")?.list, undefined);
  });
  await withSite(files("list:\n  collection: posts\n  perPage: 0\n"), (_root, result) => {
    assert.deepEqual(ids(result), ["data.list-shape"]);
  });
  await withSite(files("list:\n  collection: posts\n  fields: title\n  splitGroups: yes\n"), (_root, result) => {
    assert.deepEqual(ids(result), ["data.list-shape", "data.list-shape"]);
  });
  await withSite(files("list: posts\n"), (_root, result) => {
    assert.deepEqual(ids(result), ["data.list-shape"]);
  });
  await withSite(files("list: {}\n"), (_root, result) => {
    assert.deepEqual(ids(result), ["data.list-shape"]);
  });
});

test("an empty list is a warning that names the filter, and still writes the page", async () => {
  await withSite(files("list:\n  collection: posts\n  where: { status: archived }\n"), (_root, result) => {
    const finding = result.diagnostics.find((diagnostic) => diagnostic.id === "data.list-empty");
    assert.ok(finding);
    assert.equal(finding.severity, "warning");
    assert.match(finding.message, /status=archived/);
    assert.deepEqual(pageAt(result, "/blog/")?.list?.records, []);
  });
});

test("a where, sort, or group field no record holds is a warning at the list key", async () => {
  await withSite(files("list:\n  collection: posts\n  where: { nope: x }\n  sort: nope\n  group: absent\n"), (_root, result) => {
    const findings = result.diagnostics.filter((diagnostic) => diagnostic.id === "data.list-field");
    assert.deepEqual(findings.map((finding) => finding.severity), ["warning", "warning"]);
    assert.match(findings.map((finding) => finding.message).join("\n"), /"nope"/);
    assert.match(findings.map((finding) => finding.message).join("\n"), /"absent"/);
  });
});

test("fields and expand.field that no record holds are warnings at the list key", async () => {
  await withSite(
    files(
      "list:\n" +
        "  collection: posts\n" +
        "  fields: [nope]\n" +
        "  expand:\n" +
        "    field: absent\n" +
        '    permalink: "/tags/{value}/"\n',
    ),
    (_root, result) => {
      const findings = result.diagnostics.filter((diagnostic) => diagnostic.id === "data.list-field");
      assert.deepEqual(findings.map((finding) => finding.severity), ["warning", "warning"]);
      assert.match(findings.map((finding) => finding.message).join("\n"), /"nope"/);
      assert.match(findings.map((finding) => finding.message).join("\n"), /"absent"/);
      assert.ok(findings.every((finding) => finding.pos?.line === 3));
    },
  );
});

test("a sort direction that is not asc or desc is a sort error, not a missing field", async () => {
  await withSite(files("list:\n  collection: posts\n  sort: title descending\n"), (_root, result) => {
    assert.deepEqual(ids(result), ["data.list-sort"]);
  });
});

test("two list keys on one page are invalid YAML, so a page has one list", async () => {
  await withSite(
    files("list:\n  collection: posts\nlist:\n  collection: posts\n"),
    (_root, result) => {
      assert.deepEqual(ids(result), ["frontmatter.invalid-yaml"]);
      assert.equal(pageAt(result, "/blog/")?.list, undefined);
    },
  );
});

test("a list with languages reads the fields of its own page language", async () => {
  await withSite(
    {
      "mizzen.yml": `${CONFIG}`.replace("    dates: [date]", "    dates: [date]\nlanguages:\n  - code: fa\n    name: فارسی\n    prefix: /fa"),
      "_data/posts.yml": DATA,
      "_templates/posts.md": TEMPLATE,
      "blog/index.md": "---\ntitle: Blog\nlist: { collection: posts, sort: date }\n---\n# Blog\n",
      "fa/blog/index.md": "---\ntitle: وبلاگ\nlang: fa\nlist: { collection: posts, sort: date }\n---\n# وبلاگ\n",
    },
    (_root, result) => {
      assert.deepEqual(result.diagnostics, []);
      assert.equal(pageAt(result, "/blog/")?.lang, "en");
      const fa = pageAt(result, "/fa/blog/")!;
      assert.equal(fa.lang, "fa");
      assert.deepEqual(fa.list?.records.map((record) => record.url), ["/fa/posts/a/", "/fa/posts/b/", "/fa/posts/c/"]);
    },
  );
});
