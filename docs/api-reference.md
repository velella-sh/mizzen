# Design: the API reference

Status: accepted. Epic: api-reference (#551). This note fixes the input and the operation model; #553 to #556 add the
reader, the pages, the layout, and the acceptance test.

## Purpose

A site publishes a static, searchable reference for the operations of one OpenAPI document. The document is pinned: it
is a file in the repository, and a build reads that file and nothing else. The reference is separate from the data
API's own `openapi.json`: that file describes the engine's output, and this feature describes an API the site owns.

## Input

```yaml
apiReference:
  source: api/openapi.yaml   # required, relative to the site root
  path: /reference/          # default
```

`source` is one YAML or JSON file (`.yaml`, `.yml`, or `.json`). A build never fetches the document, a reference, or
an example over the network.

| `openapi` | What happens |
| --- | --- |
| `3.1.x` | Read as written, including a `type` list and `null` in it. |
| `3.0.x` | Read and normalized: `nullable: true` adds `"null"` to a type that is present. |
| anything else | `api-reference.unsupported-version`; nothing is written under `path`. |

An unreadable source, invalid YAML or JSON, or a missing `info.title`, `info.version`, or `paths` is
`api-reference.input`. Each operation needs an `operationId` matching `[A-Za-z0-9][A-Za-z0-9._-]*`; the id is the URL
and the page's identity, so a missing or unsafe id is `api-reference.operation-id`. Two ids that are equal after case
folding would write one folder on a case-insensitive file system, so they are one duplicate:
`api-reference.duplicate-id`.

## The default path

`path` defaults to `/reference/`, starts and ends with `/`, and contains no `.` or `..` segment and no `//`. Every URL
carries the site's `base`. The index is at `<path>`; one operation is at `<path><operationId>/`. The output folder
follows the URL: `reference/index.html` and `reference/<operationId>/index.html` for the default.

The index carries `info.title`, `info.version`, `info.description`, and every operation grouped by tag. An operation
page is titled by its summary, else `<METHOD> <path>`, and takes part in navigation, search, and the sitemap like a
doc page. A URL the reference shares with another page is the site's ordinary duplicate-URL error.

## The operation model

This is what the reader hands to the page layer. A resolved reference is replaced by its target, so the model holds no
`$ref`.

```ts
export type ApiMethod = "get" | "put" | "post" | "delete" | "options" | "head" | "patch" | "trace";

export interface ApiOperation {
  readonly id: string;
  readonly method: ApiMethod;
  readonly path: string;
  readonly url: string;
  readonly title: string;
  readonly description?: string;
  readonly tags: readonly string[];
  readonly deprecated: boolean;
  readonly server?: string;
  readonly parameters: readonly ApiParameter[];
  readonly requestBody?: ApiRequestBody;
  readonly responses: readonly ApiResponse[];
}

export interface ApiParameter {
  readonly name: string;
  readonly in: "path" | "query" | "header" | "cookie";
  readonly required: boolean;
  readonly deprecated: boolean;
  readonly description?: string;
  readonly schema: ApiSchema;
  readonly examples: readonly ApiExample[];
}

export interface ApiRequestBody {
  readonly required: boolean;
  readonly description?: string;
  readonly content: readonly ApiMediaType[];
}

export interface ApiResponse {
  readonly status: string;
  readonly description: string;
  readonly content: readonly ApiMediaType[];
}

export interface ApiMediaType {
  readonly type: string;
  readonly schema?: ApiSchema;
  readonly examples: readonly ApiExample[];
}

export interface ApiExample {
  readonly name: string;
  readonly summary?: string;
  readonly value: Json;
}

export interface ApiSchema {
  readonly type?: string | readonly string[];
  readonly format?: string;
  readonly description?: string;
  readonly enum?: readonly Json[];
  readonly default?: Json;
  readonly required: readonly string[];
  readonly properties: readonly ApiProperty[];
  readonly items?: ApiSchema;
  readonly additionalProperties?: boolean | ApiSchema;
}

export interface ApiProperty {
  readonly name: string;
  readonly schema: ApiSchema;
}
```

`Json` is the value the file gives: a string, number, boolean, `null`, a list, or an object.

- `title` is `summary`, else `<METHOD> <path>`.
- `server` is the first URL in the operation's `servers`, else the path item's, else the document's; unset when the
  document names none.
- `parameters` merges path-item and operation parameters; an operation parameter replaces the path-item parameter with
  the same `name` and `in`. A path parameter is always `required`.
- `examples` holds the named `examples` map, plus `example` as one entry named `example`; when both are present,
  `examples` wins. An `externalValue` is outside the pinned input and is ignored.
- `content` is the `content` map as a list. A response or request body with no `content` has an empty list, so a `204`
  is complete with its description alone.
- `type` comes from 3.1 as written (a list when the input gives one); from 3.0, `nullable: true` appends `"null"` to a
  type that is present.
- `enum` keeps the order the file gives it, and `default` keeps its form. An example's value keeps its object key
  order.
- A schema keyword outside these fields is ignored, and members beside `$ref` are ignored: the target wins.

## Order

Every list in the model is sorted as below, except `enum`, which keeps the file's order. Reordering `paths`,
parameters, responses, or schema properties therefore changes no page.

- Operations: by `url`.
- Parameters: path, query, header, then cookie; by `name` within a location.
- Responses: numeric statuses in numeric order, then ranges (`1XX` to `5XX`), then `default`.
- Media types, examples, tags, properties, and `required` names: by name, code point order.

## References

Only local references are in scope. A `$ref` must be a JSON pointer into the same document, such as
`#/components/schemas/Component`. It is followed until it names a value, and the value must be the kind the position
expects: a parameter, a request body, a response, or a schema. A mismatch is `api-reference.reference-kind`.

| Case | Diagnostic | Effect |
| --- | --- | --- |
| A `$ref` that is a URL or a path to another file | `api-reference.reference-external` | error |
| A pointer whose target is absent | `api-reference.reference-missing` | error |
| A chain that returns to a pointer it already visited | `api-reference.reference-cycle` | error |

All of these are errors that name the file, the pointer, and where it is used. The reference writes no pages, so a page
never quietly drops a parameter or a field. A reference that names a whole path item is outside this version and is
reported as `api-reference.reference-kind`.

## Limits

- One document, one file. External references and remote examples are never read.
- A parameter uses `schema`; parameter `content` is outside this version.
- Security schemes, callbacks, webhooks, links, response headers, and cookie details are not shown. A page shows the
  method, path, parameters, request body, responses, and schemas the model carries.
- `servers` contributes its first URL only.
- Combined schemas (`allOf`, `oneOf`, `anyOf`, `not`) are outside this version: each is reported as
  `api-reference.schema-composition` (warning) and the schema is shown with the keywords the model carries.
- An operation without an `operationId` is not given a derived one. The input is pinned, so the fix belongs in the
  file, and an address never changes because a path or a method changed.

## Determinism

The document bytes and the config are the only inputs. A build reads no clock, no network, and no file modification
time; the same input gives byte-identical pages on every platform. The one warning this feature can write,
`api-reference.schema-composition`, names the file and pointer and is stable across runs.

## Fixture

`fixtures/api-reference/openapi.yaml` is the pinned input this epic's tests read. It is OpenAPI 3.1.0 with five
operations in two tags, and it exercises path and query parameters, a request body, 200/201/204 and shared 4xx
responses, single and named examples, a response with no content, and local references through a parameter, a
response, and a schema (including a reference inside a referenced schema). Its README lists each case. Fixtures are
read-only; a test that needs an invalid document builds its own.
