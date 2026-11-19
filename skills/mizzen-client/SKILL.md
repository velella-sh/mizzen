---
name: mizzen-client
description: Work on a documentation site through a Mizzen MCP server: register a task, compile a context pack, propose or apply a span edit, verify the proof, and hand the result to another agent or a person. Use when a client is connected to a documentation site and the user asks for a change, a review, a migration, or a handoff. Not for changing the engine itself.
license: Apache-2.0
metadata:
  author: Velella
  version: "1"
---

# Work on a documentation site

## Before you start

Read the `_meta.mizzen` report in the server's `initialize` answer. It names the client, the contract version, the protocol version, the effective capabilities, and every fallback. Never assume a capability the report does not declare.

- `resources` false: read pages through the tools, not resources.
- `long-running-tasks` false: every call returns synchronously with its receipt; do not wait for a task id.
- `progress` false: poll by repeating the read, or compare the receipt hash.
- `approvals` false: a write depends on the server's `--allow-edits` and the access policy; use `propose_edit` when unsure.
- `editing` false: `apply_edit` is refused; hand the patch from `propose_edit` to a person.
- `cursors` false: continue a list with `nextOffset`, not `nextCursor`.

Work from the site root. Never write a path outside it, never guess a span, and never repeat an edit whose receipt is already recorded.

## 1. Register the task

Write the version 1 task contract before changing anything: the goal in one sentence, the semantic scope (pages, blocks, collections, symbols, files), the input snapshot, independent limits for context tokens, tool calls, and time, the permissions, and one acceptance criterion per required check. Register it through the task API your host exposes. Keep its ids with the work; the first event is registration and every later event names the state it left and entered.

If the request is ambiguous, ask one focused question about the missing field before registering.

## 2. Pack the context

Compile one context pack for the goal within a token budget. Prefer the MCP tool `get_pack`, or run `mizzen pack --request -` with a version 1 context request on stdin. Read the pack's selection and omissions; do not refill context from whole pages when the pack already names them.

## 3. Edit with spans

1. Read the block: `get_block_source` (or a page read) returns the file, the exact span, its `text`, and `beforeHash`.
2. Propose: `propose_edit` checks the span and returns the patch and unified diff without writing. Compare the diff with the goal.
3. Apply only when the report allows editing and the server allows writes: `apply_edit` with the same file, span, `expected`, `beforeHash`, and replacement. A stale hash or changed text is refused and the file stays as it was.
4. If the client has no safe editing, stop after the proposal and hand the patch to a person.

An edit that needs approval must name the stage, files, effect, snapshot, and policy before it runs.

## 4. Verify

Rebuild and read the diagnostics of the changed file, then run the check that proves each acceptance criterion. For a span edit, check its proof with `mizzen edit verify <proof.json> --site <dir>`; for a build, run `mizzen verify <dir>` against the manifest. A criterion without evidence stays pending, and a human-review criterion never passes automatically.

## 5. Hand off

When work stops before done, hand off with the task id, snapshot, policy, decisions, the diff, the checks that ran, the questions left, and the one next action. Use `mizzen trace handoff <trace.json>` when a trace exists, or the handoff value of the interaction API. Never include conversation history, credentials, or machine-local paths.

## Reports

Every answer you give back should name what changed, the evidence (proof path, verification result, diagnostic counts), the capabilities that were unavailable, and the next action. An honest fallback is better than a silent one.
