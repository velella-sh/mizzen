import assert from "node:assert/strict";
import { test } from "node:test";
import type { DataRecord } from "../src/contracts/index.ts";
import { loadConfigText } from "../src/config/load.ts";
import {
  isPublicPath,
  isPublicReference,
  publicFields,
  publicRecord,
  publicReferenceDiagnostics,
  publicReferencesIn,
} from "../src/data/public.ts";

const pos = { file: "_data/people.yml", startLine: 1, startColumn: 1, endLine: 9, endColumn: 1 };

function record(fields: Record<string, unknown>, derived?: Record<string, unknown>): DataRecord {
  return { id: "ada", fields, position: pos, fieldPositions: {}, ...(derived === undefined ? {} : { derived }) };
}

test("a collection without a policy keeps every field and the same object", () => {
  const fields = { title: "Ada", secret: "x" };
  assert.equal(publicFields(fields, undefined), fields);
  assert.equal(isPublicPath(undefined, "secret"), true);
  assert.equal(isPublicReference(undefined, "secret"), true);
});

test("a nested allowlist keeps declared leaves and containers, and drops their siblings", () => {
  const fields = {
    id: "ada",
    title: "Ada",
    author: { name: "Ada", email: "ada@example.test" },
    tags: [{ name: "math", privateNote: "x" }],
    secret: "q",
  };
  assert.deepEqual(publicFields(fields, ["title", "author.name", "tags.name"]), {
    id: "ada",
    title: "Ada",
    author: { name: "Ada" },
    tags: [{ name: "math" }],
  });
  assert.deepEqual(publicFields(fields, []), { id: "ada" });
  assert.deepEqual(publicFields(fields, ["author"]), {
    id: "ada",
    author: { name: "Ada", email: "ada@example.test" },
  });
});

test("a policy that names a leaf the record does not hold matches nothing", () => {
  assert.deepEqual(publicFields({ title: "Ada" }, ["author.name"]), {});
});

test("publicRecord projects fields and derived values without changing the internal record", () => {
  const internal = record(
    { id: "ada", title: "Ada", secret: "q" },
    { daysLeft: 3, secretLeft: 4 },
  );
  const view = publicRecord(internal, ["title", "daysLeft"]);
  assert.deepEqual(view.fields, { id: "ada", title: "Ada" });
  assert.deepEqual(view.derived, { daysLeft: 3 });
  assert.deepEqual(internal.fields, { id: "ada", title: "Ada", secret: "q" });
  assert.equal(view.id, "ada");
  assert.equal(view.position, pos);
});

test("a path is readable from an ancestor, but only a covered path is publishable in full", () => {
  const policy = ["author.name"];
  assert.equal(isPublicPath(policy, "author"), true);
  assert.equal(isPublicPath(policy, "author.name"), true);
  assert.equal(isPublicPath(policy, "author.email"), false);
  assert.equal(isPublicReference(policy, "author.name"), true);
  assert.equal(isPublicReference(policy, "author"), false);
  assert.equal(isPublicReference(policy, "id"), true);
});

test("references are read from placeholders and field directives, and literal braces are ignored", () => {
  const text = "# {title}\n\n{{literal}} {author.name|slug} :field[author.email] :field[author.email]";
  assert.deepEqual(publicReferencesIn(text), ["title", "author.name", "author.email"]);
});

test("a public setting that references a private field is one finding per path", () => {
  const found = publicReferenceDiagnostics(
    "people",
    ["title", "author.name"],
    ["title", "author.name", "author.email", "author.email", "author"],
    "`seo.jsonLd`",
    { file: "mizzen.yml", line: 4, column: 1, endLine: 4, endColumn: 1 },
  );
  assert.deepEqual(found.map((d) => d.id), ["data.public-reference", "data.public-reference"]);
  assert.match(found[0]!.message, /author\.email/);
  assert.match(found[1]!.message, /"author"/);
  assert.equal(publicReferenceDiagnostics("people", undefined, ["secret"], "a permalink").length, 0);
  assert.equal(publicReferenceDiagnostics("people", ["id"], ["id"], "a permalink").length, 0);
});

test("the config loader keeps public as an ordered list and leaves an absent policy absent", () => {
  const declared = loadConfigText(
    "collections:\n  people:\n    source: _data/people.yml\n    public: [title, author.name]\n",
    "mizzen.yml",
    "Site",
  );
  assert.deepEqual(declared.config.collections.people?.public, ["title", "author.name"]);
  const absent = loadConfigText(
    "collections:\n  people:\n    source: _data/people.yml\n",
    "mizzen.yml",
    "Site",
  );
  assert.equal(absent.config.collections.people?.public, undefined);
  assert.equal(declared.diagnostics.length, 0);
});
