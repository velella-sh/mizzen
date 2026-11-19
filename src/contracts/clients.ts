/**
 * The client adapter contract: what one AI client can do, how it reaches the server, and how its
 * configuration is written. An adapter describes a client through public MCP capabilities and this
 * versioned descriptor only, so shared behavior never depends on a client's internals.
 *
 * Capabilities are conservative. A client that declares nothing gets the protocol defaults and an
 * honest fallback report; an unknown contract version is refused instead of guessed.
 */

/** The contract version this build writes and reads. */
export type ClientContractVersion = 1;

/** How a client reaches the server. Stdio is the only transport today. */
export type ClientTransport = "stdio";

/** Which optional behaviors a client supports. Every flag is independent. */
export interface ClientCapabilities {
  /** The client can call tools. */
  readonly tools: boolean;
  /** The client can read MCP resources. */
  readonly resources: boolean;
  /** The client accepts server notifications. */
  readonly notifications: boolean;
  /** The client accepts progress notifications for a long call. */
  readonly progress: boolean;
  /** The client can create and poll a long-running task instead of waiting. */
  readonly longRunningTasks: boolean;
  /** The client can ask a person to approve an action. */
  readonly approvals: boolean;
  /** The client can apply an edit safely; `false` asks for a proposed patch only. */
  readonly editing: boolean;
  /** The client can continue a list with an opaque cursor. */
  readonly cursors: boolean;
}

/** Where a client keeps its MCP server list. */
export interface ClientConfigShape {
  /** The file format the printed configuration uses. */
  readonly format: "mcp-json";
  /** The top-level key, such as `mcpServers` or `servers`. */
  readonly key: string;
  /** The server entry's name, such as `mizzen`. */
  readonly name: string;
}

/** One versioned client descriptor. */
export interface ClientDescriptor {
  /** The descriptor version; older versions remain readable through the migration path. */
  readonly contractVersion: ClientContractVersion;
  /** Stable lowercase id, such as `claude-code` or `generic`. */
  readonly id: string;
  /** The client's name, for a report. */
  readonly name: string;
  /** How the client starts the server. */
  readonly transport: ClientTransport;
  /** MCP protocol versions the adapter knows, newest first. */
  readonly protocolVersions: readonly string[];
  /** What the client can do; absent means the protocol default. */
  readonly capabilities: ClientCapabilities;
  /** Where the generated configuration goes. */
  readonly config: ClientConfigShape;
}

/** One located problem with a descriptor or a client hello. */
export interface ClientProblem {
  /** JSON Pointer to the offending value, such as `/capabilities/editing`; `""` is the document. */
  readonly path: string;
  /** Stable identifier, such as `client.capability-unknown`. */
  readonly code: string;
  /** What is wrong and what to write instead, in one sentence. */
  readonly message: string;
}

/** The result of validating a descriptor. */
export interface ClientValidation {
  /** The descriptor; present exactly when `problems` is empty. */
  readonly descriptor?: ClientDescriptor;
  /** Every problem, in document order. */
  readonly problems: readonly ClientProblem[];
}

/** One explicit degradation, with the reason the capability is unavailable. */
export interface ClientFallback {
  /** The missing capability, hyphenated, such as `long-running-tasks`. */
  readonly capability: string;
  /** What the server or client does instead. */
  readonly fallback: string;
  /** Why the capability is unavailable, in one sentence. */
  readonly reason: string;
}

/** The negotiated view of one client, built from its `initialize` hello before any tool runs. */
export interface ClientProfile {
  /** The descriptor contract version used for this profile. */
  readonly contractVersion: ClientContractVersion;
  /** The adapter id and name. */
  readonly client: { readonly id: string; readonly name: string };
  /** The MCP protocol version the server answers with. */
  readonly protocolVersion: string;
  /** The effective capabilities, after the hello and the adapter defaults. */
  readonly capabilities: ClientCapabilities;
  /** Every unavailable capability and its fallback, in a fixed order. */
  readonly fallbacks: readonly ClientFallback[];
  /** Why the hello was partly ignored; empty when it was fully understood. */
  readonly problems: readonly ClientProblem[];
  /** True when the hello carried no contract version and the version 1 defaults were applied. */
  readonly migrated: boolean;
}

/** What a client says when it starts: the fields of an MCP `initialize` request this contract reads. */
export interface ClientHello {
  readonly protocolVersion?: string;
  readonly clientInfo?: { readonly name?: string; readonly version?: string };
  readonly capabilities?: {
    readonly roots?: unknown;
    readonly sampling?: unknown;
    readonly elicitation?: unknown;
    readonly experimental?: Readonly<Record<string, unknown>>;
    readonly tasks?: { readonly requests?: { readonly tools?: { readonly call?: unknown } } };
  };
  readonly _meta?: Readonly<Record<string, unknown>>;
}

/** A skill package's manifest, as installed by a client. */
export interface SkillPackageManifest {
  /** The manifest schema; only `velella.skill.v1` is read. */
  readonly schemaVersion: "velella.skill.v1";
  /** The skill's stable name. */
  readonly name: string;
  /** The skill's version, an integer that only moves forward. */
  readonly version: number;
  /** The descriptor contract versions the skill teaches. */
  readonly contractVersions: readonly number[];
  /** The instruction file, relative to the package folder. */
  readonly entry: string;
  /** Every shipped file, relative with forward slashes, in a fixed order. */
  readonly files: readonly string[];
  /** The SHA-256 over each file name, a NUL, and its bytes, in manifest order. */
  readonly checksum: { readonly algorithm: "sha256"; readonly value: string };
}
