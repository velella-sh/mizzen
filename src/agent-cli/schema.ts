/**
 * The machine-readable description of an agent command: its input, its output, and its exit codes.
 *
 * A client asks for one command by name and gets JSON; it never parses the human help. Every entry is
 * a compact JSON Schema (draft 2020-12) with descriptions that say what to send and what comes back.
 * The list and each document are versioned, and the names are stable; an unknown name says which
 * names exist instead of guessing.
 *
 * The schemas describe the public contract, not every internal field: they always name the required
 * top-level keys, so a validator catches a client that reads the wrong document.
 */
import type { TaskProblem } from "../contracts/task.ts";

/** The schema document version. */
export const SCHEMA_VERSION = 1;

/** One command's documented contract. */
export interface AgentCommandSchema {
  /** Stable document name, such as `agent.task.register`. */
  readonly name: string;
  /** One sentence a client can show. */
  readonly summary: string;
  /** The public command line, with optional words in brackets. */
  readonly cli: string;
  /** Draft 2020-12 JSON Schema of the input (the JSON document or the options). */
  readonly input: Record<string, unknown>;
  /** Draft 2020-12 JSON Schema of the success document written to stdout. */
  readonly output: Record<string, unknown>;
}

/** The exit codes every agent command shares. */
export const EXIT_CODES: Readonly<Record<string, string>> = {
  "0": "success; stdout holds the result document",
  "1": "refused, conflicted, or failed; stdout holds an error document when the input was valid",
  "2": "usage or invalid input; nothing was written",
};

/** One problem: a JSON Pointer, a stable code, and a sentence. */
const problemSchema: Record<string, unknown> = {
  type: "object",
  required: ["path", "code", "message"],
  properties: {
    path: { type: "string", description: "JSON Pointer to the offending value; empty for the whole document." },
    code: { type: "string", description: "Stable identifier, such as task.idempotency-conflict." },
    message: { type: "string" },
  },
  additionalProperties: false,
};

/** A failure document: the same envelope, with every problem and its JSON Pointer. */
const failure: Record<string, unknown> = {
  type: "object",
  required: ["version", "ok", "command", "problems"],
  properties: {
    version: { const: 1 },
    ok: { const: false },
    command: { type: "string" },
    problems: { type: "array", items: problemSchema },
  },
  additionalProperties: true,
};

/** The shape every success document shares. */
function success(command: string, properties: Record<string, unknown>, required: readonly string[]): Record<string, unknown> {
  return {
    type: "object",
    required: ["version", "ok", "command", ...required],
    properties: {
      version: { const: 1 },
      ok: { const: true },
      command: { const: command },
      ...properties,
    },
    additionalProperties: true,
  };
}

/** The task document, as the public task schema defines it. */
const taskDocument: Record<string, unknown> = {
  type: "object",
  required: ["version", "id", "requestId", "idempotencyKey", "goal", "scope", "snapshot", "budget", "acceptance", "state", "events"],
  description: "A registered task document: the contract, deterministic ids, state, and ordered events.",
};

/** The options every task subcommand accepts after its own words. */
const taskOptionProperties: Record<string, unknown> = {
  root: { type: "string", default: ".", description: "Site root; the state folder is <root>/.mizzen/agent." },
  format: { type: "string", enum: ["json", "text", "ndjson"], default: "json" },
};

const taskOptions: Record<string, unknown> = {
  type: "object",
  properties: taskOptionProperties,
  additionalProperties: false,
};

/** The contract input for register and preview: a file path or stdin. */
function contractInput(description: string): Record<string, unknown> {
  return {
    type: "object",
    required: ["source"],
    properties: {
      source: {
        oneOf: [
          { type: "object", required: ["file"], properties: { file: { type: "string" } }, additionalProperties: false },
          { const: "stdin" },
        ],
        description,
      },
      ...taskOptionProperties,
      events: { type: "string", description: "Write the progress events as JSON Lines to this file." },
    },
    additionalProperties: false,
  };
}

/** The event schema, inlined where a schema needs it. */
const eventSchema: Record<string, unknown> = {
  type: "object",
  required: ["version", "sequence", "taskId", "type", "stage", "state", "message"],
  properties: {
    version: { const: 1 },
    sequence: { type: "integer", minimum: 0 },
    taskId: { type: "string" },
    type: { type: "string", enum: ["start", "progress", "approval-required", "finish", "failure"] },
    stage: { type: ["string", "null"], description: "context, acceptance, lifecycle, or null." },
    state: { type: ["string", "null"], description: "The task state after the event." },
    message: { type: "string" },
  },
  additionalProperties: false,
};

/** The progress object embedded in a run result. */
const progress: Record<string, unknown> = {
  type: "object",
  required: ["version", "events"],
  properties: {
    version: { const: 1 },
    events: { type: "array", items: eventSchema },
  },
  additionalProperties: false,
};

/** The cost and budget report embedded in a run result. */
const costAndBudget: Record<string, unknown> = {
  cost: {
    type: "object",
    required: ["version", "estimated", "contextTokens", "timeMs", "toolCalls", "method"],
    properties: {
      version: { const: 1 },
      estimated: { const: true },
      contextTokens: { type: "integer", minimum: 0 },
      timeMs: { type: "integer", minimum: 0 },
      toolCalls: { type: "integer", minimum: 0 },
      method: { type: "string" },
    },
    additionalProperties: false,
  },
  budget: {
    type: "object",
    required: ["limits", "usage", "remaining", "stops"],
    properties: {
      limits: { type: "object", required: ["contextTokens", "toolCalls", "timeMs"] },
      usage: { type: "object", required: ["contextTokens", "toolCalls", "timeMs"] },
      remaining: { type: "object", required: ["contextTokens", "toolCalls", "timeMs"] },
      stops: {
        type: "array",
        items: {
          type: "object",
          required: ["status", "reason"],
          properties: {
            status: { type: "string", enum: ["context-tokens-exceeded", "tool-calls-exceeded", "time-exceeded"] },
            reason: { type: "string" },
          },
        },
      },
    },
    additionalProperties: false,
  },
  stopReason: { type: ["string", "null"] },
};

/** The registered schema entries, in the order the list prints. */
const COMMANDS: readonly AgentCommandSchema[] = [
  {
    name: "agent.capabilities",
    summary: "Discover which of task, pack, edit, verify, replay, and eval are installed.",
    cli: "mizzen agent capabilities [--format json|text]",
    input: {
      type: "object",
      properties: { format: { type: "string", enum: ["json", "text"], default: "json" } },
      additionalProperties: false,
    },
    output: success(
      "agent.capabilities",
      {
        package: { type: "string", description: "The installed Mizzen version." },
        capabilities: {
          type: "array",
          items: {
            type: "object",
            required: ["name", "available", "commands", "fallback"],
            properties: {
              name: { type: "string", enum: ["task", "pack", "edit", "verify", "replay", "eval"] },
              available: { type: "boolean" },
              commands: { type: "array", items: { type: "string" } },
              fallback: { type: ["string", "null"], description: "What to use instead when unavailable." },
            },
          },
        },
      },
      ["package", "capabilities"],
    ),
  },
  {
    name: "agent.schema",
    summary: "Read one command's input, output, and exit codes.",
    cli: "mizzen agent schema [name] [--format json|text]",
    input: {
      type: "object",
      properties: {
        name: { type: "string", description: "A name from `mizzen agent schema` with no name." },
        format: { type: "string", enum: ["json", "text"], default: "json" },
      },
      additionalProperties: false,
    },
    output: success(
      "agent.schema",
      {
        name: { type: "string", description: "The requested command name." },
        cli: { type: "string" },
        summary: { type: "string" },
        input: { type: "object" },
        output: { type: "object" },
        exitCodes: { type: "object" },
      },
      ["name", "cli", "summary", "input", "output", "exitCodes"],
    ),
  },
  {
    name: "agent.task.register",
    summary: "Register a task from a file or stdin; a repeat with the same key returns the same task.",
    cli: "mizzen agent task register [dir] --file <path>|--stdin [--format json|text]",
    input: contractInput("The task contract: a file path, or stdin."),
    output: success(
      "agent.task.register",
      {
        created: { type: "boolean", description: "False when the same idempotency key already registered this content." },
        taskId: { type: "string" },
        state: { type: "string" },
        task: taskDocument,
        writes: { type: "array", items: { type: "string" } },
      },
      ["created", "taskId", "state", "task", "writes"],
    ),
  },
  {
    name: "agent.task.preview",
    summary: "Show the context a task would compile, its required checks, and its affected outputs, without writing.",
    cli: "mizzen agent task preview [dir] --file <path>|--stdin [--format json|text]",
    input: contractInput("The task contract to preview: a file path, or stdin."),
    output: success(
      "agent.task.preview",
      {
        dryRun: { const: true },
        task: { type: "object", required: ["id", "requestId", "goal"] },
        proposedChanges: { type: "array", items: { type: "object", required: ["kind", "ref"] } },
        requiredChecks: { type: "array", items: { type: "object", required: ["id", "kind"] } },
        affectedOutputs: { type: "array", items: { type: "string" } },
        context: { type: "object" },
        cost: costAndBudget.cost,
        budget: costAndBudget.budget,
        stopReason: costAndBudget.stopReason,
        writes: { type: "array", maxItems: 0 },
      },
      ["dryRun", "task", "proposedChanges", "requiredChecks", "affectedOutputs", "context", "cost", "budget", "stopReason", "writes"],
    ),
  },
  {
    name: "agent.task.run",
    summary: "Compile a registered task's context, report cost and budget, and move its state; a repeat returns the first result.",
    cli: "mizzen agent task run <id> [dir] --dry-run [--format json|text|ndjson] [--events <file>]",
    input: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "The task id from `agent task register`." },
        root: { type: "string", default: "." },
        dryRun: { type: "boolean", default: false, description: "Preview only; writes no state and changes no file." },
        format: { type: "string", enum: ["json", "text", "ndjson"], default: "json" },
        events: { type: "string", description: "Also write the events as JSON Lines to this file." },
      },
      additionalProperties: false,
    },
    output: success(
      "agent.task.run",
      {
        dryRun: { type: "boolean" },
        outcome: { type: "string", enum: ["prepared", "awaiting-approval", "budget-exceeded", "failed"] },
        reused: { type: "boolean", description: "True when this is the identical earlier result." },
        task: taskDocument,
        resultRef: { type: ["string", "null"] },
        progress,
        cost: costAndBudget.cost,
        budget: costAndBudget.budget,
        stopReason: costAndBudget.stopReason,
        context: { type: "object" },
        writes: { type: "array", items: { type: "string" } },
        problems: { type: "array", items: problemSchema },
      },
      ["dryRun", "outcome", "reused", "task", "progress", "cost", "budget", "stopReason", "context", "writes"],
    ),
  },
  {
    name: "agent.task.status",
    summary: "Read a task, its last run result, and the approvals recorded for it.",
    cli: "mizzen agent task status <id> [dir] [--format json|text]",
    input: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" }, ...taskOptionProperties },
      additionalProperties: false,
    },
    output: success(
      "agent.task.status",
      {
        task: taskDocument,
        run: { type: ["object", "null"], description: "The last run result, or null." },
        approvals: { type: "array", items: { type: "string" } },
      },
      ["task", "run", "approvals"],
    ),
  },
  {
    name: "agent.task.resume",
    summary: "Resume a waiting or blocked task by id, optionally recording review approvals.",
    cli: "mizzen agent task resume <id> [dir] [--approve <ids|all>] [--format json|text]",
    input: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        ...taskOptionProperties,
        approve: { type: "string", description: "Comma-separated review criterion ids, or all." },
      },
      additionalProperties: false,
    },
    output: success(
      "agent.task.resume",
      { task: taskDocument, approvals: { type: "array", items: { type: "string" } } },
      ["task", "approvals"],
    ),
  },
  {
    name: "agent.task.cancel",
    summary: "Cancel a task by id; a repeat on a finished task returns the same conflict.",
    cli: "mizzen agent task cancel <id> [dir] [--reason <text>] [--format json|text]",
    input: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        ...taskOptionProperties,
        reason: { type: "string", description: "Why the task is canceled; recorded in its events." },
      },
      additionalProperties: false,
    },
    output: success("agent.task.cancel", { task: taskDocument }, ["task"]),
  },
  {
    name: "pack",
    summary: "Compile task-aware context for a registered contract or an ad-hoc request.",
    cli: "mizzen pack [dir] --task <file> | --request <file|-> [--format markdown|json] [--out <file>]",
    input: {
      type: "object",
      properties: {
        dir: { type: "string", default: "." },
        task: { type: "string", description: "A versioned task contract file." },
        request: { type: "string", description: "A versioned context request file, or - for stdin." },
        budget: { type: "integer", minimum: 1 },
        format: { type: "string", enum: ["markdown", "json"], default: "markdown" },
        out: { type: "string" },
      },
      additionalProperties: false,
    },
    output: { type: "object", description: "The compiled context evidence, or Markdown when format is markdown." },
  },
  {
    name: "edit.transaction",
    summary: "Apply a versioned multi-file edit atomically; a dry run writes nothing.",
    cli: "mizzen edit transaction <file.json> [dir] --dry-run --rebase --approve --format text|json",
    input: {
      type: "object",
      required: ["file"],
      properties: {
        dir: { type: "string", default: "." },
        file: { type: "string" },
        dryRun: { type: "boolean" },
        rebase: { type: "boolean" },
        approve: { type: "boolean" },
        format: { type: "string", enum: ["text", "json"], default: "text" },
      },
      additionalProperties: false,
    },
    output: { type: "object", description: "The applied files, checks, conflicts, and record paths." },
  },
  {
    name: "edit.verify",
    summary: "Check an edit proof or a verification proof against a site.",
    cli: "mizzen edit verify <proof.json> --site <dir> --doctor --input <file> --format text|json",
    input: {
      type: "object",
      required: ["proof"],
      properties: {
        proof: { type: "string" },
        site: { type: "string", default: "." },
        doctor: { type: "boolean" },
        input: { type: "string" },
        format: { type: "string", enum: ["text", "json"], default: "text" },
      },
      additionalProperties: false,
    },
    output: { type: "object", description: "The verified files, checks, and doctor levels." },
  },
  {
    name: "trace.replay",
    summary: "Check a recorded trace's order, input hashes, and results; writes nothing.",
    cli: "mizzen trace replay <trace.json> [--snapshot <id>] [--expect <trace.json>] [--json]",
    input: {
      type: "object",
      required: ["trace"],
      properties: { trace: { type: "string" }, snapshot: { type: "string" }, expect: { type: "string" }, json: { type: "boolean" } },
      additionalProperties: false,
    },
    output: { type: "object", description: "The replay result, with each mismatch and its event." },
  },
];

/** The command names a client can ask for, in the order the list prints. */
export function schemaNames(): readonly string[] {
  return COMMANDS.map((entry) => entry.name);
}

/** The list of names and one-line summaries. */
export function schemaList(): Record<string, unknown> {
  return {
    version: SCHEMA_VERSION,
    commands: COMMANDS.map((entry) => ({ name: entry.name, summary: entry.summary })),
  };
}

/** One command's full contract, or `undefined` for an unknown name. */
export function commandSchema(name: string): Record<string, unknown> | undefined {
  const found = COMMANDS.find((entry) => entry.name === name);
  if (found === undefined) return undefined;
  return {
    version: SCHEMA_VERSION,
    command: found.name,
    cli: found.cli,
    summary: found.summary,
    input: found.input,
    output: found.output,
    exitCodes: EXIT_CODES,
  };
}

/** The commands not found, as a problem that names the alternatives. */
export function unknownSchema(name: string): readonly TaskProblem[] {
  return [
    {
      path: "/name",
      code: "agent.schema-unknown",
      message: `No command schema named \`${name}\`; choose one of ${schemaNames().map((entry) => `\`${entry}\``).join(", ")}.`,
    },
  ];
}
