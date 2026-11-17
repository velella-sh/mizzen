import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildApiReferencePages } from "../../src/api-reference/pages.ts";
import { readApiReference, type ApiDocument } from "../../src/api-reference/read.ts";
import type { NavGroup, NavItem, NavLink } from "../../src/contracts/nav.ts";

const fixture = readFileSync(new URL("../../fixtures/api-reference/openapi.yaml", import.meta.url), "utf8");

/** The fixture's document; every test here starts from a read that must succeed. */
function document(): ApiDocument {
  const read = readApiReference(fixture, "fixtures/api-reference/openapi.yaml");
  assert.deepEqual(read.diagnostics, []);
  assert.ok(read.document !== undefined);
  return read.document;
}

/** The group titled `title`, or a failure. */
function group(items: readonly NavItem[], title: string): NavGroup {
  const found = items.find((item): item is NavGroup => "children" in item && item.title === title);
  if (found === undefined) throw new Error(`No navigation group "${title}".`);
  return found;
}

/** The links of a group, in order. */
function links(navGroup: NavGroup): readonly NavLink[] {
  return navGroup.children.filter((item): item is NavLink => !("children" in item));
}

test("builds one page and navigation entry per operation", () => {
  const built = buildApiReferencePages(document());
  assert.deepEqual(built.diagnostics, []);
  assert.deepEqual(
    built.pages.map((page) => page.url),
    [
      "/reference/createComponent/",
      "/reference/deleteComponent/",
      "/reference/getComponent/",
      "/reference/listComponents/",
      "/reference/listReleases/",
    ],
  );
  assert.deepEqual(
    built.pages.map((page) => page.title),
    [
      "Create a component",
      "Delete a component",
      "Get a component",
      "List components",
      "List releases",
    ],
  );
  assert.deepEqual(
    built.navigation.map((item) => item.title),
    ["Components", "Releases"],
  );
  assert.deepEqual(
    links(group(built.navigation, "Components")).map((item) => item.url),
    [
      "/reference/createComponent/",
      "/reference/deleteComponent/",
      "/reference/getComponent/",
      "/reference/listComponents/",
    ],
  );
  assert.deepEqual(
    links(group(built.navigation, "Releases")).map((item) => item.url),
    ["/reference/listReleases/"],
  );
});

test("gives each page the text search reads from it", () => {
  const built = buildApiReferencePages(document());
  const list = built.pages.find((page) => page.operation.id === "listComponents");
  assert.ok(list !== undefined);
  assert.match(list.description ?? "", /^Lists every component that matches the filters/);
  assert.match(list.text, /List components/);
  assert.match(list.text, /GET \/components/);
  assert.match(list.text, /Components/);
  assert.match(list.text, /region/);
  assert.match(list.text, /Return only components in this region\./);
  assert.match(list.text, /application\/json/);
  assert.match(list.text, /200/);
  assert.match(list.text, /Every component that matches the filters\./);

  const create = built.pages.find((page) => page.operation.id === "createComponent");
  assert.ok(create !== undefined);
  assert.match(create.text, /Request body/);
  assert.match(create.text, /The component to add\./);
  assert.match(create.text, /tooltip/);
});

test("the same pages come out when the operations arrive in another order", () => {
  const source = document();
  const reordered: ApiDocument = { ...source, operations: [...source.operations].reverse() };
  assert.deepEqual(buildApiReferencePages(reordered), buildApiReferencePages(source));
});

test("rejects two operation ids that are equal after case folding", () => {
  const source = document();
  const first = source.operations[0]!;
  const duplicate = { ...source.operations[1]!, id: first.id.toUpperCase() };
  const built = buildApiReferencePages({ ...source, operations: [first, duplicate] });
  assert.deepEqual(built.pages, []);
  assert.deepEqual(built.navigation, []);
  assert.deepEqual(built.diagnostics.map((diagnostic) => diagnostic.id), ["api-reference.duplicate-id"]);
  assert.match(built.diagnostics[0]!.message, new RegExp(first.id, "i"));
});

test("puts an untagged operation at the top level of the navigation", () => {
  const read = readApiReference(
    `openapi: 3.1.0
info:
  title: Small API
  version: "1.0"
paths:
  /ping:
    get:
      operationId: ping
      responses:
        "204":
          description: pong
`,
    "openapi.yaml",
  );
  assert.ok(read.document !== undefined);
  const built = buildApiReferencePages({ ...read.document, operations: [{ ...read.document.operations[0]!, tags: [] }] });
  assert.deepEqual(built.pages.map((page) => page.title), ["GET /ping"]);
  assert.deepEqual(built.navigation, [{ title: "GET /ping", url: "/reference/ping/" }]);
});
