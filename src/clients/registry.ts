/**
 * The built-in client adapters and validation of any descriptor, built-in or shipped by a client.
 * Validation reports every problem with a JSON Pointer, so a typo in one capability cannot silently
 * grant or remove behavior.
 */
import type {
  ClientCapabilities,
  ClientDescriptor,
  ClientProblem,
  ClientValidation,
} from "../contracts/clients.ts";
import { checkClientContractVersion, CLIENT_CONTRACT_VERSION } from "./version.ts";

/** The MCP protocol versions the shipped adapters know, newest first. */
export const ADAPTER_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

/** Every capability key, in report order. */
export const CAPABILITY_KEYS = [
  "tools",
  "resources",
  "notifications",
  "progress",
  "longRunningTasks",
  "approvals",
  "editing",
  "cursors",
] as const;

/** What the shipped adapters assume: tools, resources, notifications, cursors, and edits. The rest is declared by the hello. */
const COMMON: ClientCapabilities = {
  tools: true,
  resources: true,
  notifications: true,
  progress: false,
  longRunningTasks: false,
  approvals: false,
  editing: true,
  cursors: true,
};

/** A client that says nothing beyond its name: the protocol defaults, with optional channels declared only by the hello. */
const GENERIC: ClientCapabilities = {
  tools: true,
  resources: true,
  notifications: true,
  progress: false,
  longRunningTasks: false,
  approvals: false,
  editing: true,
  cursors: true,
};

function adapter(id: string, name: string, configKey: string, capabilities: ClientCapabilities = COMMON): ClientDescriptor {
  return {
    contractVersion: CLIENT_CONTRACT_VERSION,
    id,
    name,
    transport: "stdio",
    protocolVersions: ADAPTER_PROTOCOL_VERSIONS,
    capabilities,
    config: { format: "mcp-json", key: configKey, name: "mizzen" },
  };
}

/** The clients this build writes configuration for, in help order. */
export const CLIENT_IDS = ["claude-code", "claude-desktop", "cursor", "vscode"] as const;
export type ClientId = (typeof CLIENT_IDS)[number];

/** The clients this build writes configuration for, in help order. */
export const CLIENT_ADAPTERS: readonly ClientDescriptor[] = [
  adapter("claude-code", "Claude Code", "mcpServers"),
  adapter("claude-desktop", "Claude Desktop", "mcpServers"),
  adapter("cursor", "Cursor", "mcpServers"),
  adapter("vscode", "VS Code", "servers"),
];

/** The conservative adapter used when a hello names no client this build knows. */
export const GENERIC_ADAPTER: ClientDescriptor = adapter("generic", "Generic MCP client", "mcpServers", GENERIC);

/** The adapter with this id, or `undefined`. */
export function adapterOf(id: string): ClientDescriptor | undefined {
  return CLIENT_ADAPTERS.find((entry) => entry.id === id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function problem(path: string, code: string, message: string): ClientProblem {
  return { path, code, message };
}

/**
 * Checks that `value` is a capability object. A full descriptor must name every flag; a client
 * hello may name only the flags it declares, and the rest are inherited from `base`.
 */
export function validateCapabilities(value: unknown, base: ClientCapabilities, requireAll = true): { readonly capabilities?: ClientCapabilities; readonly problems: readonly ClientProblem[] } {
  if (!isRecord(value)) {
    return { problems: [problem("/capabilities", "client.capabilities-missing", "`capabilities` must be an object of booleans.")] };
  }
  const problems: ClientProblem[] = [];
  const out: Record<string, boolean> = { ...base };
  for (const key of CAPABILITY_KEYS) {
    const flag = value[key];
    if (flag === undefined) {
      if (requireAll) problems.push(problem(`/capabilities/${key}`, "client.capability-missing", `\`capabilities.${key}\` is required; write true or false.`));
    } else if (typeof flag !== "boolean") {
      problems.push(problem(`/capabilities/${key}`, "client.capability-type", `\`capabilities.${key}\` must be true or false, not ${JSON.stringify(flag)}.`));
    } else {
      out[key] = flag;
    }
  }
  for (const key of Object.keys(value).sort()) {
    if (!(CAPABILITY_KEYS as readonly string[]).includes(key)) {
      problems.push(problem(`/capabilities/${key}`, "client.capability-unknown", `\`${key}\` is not a capability this contract defines; remove it or use one of ${CAPABILITY_KEYS.join(", ")}.`));
    }
  }
  return problems.length === 0 ? { capabilities: out as unknown as ClientCapabilities, problems } : { problems };
}

/** Validates every field of a client descriptor. */
export function validateClientDescriptor(value: unknown): ClientValidation {
  if (!isRecord(value)) {
    return { problems: [problem("", "client.not-object", "A client descriptor must be a JSON object.")] };
  }
  const problems: ClientProblem[] = [];
  const version = checkClientContractVersion(value.contractVersion);
  problems.push(...version.problems);

  if (typeof value.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(value.id)) {
    problems.push(problem("/id", "client.id-invalid", "`id` must be lowercase letters, digits, and hyphens, starting with a letter or digit."));
  }
  if (typeof value.name !== "string" || value.name.trim() === "") {
    problems.push(problem("/name", "client.name-missing", "`name` must be a non-empty string."));
  }
  if (value.transport !== "stdio") {
    problems.push(problem("/transport", "client.transport-unsupported", `\`transport\` must be "stdio"; ${JSON.stringify(value.transport)} is not supported.`));
  }
  if (!Array.isArray(value.protocolVersions) || value.protocolVersions.length === 0 || value.protocolVersions.some((entry) => typeof entry !== "string" || entry === "")) {
    problems.push(problem("/protocolVersions", "client.protocol-versions-invalid", "`protocolVersions` must be a non-empty array of protocol version strings, newest first."));
  }

  const capabilities = validateCapabilities(value.capabilities, GENERIC);
  problems.push(...capabilities.problems);

  if (!isRecord(value.config)) {
    problems.push(problem("/config", "client.config-missing", "`config` must be an object with `format`, `key`, and `name`."));
  } else {
    if (value.config.format !== "mcp-json") {
      problems.push(problem("/config/format", "client.config-format", `\`config.format\` must be "mcp-json", not ${JSON.stringify(value.config.format)}.`));
    }
    if (typeof value.config.key !== "string" || value.config.key.trim() === "") {
      problems.push(problem("/config/key", "client.config-key", "`config.key` must be the top-level key of the client's MCP configuration file."));
    }
    if (typeof value.config.name !== "string" || value.config.name.trim() === "") {
      problems.push(problem("/config/name", "client.config-name", "`config.name` must be the name of the server entry."));
    }
  }

  if (problems.length > 0 || version.version === undefined || capabilities.capabilities === undefined) return { problems };
  return {
    descriptor: {
      contractVersion: version.version,
      id: value.id as string,
      name: value.name as string,
      transport: "stdio",
      protocolVersions: value.protocolVersions as string[],
      capabilities: capabilities.capabilities,
      config: value.config as unknown as ClientDescriptor["config"],
    },
    problems: [],
  };
}
