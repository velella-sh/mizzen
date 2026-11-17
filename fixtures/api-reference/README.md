# API reference fixture

The pinned OpenAPI document the API reference tests read. It is one self-contained file: every `$ref` is a JSON
pointer into it, and nothing reads the clock or the network.

| Operation | Method and path | What it covers |
| --- | --- | --- |
| `listComponents` | `GET /components` | Query parameters with an enum, a default, and a local parameter reference; a 200 list with a named example and a shared 400. |
| `createComponent` | `POST /components` | A required request body with a schema reference and a named example; 201 with a body and the shared 400. |
| `getComponent` | `GET /components/{slug}` | A path-level parameter reference; 200 with a single example and a shared 404. |
| `deleteComponent` | `DELETE /components/{slug}` | A 204 with no content and the shared 404. |
| `listReleases` | `GET /releases` | A second tag, a deprecated operation, a `since` date query parameter, and a response without examples. |

## References

| Pointer | Used by | What it proves |
| --- | --- | --- |
| `#/components/parameters/ComponentSlug` | both `/components/{slug}` operations | A parameter reference, including its example. |
| `#/components/parameters/Region` | `listComponents` | A parameter that references a schema. |
| `#/components/responses/BadRequest` | `listComponents`, `createComponent` | One shared error response, reused. |
| `#/components/responses/NotFound` | `getComponent`, `deleteComponent` | A second shared response. |
| `#/components/schemas/Component` | three operations | A schema reference, reused with different examples. |
| `#/components/schemas/ComponentInput` | `createComponent` | A request-body schema. |
| `#/components/schemas/Region` | `Component`, `ComponentInput`, and the `Region` parameter | A reference inside a referenced value. |
| `#/components/schemas/Problem` | both shared responses | A transitive reference, from a response to a schema. |

The document also covers a 3.1 `type` list with `"null"` (`Component.released`) and a required schema field whose
example value is `null`.

## Deliberately absent

Cases that must fail, such as an external `$ref`, a missing pointer, a reference cycle, a duplicate operation id, or
an unsupported version, are written by the tests in a temporary folder. They are not in this fixture, because a
fixture is a valid input every test can read.

The fixture is read-only, like every other one; a task that needs different content adds another folder.
