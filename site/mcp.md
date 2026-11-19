---
title: MCP server
description: Let an AI client search, read, and (when you allow it) edit your docs through a local Model Context Protocol server.
layout: doc
permalink: /mcp/
---

`mizzen mcp` starts a local [Model Context Protocol](https://modelcontextprotocol.io) server on stdin and stdout. An AI client such as Claude Code, Claude Desktop, Cursor, or VS Code starts it as a child process and asks it about your site. The server builds the site once into a temporary folder, rebuilds when a source file changes, and never opens a network port or makes a network request.

```bash
mizzen mcp [dir] [--theme <dir>] [--allow-edits] [--print-config <client>]
```

Protocol messages go to stdout. Logs go to stderr.

## Set up a client

`--print-config` prints the configuration a client needs, for `claude-code`, `claude-desktop`, `cursor`, or `vscode`:

```bash
mizzen mcp . --print-config claude-desktop
```

Paste the result into the client's MCP settings. The output is the same every time, and it names the folder you gave.

## Client capabilities and fallbacks

The server reads the client's `initialize` hello before any tool runs and reports what it found in `_meta.mizzen`: the adapter id, the contract and protocol versions, the effective capabilities, and every fallback. A client may declare its optional features under `capabilities.experimental.mizzen`; an unreadable block is reported and ignored, never guessed.

| If the client declares | The server does |
| --- | --- |
| no resources | advertises tools only; read page Markdown with `get_page` |
| no progress or long-running tasks | answers synchronously with the receipt; poll by repeating the read |
| no safe editing | refuses `apply_edit` with `client-editing-unavailable`; `propose_edit` still returns the patch |
| no cursors | returns `nextOffset` instead of `nextCursor` |

The startup log on stderr names the client and the unavailable capabilities. `--print-config` never writes a credential; a caller that must carry one uses an environment reference such as `${MIZZEN_TOKEN}`, resolved only at launch. The installable client skill ships in `skills/mizzen-client/` with a versioned manifest and checksum. See [the client integration notes](https://github.com/velella-sh/mizzen/blob/main/docs/client-integrations.md) for the contract and migration rules.

## Read-only by default

Without `--allow-edits` the server cannot change a file. Every tool below reads, and `propose_edit` only computes a diff.

| Tool | What it answers |
| --- | --- |
| `search_docs` | Pages that match a query: URL, title, excerpt, source file. |
| `get_page` | One page by URL or source path: its Markdown, headings, source file, and trust level. |
| `list_pages` | The site's pages, flat or as navigation, one page at a time. |
| `get_block_source` | The file, exact span, text, and hash of one heading or quoted block. |
| `propose_edit` | The diff an edit would make, without writing it. |
| `apply_edit` | Only with `--allow-edits`. Applies an edit with `mizzen edit apply`, writing source, proof, and audit together. |
| `get_diagnostics` | The build's diagnostics, filtered by path or severity. |
| `get_stale_pages` | The pages whose covered files changed since they were reviewed, with the files and the page source. |
| `get_pack` | A context pack for a goal, within a token budget of at most 12000. |
| `get_record` | On a site with collections: one record's fields, page URL, and place in its data file. |
| `query_records` | On a site with collections: records filtered and sorted with the list rules, one page at a time. |
| `query_graph` | The knowledge graph: a node's neighbors and the shortest path to another node, with the same ids and JSON as `mizzen graph`. |

The server also offers `llms.txt`, `AGENTS.md`, and each page's Markdown twin as resources at `mizzen://site/<path>`.

## Editing

An edit takes three steps, so an agent never guesses where text lives. It calls `get_block_source` to get the span and `beforeHash`, then `propose_edit` to see the diff, then (with `--allow-edits`) `apply_edit` with the same arguments. A stale hash or changed text is refused and the file stays as it was. A successful edit leaves a proof under `.mizzen/mcp/edits/` that `mizzen edit verify` checks.

## Limits

- Paths stay inside the site. A `..` path, an absolute path, or a symlink that leaves the folder is refused.
- An answer is cut at 64 KiB with a note saying so; page through lists with `cursor`.
- A call that takes longer than 30 seconds is stopped, and at most four calls run at once.
- Answers carry site-relative paths, never this machine's folders.
