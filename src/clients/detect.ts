/**
 * Detect a client from its MCP `initialize` hello before any tool runs. The adapter defaults are
 * combined with what the client declares: standard MCP task creation and elicitation, then this
 * contract's `experimental.mizzen` block. A block this build cannot read is ignored as a whole and
 * reported; no unknown schema is guessed into a capability.
 */
import type {
  ClientCapabilities,
  ClientHello,
  ClientProblem,
  ClientProfile,
} from "../contracts/clients.ts";
import { ADAPTER_PROTOCOL_VERSIONS, adapterOf, GENERIC_ADAPTER, validateCapabilities } from "./registry.ts";
import { fallbacksOf } from "./fallback.ts";
import { checkClientContractVersion } from "./version.ts";

/** The hello's experimental key for this contract. */
export const MIZZEN_EXPERIMENT = "mizzen";

const ALIASES: Readonly<Record<string, string>> = {
  "claude-code": "claude-code",
  "claude code": "claude-code",
  "claude-desktop": "claude-desktop",
  "claude desktop": "claude-desktop",
  cursor: "cursor",
  vscode: "vscode",
  "vs code": "vscode",
  "visual studio code": "vscode",
};

export interface DetectOptions {
  /** The protocol versions this server speaks, newest first. Defaults to the adapter list. */
  readonly protocolVersions?: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function located(path: string, code: string, message: string): ClientProblem {
  return { path, code, message };
}

/** The adapter a hello's `clientInfo.name` names, or the conservative generic one. */
function adapterFor(name: string | undefined): { readonly descriptor: typeof GENERIC_ADAPTER; readonly known: boolean } {
  if (name === undefined) return { descriptor: GENERIC_ADAPTER, known: false };
  const id = ALIASES[name.trim().toLowerCase()];
  const descriptor = id === undefined ? undefined : adapterOf(id);
  return descriptor === undefined ? { descriptor: GENERIC_ADAPTER, known: false } : { descriptor, known: true };
}

/** Reads `capabilities.experimental.mizzen`, or `undefined` when the client sent none. */
function experimentOf(hello: ClientHello): unknown {
  if (!isRecord(hello.capabilities)) return undefined;
  const experimental = hello.capabilities.experimental;
  if (!isRecord(experimental)) return undefined;
  return experimental[MIZZEN_EXPERIMENT];
}

/** Builds the negotiated profile from one hello. Deterministic: the same hello gives the same report. */
export function detectClient(hello: ClientHello | undefined, options: DetectOptions = {}): ClientProfile {
  const input: ClientHello = isRecord(hello) ? hello : {};
  const problems: ClientProblem[] = [];
  const info = isRecord(input.clientInfo) ? input.clientInfo : undefined;
  const name = typeof info?.name === "string" && info.name.trim() !== "" ? info.name.trim() : undefined;
  if (info !== undefined && info.name !== undefined && typeof info.name !== "string") {
    problems.push(located("/clientInfo/name", "client.name-invalid", "`clientInfo.name` must be a string; the generic adapter is used."));
  }
  const { descriptor, known } = adapterFor(name);
  const capabilities: Record<keyof ClientCapabilities, boolean> = { ...descriptor.capabilities };
  let migrated = false;

  const experiment = experimentOf(input);
  if (experiment !== undefined) {
    if (!isRecord(experiment)) {
      problems.push(located("/capabilities/experimental/mizzen", "client.experiment-invalid", "`experimental.mizzen` must be an object; the block was ignored."));
    } else {
      const version = checkClientContractVersion(experiment.contractVersion);
      if (version.problems.length > 0) {
        problems.push(...version.problems.map((entry) => located(`/capabilities/experimental/mizzen${entry.path}`, entry.code, entry.message)));
      } else if (experiment.capabilities !== undefined || version.version !== undefined) {
        const declared = validateCapabilities(experiment.capabilities ?? {}, capabilities, false);
        if (declared.problems.length > 0) {
          problems.push(...declared.problems.map((entry) => located(`/capabilities/experimental/mizzen${entry.path}`, entry.code, entry.message)));
        } else if (declared.capabilities !== undefined) {
          Object.assign(capabilities, declared.capabilities);
          migrated = version.migrated;
        }
      }
    }
  }

  // Standard MCP declarations, which need no private extension.
  if (isRecord(input.capabilities)) {
    const standard = input.capabilities;
    if (isRecord(standard.tasks) && isRecord(standard.tasks.requests) && isRecord(standard.tasks.requests.tools) && standard.tasks.requests.tools.call !== undefined) {
      capabilities.longRunningTasks = true;
    }
    if (standard.elicitation !== undefined) capabilities.approvals = true;
  }

  const supported = options.protocolVersions !== undefined && options.protocolVersions.length > 0 ? options.protocolVersions : ADAPTER_PROTOCOL_VERSIONS;
  const asked = typeof input.protocolVersion === "string" ? input.protocolVersion : undefined;
  if (asked !== undefined && asked !== "" && !supported.includes(asked)) {
    problems.push(located("/protocolVersion", "client.protocol-version-fallback", `Protocol version ${asked} is not supported; the server answers with ${supported[0]}.`));
  }

  return {
    contractVersion: 1,
    client: { id: descriptor.id, name: known ? descriptor.name : name ?? descriptor.name },
    protocolVersion: asked !== undefined && supported.includes(asked) ? asked : supported[0]!,
    capabilities,
    fallbacks: fallbacksOf(capabilities),
    problems,
    migrated,
  };
}

/** True when the profile came from a client this build has an adapter for. */
export function isKnownClient(profile: ClientProfile): boolean {
  return adapterOf(profile.client.id) !== undefined;
}
