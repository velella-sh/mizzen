import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { convertVitePress } from "../../src/import/vitepress/components.ts";

function fixture(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../../fixtures/import-vitepress/${path}`, import.meta.url)), "utf8");
}

test("the fixture page converts to the recorded answer", () => {
  const converted = convertVitePress(fixture("source/deploy.md"), { Badge: "badge" });
  assert.equal(converted.markdown, fixture("expected/deploy.md"));
  assert.equal(converted.dynamic.length, 1);
  assert.equal(converted.dynamic[0]?.line, 19);
  assert.match(converted.dynamic[0]?.text ?? "", /ReleaseNotes/u);
});

test("each built-in container becomes its directive and keeps its body and title", () => {
  const source = ["::: tip Run", "a", ":::", "::: info", "b", ":::", "::: warning T", "c", ":::", "::: danger", "d", ":::", "::: details Open", "e", ":::", "::: details", "f", ":::"].join("\n");
  const converted = convertVitePress(`${source}\n`);
  assert.equal(
    converted.markdown,
    [":::tip[Run]", "a", ":::", ":::note", "b", ":::", ":::warning[T]", "c", ":::", ":::danger", "d", ":::", ':::details{title="Open"}', "e", ":::", ":::details", "f", ":::", ""].join("\n"),
  );
  assert.deepEqual(converted.dynamic, []);
});

test("a mapped component with children becomes a container directive and keeps their Markdown", () => {
  const source = ['<Badge text="Beta">', "Read the [notes](./releases.md).", "</Badge>", ""].join("\n");
  const converted = convertVitePress(source, { Badge: "badge" });
  assert.equal(converted.markdown, [':::badge{text="Beta"}', "Read the [notes](./releases.md).", ":::", ""].join("\n"));
});

test("an unmapped component and an interpolation keep their text and report their place", () => {
  const source = ["# Notes", "", '<ReleaseNotes :version="version">', "Run {{ channel }} now.", "</ReleaseNotes>", ""].join("\n");
  const converted = convertVitePress(source, { Other: "other" });
  assert.equal(converted.markdown, ["# Notes", "", "Run  now.", ""].join("\n"));
  assert.deepEqual(
    converted.dynamic.map((part) => [part.line, part.column]),
    [[3, 1], [4, 5]],
  );
});

test("code fences keep their text unchanged", () => {
  const source = ["```md", "::: tip Not a container", "{{ notAnExpression }}", "```", ""].join("\n");
  assert.equal(convertVitePress(source).markdown, source);
});
