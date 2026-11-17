import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  readApiReference,
  type ApiOperation,
  type ApiReferenceRead,
} from "../../src/api-reference/read.ts";

const fixture = readFileSync(new URL("../../fixtures/api-reference/openapi.yaml", import.meta.url), "utf8");

/** One operation from a read that must have a document. */
function operation(read: ApiReferenceRead, id: string): ApiOperation {
  const found = read.document?.operations.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`No operation "${id}".`);
  return found;
}

/** A minimal document whose one response is `response`. */
function spec(response: string): string {
  return `openapi: 3.1.0
info:
  title: Test API
  version: "1.0"
paths:
  /things:
    get:
      operationId: listThings
      responses:
        "200": ${response}
`;
}

test("reads the pinned fixture into a deterministic operation model", () => {
  const read = readApiReference(fixture, "fixtures/api-reference/openapi.yaml");
  assert.deepEqual(read.diagnostics, []);
  const document = read.document;
  assert.ok(document !== undefined);
  assert.equal(document.title, "Catalogue API");
  assert.equal(document.version, "1.0.0");
  assert.match(document.description ?? "", /interface parts/);
  assert.deepEqual(
    document.operations.map((entry) => entry.id),
    ["createComponent", "deleteComponent", "getComponent", "listComponents", "listReleases"],
  );
  assert.deepEqual(
    document.operations.map((entry) => entry.url),
    [
      "/reference/createComponent/",
      "/reference/deleteComponent/",
      "/reference/getComponent/",
      "/reference/listComponents/",
      "/reference/listReleases/",
    ],
  );
});

test("normalizes parameters, examples, content, and shared responses", () => {
  const read = readApiReference(fixture, "fixtures/api-reference/openapi.yaml");
  const list = operation(read, "listComponents");
  assert.equal(list.method, "get");
  assert.equal(list.path, "/components");
  assert.equal(list.title, "List components");
  assert.deepEqual(list.tags, ["Components"]);
  assert.equal(list.deprecated, false);
  assert.equal(list.server, "https://api.example.com/v1");
  assert.deepEqual(
    list.parameters.map((parameter) => parameter.name),
    ["limit", "region", "status"],
  );
  const region = list.parameters[1]!;
  assert.deepEqual(region.examples, [{ name: "example", value: "north" }]);
  assert.deepEqual(region.schema.enum, ["north", "coastal", "central", "south"]);
  assert.equal(list.parameters[0]!.schema.default, 20);

  assert.deepEqual(
    list.responses.map((response) => response.status),
    ["200", "400"],
  );
  const ok = list.responses[0]!;
  assert.equal(ok.content[0]!.type, "application/json");
  assert.equal(ok.content[0]!.schema?.type, "array");
  assert.deepEqual(ok.content[0]!.examples.map((example) => example.name), ["two"]);
  const bad = list.responses[1]!;
  assert.equal(bad.description, "The request was not a valid component.");
  assert.equal(bad.content[0]!.schema?.properties[0]!.name, "code");

  const get = operation(read, "getComponent");
  assert.deepEqual(
    get.parameters.map((parameter) => [parameter.name, parameter.in, parameter.required]),
    [["slug", "path", true]],
  );
  assert.deepEqual(get.parameters[0]!.examples, [{ name: "example", value: "button" }]);

  const create = operation(read, "createComponent");
  assert.equal(create.requestBody?.required, true);
  assert.equal(create.requestBody?.content[0]!.schema?.properties.find((p) => p.name === "region")?.schema.enum![0], "north");
  assert.deepEqual(create.requestBody?.content[0]!.examples.map((example) => example.name), ["tooltip"]);
  assert.equal(create.responses[0]!.status, "201");

  const remove = operation(read, "deleteComponent");
  assert.equal(remove.responses[0]!.status, "204");
  assert.deepEqual(remove.responses[0]!.content, []);
  assert.equal(remove.responses[1]!.status, "404");

  const releases = operation(read, "listReleases");
  assert.equal(releases.deprecated, true);
  assert.deepEqual(releases.responses[0]!.content[0]!.examples, []);

  const component = list.responses[0]!.content[0]!.schema?.items;
  assert.deepEqual(
    component?.properties.map((property) => property.name),
    ["name", "region", "released", "slug", "status", "summary"],
  );
  assert.deepEqual(component?.required, ["name", "region", "released", "slug", "status"]);
  assert.deepEqual(component?.properties.find((p) => p.name === "released")?.schema.type, ["string", "null"]);
});

test("reports an external reference", () => {
  const read = readApiReference(spec('{ $ref: "./shared.yaml#/components/responses/Ok" }'), "openapi.yaml");
  assert.equal(read.document, undefined);
  assert.deepEqual(read.diagnostics.map((diagnostic) => diagnostic.id), ["api-reference.reference-external"]);
  assert.match(read.diagnostics[0]!.message, /shared\.yaml/);
  assert.equal(read.diagnostics[0]!.pos?.line, 10);
});

test("reports a missing pointer", () => {
  const read = readApiReference(spec('{ $ref: "#/components/responses/Absent" }'), "openapi.yaml");
  assert.equal(read.document, undefined);
  assert.deepEqual(read.diagnostics.map((diagnostic) => diagnostic.id), ["api-reference.reference-missing"]);
});

test("reports a reference cycle", () => {
  const text = `${spec('{ $ref: "#/components/responses/A" }')}components:
  responses:
    A:
      $ref: "#/components/responses/B"
    B:
      $ref: "#/components/responses/A"
`;
  const read = readApiReference(text, "openapi.yaml");
  assert.equal(read.document, undefined);
  assert.deepEqual(read.diagnostics.map((diagnostic) => diagnostic.id), ["api-reference.reference-cycle"]);
});

test("reports a reference of the wrong kind", () => {
  const text = `${spec('{ $ref: "#/components/schemas/Thing" }')}components:
  schemas:
    Thing:
      type: string
`;
  const read = readApiReference(text, "openapi.yaml");
  assert.equal(read.document, undefined);
  assert.deepEqual(read.diagnostics.map((diagnostic) => diagnostic.id), ["api-reference.reference-kind"]);
});

test("reports a whole path item reference as out of scope", () => {
  const text = `openapi: 3.1.0
info:
  title: Test API
  version: "1.0"
paths:
  /things:
    $ref: "#/components/pathItems/Thing"
components:
  pathItems:
    Thing:
      get:
        operationId: listThings
        responses:
          "200":
            description: ok
`;
  const read = readApiReference(text, "openapi.yaml");
  assert.equal(read.document, undefined);
  assert.deepEqual(read.diagnostics.map((diagnostic) => diagnostic.id), ["api-reference.reference-kind"]);
  assert.match(read.diagnostics[0]!.message, /whole path item/);
});

test("normalizes a 3.0 nullable type and warns on composition", () => {
  const text = `openapi: 3.0.3
info:
  title: Old API
  version: "1.0"
paths:
  /notes:
    get:
      operationId: listNotes
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Note"
components:
  schemas:
    Note:
      type: object
      nullable: true
      allOf:
        - type: object
      required: [b, a]
      properties:
        b: { type: string }
        a: { type: string }
`;
  const read = readApiReference(text, "openapi.yaml");
  assert.deepEqual(
    read.diagnostics.map((diagnostic) => [diagnostic.id, diagnostic.severity]),
    [["api-reference.schema-composition", "warning"]],
  );
  const schema = read.document?.operations[0]?.responses[0]?.content[0]?.schema;
  assert.deepEqual(schema?.type, ["object", "null"]);
  assert.deepEqual(schema?.required, ["a", "b"]);
  assert.deepEqual(schema?.properties.map((property) => property.name), ["a", "b"]);
});
