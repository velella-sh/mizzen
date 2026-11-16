# ADR: A local MCP server for a Mizzen site

- Status: accepted
- Epic: #194 · Decision issue: #307

## Context

An agent that works on a docs site needs four things: find a page, read it, learn the exact source span of one block,
and propose a change. Mizzen already has each piece (the built search data, the Markdown twin, `sourcemap.json`,
`mizzen pack`, and `mizzen edit apply` with proof). This decision puts them behind the Model Context Protocol (MCP)
without writing new edit logic.

## Decision

**Transport.** `mizzen mcp [dir]` speaks newline-delimited JSON-RPC 2.0 over **stdio** only. stdout carries protocol
messages and nothing else; logs go to stderr. The server exits when stdin closes.

**Protocol version.** The server answers `initialize` with the client's requested version when it is one of
`2025-06-18`, `2025-03-26`, or `2024-11-05`, and with `2025-06-18` otherwise. It implements `initialize`, `ping`,
`tools/list`, `tools/call`, `resources/list`, `resources/read`, and `resources/templates/list`.

**No SDK dependency.** The subset above is small, and the official SDK would add a large runtime dependency tree to a
package whose engine promises few dependencies. The server is a short module (`src/mcp/server.ts`). The official SDK
client is a **dev dependency**, used only by `test/mcp-integration.test.ts`, so the server is tested against an
independent implementation of the protocol.

**Read-only by default.** Every tool reads the site or writes nothing: `propose_edit` returns a patch and a diff and
writes nothing. The only tool that changes a file is `apply_edit`, and it is **not registered** unless the server
starts with `--allow-edits`. It applies through `mizzen edit apply`'s transaction, so the source, the proof, and the
audit entry land together, and it refuses a patch that carries neither `expected` nor `beforeHash`.

**No network.** The server never opens a socket and never fetches a URL. It builds the site once into a temporary
folder and rebuilds when a source file changed. There is no hosted or remote mode and none is planned.

**Confinement and bounds.** Every path is resolved through its real path and must stay inside the site root; answers
carry site-relative paths only. One answer is capped (64 KiB) and says when it was cut, one call is capped in time
(30 s), and at most 4 calls run at once. A `get_pack` budget is capped too.

**Tools are discovered from a folder.** The registry loads every file in `src/mcp/tools/` in file-name order; the
tool's name is the file name. There is no shared list to edit. A tool may decline to register (`enabled`), which is how
the data tools disappear on a site without collections and `apply_edit` disappears without the flag.

## Tools of this version

| Tool | Issue | Purpose |
| --- | --- | --- |
| `search_docs` | #310 | Search the site; title, URL, excerpt, source path |
| `get_page` | #311 | A page's Markdown twin, headings, source file, trust level; one section by heading id |
| `list_pages` | #312 | The page list or navigation order, with a prefix, language, limit, and cursor |
| `get_block_source` | #313 | The file, exact span, source text, and hash of a block |
| `propose_edit` | #314 | A span patch and unified diff; writes nothing |
| `apply_edit` | #315 | Applies a patch with proof; only with `--allow-edits` |
| `get_diagnostics` | #316 | The site's diagnostics in the JSON contract |
| `get_pack` | #317 | A context pack for a task request, within a token budget |
| `get_record`, `query_records` | #318 | Data records; only on a site with collections |

Resources (#319): `llms.txt`, the generated `AGENTS.md`, and each page's Markdown twin. Bounds (#320), client
configuration (#321), and a test with a real client (#322) complete the epic.

## Left out

A hosted or remote server; HTTP or SSE transports; authentication; prompts and sampling; resource subscriptions;
writing several files in one call; any edit that does not go through a span patch with a precondition.
