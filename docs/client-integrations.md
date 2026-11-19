# Agent clients: adapters, capabilities, and configuration

Mizzen serves one MCP contract to every client. A client adapter is a versioned descriptor of how
one client starts the server, which optional capabilities it declares, and where its configuration
file keeps the server entry. Shared behavior reads that descriptor and the client's `initialize`
hello; it never depends on a client's internals.

The contract lives in `src/contracts/clients.ts`; adapters, detection, fallbacks, configuration,
secrets, and the skill reader live in `src/clients/`.

## Adapter contract (version 1)

| Field | Meaning |
| --- | --- |
| `contractVersion` | `1`. A descriptor without it is read as version 1 with a migration note. |
| `id`, `name` | Stable lowercase id and a display name. |
| `transport` | `stdio`. |
| `protocolVersions` | MCP protocol versions the adapter knows, newest first. |
| `capabilities` | Eight independent booleans, below. |
| `config` | `{ format: "mcp-json", key, name }`, the top-level key and server entry name. |

Every capability is explicit:

| Capability | Default | Fallback when unavailable |
| --- | --- | --- |
| `tools` | true | None; a client without tools cannot use the server. |
| `resources` | true | Resources are not advertised; read page Markdown with `get_page`. |
| `notifications` | true | Every answer is inline; no unsolicited notification is sent. |
| `progress` | false | No progress channel; poll by repeating the read or comparing the receipt hash. |
| `longRunningTasks` | false | Calls run synchronously and return their receipt in the same answer. |
| `approvals` | false | A write depends on `--allow-edits` and the access policy; otherwise propose only. |
| `editing` | true | `apply_edit` is refused with `client-editing-unavailable`; `propose_edit` returns the patch. |
| `cursors` | true | Lists return `nextOffset` instead of `nextCursor`. |

Validation reports every problem with a JSON Pointer such as `/capabilities/editing`, so a typo
cannot silently grant a capability. Unknown capability keys are refused.

## Detection before any tool runs

The server reads the MCP `initialize` hello and reports the result in `_meta.mizzen`:

```json
{
  "contractVersion": 1,
  "client": { "id": "claude-code", "name": "Claude Code" },
  "protocolVersion": "2025-06-18",
  "capabilities": { "tools": true, "editing": true, "cursors": true, "progress": false },
  "fallbacks": [
    {
      "capability": "progress",
      "fallback": "No progress notifications; repeat the read, or read the receipt's hash, to poll.",
      "reason": "The client did not declare progress support."
    }
  ],
  "problems": [],
  "migrated": false
}
```

- Standard MCP declarations are read first: `capabilities.tasks.requests.tools.call` enables
  long-running tasks, and `capabilities.elicitation` enables approvals.
- A client may add `capabilities.experimental.mizzen.capabilities` with any subset of the eight
  flags. Absent flags keep the adapter default.
- An unreadable block — a newer contract version, a non-boolean flag, an unknown key — is ignored
  as a whole and recorded in `problems`. It never becomes an assumed capability.
- An unsupported protocol version is answered with the newest supported version, and the fallback
  is recorded in `problems`.
- `mizzen mcp` logs the same report to stderr: `client <id> (contract 1, protocol ...); unavailable: ...`.

## Generated configuration

`mizzen mcp <dir> --print-config <client>` prints the entry for `claude-code`, `claude-desktop`,
`cursor`, or `vscode`, generated from the same descriptor the server uses:

```bash
mizzen mcp . --print-config claude-desktop
```

The output contains a command, its arguments, and no credential. The same client, folder, and
`--allow-edits` flag always give the same bytes. A clean installation installs
`@velella/mizzen` with `npx` and starts `mizzen mcp <dir>`.

## Secrets

- A secret is never written into a generated configuration. There is no field for a token, header,
  or cookie in the stdio shape.
- When a caller must carry one, it writes an environment reference (`${NAME}`), and only the launch
  resolves it for names the caller explicitly allows (`resolveEnvReferences`). A printed, logged, or
  traced configuration keeps the reference (`redactClientConfig`).
- Free text that leaves the process goes through the same redaction as traces: credentials,
  `Authorization` values, and machine-local paths become fixed markers with no length or prefix.

## Versions and migration

| Input | Behavior |
| --- | --- |
| `contractVersion: 1` | Read as is. |
| No `contractVersion` | Read as version 1; `migrated: true` records the legacy shape. |
| `contractVersion: 2` or newer | Refused with `client.version-newer`: update the server or send version 1. |
| `0`, negative, a string, a fraction | Refused with `client.version-invalid`; versions are never guessed from text. |
| Unknown protocol version | Answered with the newest supported protocol; recorded as a fallback problem. |

Migration from the pre-versioning shape is additive: add
`capabilities.experimental.mizzen.contractVersion: 1` and declare only the flags the client
actually supports. No tool changes meaning between versions; a newer contract requires a server
update, not a guessed mapping.

## Installable skill

`skills/mizzen-client/` is a portable skill package. `skill.json` carries the manifest version (1),
the contract versions it teaches, the shipped files, and a SHA-256 over each file name, a NUL, and
its bytes, in manifest order. `readSkillPackage` verifies the version and checksum before the
instructions are installed, and refuses a missing file or a tampered copy.

The skill teaches task registration, context packing, span editing with `propose_edit`/`apply_edit`,
proof verification, and handoff. It names no project folder or credential and reads the live
capability report before using a feature.

## What the tests cover

`test/clients-contract.test.ts` covers validation, version negotiation, deterministic configuration,
redaction, fallbacks, and the skill checksum. `test/clients-profiles.test.ts` starts the public
`mizzen mcp` command twice — a full profile and a limited one — and runs the same search, page read,
block read, and proposal through both. The full profile applies the edit and verifies its proof; the
limited profile gets `client-editing-unavailable`, an unchanged file, and `nextOffset` pagination.

Limits of that check: the two profiles are client hellos sent through the real CLI and stdio, not
two vendor binaries, and the test runs from the checkout rather than an installed tarball. The
release smoke test covers the packed entry point separately.
