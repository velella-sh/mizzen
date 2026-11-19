/**
 * What the installed CLI can do, as a versioned JSON document.
 *
 * The list is fixed and ordered: task, pack, edit, verify, replay, eval. An available capability
 * names the public commands that provide it; an unavailable one names the fallback a caller should use
 * instead, so no client has to guess from help text or probe a command that does not exist. The
 * document is a build fact, not a probe: the commands it names are registered in this binary.
 */
/** The capability document version. */
export const CAPABILITIES_VERSION = 1;

/** One installed capability or its explicit fallback. */
export interface AgentCapability {
  readonly name: "task" | "pack" | "edit" | "verify" | "replay" | "eval";
  readonly available: boolean;
  /** Public commands that provide the capability, in stable order; empty when unavailable. */
  readonly commands: readonly string[];
  /** What a caller should do instead; `null` when the capability is available. */
  readonly fallback: string | null;
}

/** The six capabilities the epic is judged on, in a stable order, with truthful availability. */
export const CAPABILITIES: readonly AgentCapability[] = [
  {
    name: "task",
    available: true,
    commands: [
      "agent task register",
      "agent task preview",
      "agent task run",
      "agent task status",
      "agent task resume",
      "agent task cancel",
    ],
    fallback: null,
  },
  {
    name: "pack",
    available: true,
    commands: ["pack --task <file>", "pack --request <file|->"],
    fallback: null,
  },
  {
    name: "edit",
    available: true,
    commands: ["edit apply", "edit transaction", "edit rollback"],
    fallback: null,
  },
  {
    name: "verify",
    available: true,
    commands: ["edit verify", "doctor"],
    fallback: null,
  },
  {
    name: "replay",
    available: true,
    commands: ["trace replay"],
    fallback: null,
  },
  {
    name: "eval",
    available: false,
    commands: [],
    fallback:
      "No eval command is installed in this CLI. Use `mizzen check`, `mizzen doctor`, `mizzen edit verify`, and `mizzen trace replay` for the evidence the build can prove.",
  },
];

/** The versioned capabilities document, with the package version that produced it. */
export function capabilitiesDocument(packageVersion: string): Record<string, unknown> {
  return {
    version: CAPABILITIES_VERSION,
    package: packageVersion,
    capabilities: CAPABILITIES,
  };
}
