/**
 * `mizzen agent`: the machine-readable surface. One command, eight subcommands, JSON by default.
 *
 * `capabilities` says what is installed and what to use when something is not; `schema` documents a
 * command's input, output, and exit codes; `task` registers, previews, runs, reads, resumes, and cancels
 * a versioned task. Every document is versioned, every problem carries a JSON Pointer, and stdout is
 * only the document: diagnostics go to stderr.
 */
import type { TaskProblem } from "../contracts/task.ts";
import { version } from "../index.ts";
import { CAPABILITIES, capabilitiesDocument } from "./capabilities.ts";
import { emit, refuse, type AgentFormat, type AgentIo } from "./io.ts";
import { registerCommand } from "./register.ts";
import {
  cancelCommand,
  previewCommand,
  resumeCommand,
  runCommand,
  statusCommand,
} from "./run.ts";
import { commandSchema, schemaList, unknownSchema } from "./schema.ts";

/** The agent subcommands, for help and errors. */
export const AGENT_COMMANDS = ["capabilities", "schema", "task"] as const;

/** The `task` subcommands, for help and errors. */
export const AGENT_TASK_COMMANDS = ["register", "preview", "run", "status", "resume", "cancel"] as const;

/** The agent help, printed by `mizzen agent --help` and by a usage error. */
export const agentUsage = `Usage: mizzen agent <command> [options]

Commands:
  capabilities               Print versioned JSON capabilities: task, pack, edit, verify, replay, eval
  schema [name]              Print a command's input schema, output schema, and exit codes
  task register [dir]        Register a task from --file <path> or --stdin
  task preview [dir]         Show proposed changes, required checks, and affected outputs; writes nothing
  task run <id> [dir]        Compile a registered task; --dry-run previews; --events <file> writes JSON Lines
  task status <id> [dir]     Print a task, its last run result, and its approvals
  task resume <id> [dir]     Resume a waiting or blocked task; --approve <ids|all>
  task cancel <id> [dir]     Cancel a task; --reason <text>

Options:
  --file <path>      Task contract file for register and preview
  --stdin            Read the task contract from stdin instead of a file
  --dry-run          Run without writing state or changing a project file
  --approve <ids>    Comma-separated human-review criterion ids, or all
  --reason <text>    Why a task is canceled
  --events <file>    Also write the run's events as JSON Lines
  --format <format>  json (default), text, or ndjson for task run
  -h, --help         Show this help

Exit codes: 0 ok, 1 refused or failed, 2 usage or invalid input.`;

/** The raw options one agent subcommand accepts. */
interface RawOptions {
  readonly positionals: readonly string[];
  readonly file?: string;
  readonly stdin: boolean;
  readonly format?: string;
  readonly dryRun: boolean;
  readonly approve?: string;
  readonly reason?: string;
  readonly events?: string;
}

/** The flags each command accepts; anything else is a usage error. */
type Flag = "file" | "stdin" | "format" | "dry-run" | "approve" | "reason" | "events";

/** Parses the shared option shape, refusing a flag the chosen command does not take. */
function parseOptions(args: readonly string[], allowed: readonly Flag[]): { readonly raw?: RawOptions; readonly problems?: readonly TaskProblem[] } {
  const positionals: string[] = [];
  let file: string | undefined;
  let stdin = false;
  let format: string | undefined;
  let dryRun = false;
  let approve: string | undefined;
  let reason: string | undefined;
  let events: string | undefined;
  const problems: TaskProblem[] = [];
  const take = (flag: string, index: number): string | undefined => {
    const value = args[index + 1];
    if (value === undefined || value.startsWith("-")) {
      problems.push({ path: `/${flag.replace(/^-+/, "")}`, code: "agent.usage", message: `${flag} needs a value.` });
      return undefined;
    }
    return value;
  };
  const permit = (flag: Flag): boolean => allowed.includes(flag);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-h" || arg === "--help") {
      problems.push({ path: "", code: "agent.help", message: "help requested" });
      break;
    }
    if (arg === "--stdin") {
      if (!permit("stdin")) problems.push({ path: "/stdin", code: "agent.usage", message: "--stdin is not an option of this command." });
      else stdin = true;
    } else if (arg === "--dry-run") {
      if (!permit("dry-run")) problems.push({ path: "/dry-run", code: "agent.usage", message: "--dry-run is not an option of this command." });
      else dryRun = true;
    } else if (arg === "--file") {
      if (!permit("file")) problems.push({ path: "/file", code: "agent.usage", message: "--file is not an option of this command." });
      else {
        const value = take(arg, i);
        if (value !== undefined) {
          file = value;
          i += 1;
        }
      }
    } else if (arg === "--format") {
      if (!permit("format")) problems.push({ path: "/format", code: "agent.usage", message: "--format is not an option of this command." });
      else {
        const value = take(arg, i);
        if (value !== undefined) {
          format = value;
          i += 1;
        }
      }
    } else if (arg === "--approve") {
      if (!permit("approve")) problems.push({ path: "/approve", code: "agent.usage", message: "--approve is not an option of this command." });
      else {
        const value = take(arg, i);
        if (value !== undefined) {
          approve = value;
          i += 1;
        }
      }
    } else if (arg === "--reason") {
      if (!permit("reason")) problems.push({ path: "/reason", code: "agent.usage", message: "--reason is not an option of this command." });
      else {
        const value = take(arg, i);
        if (value !== undefined) {
          reason = value;
          i += 1;
        }
      }
    } else if (arg === "--events") {
      if (!permit("events")) problems.push({ path: "/events", code: "agent.usage", message: "--events is not an option of this command." });
      else {
        const value = take(arg, i);
        if (value !== undefined) {
          events = value;
          i += 1;
        }
      }
    } else if (arg.startsWith("-")) {
      problems.push({ path: "", code: "agent.usage", message: `unknown option: ${arg}` });
    } else {
      positionals.push(arg);
    }
  }

  if (problems.length > 0) return { problems };
  return {
    raw: {
      positionals,
      stdin,
      dryRun,
      ...(file === undefined ? {} : { file }),
      ...(format === undefined ? {} : { format }),
      ...(approve === undefined ? {} : { approve }),
      ...(reason === undefined ? {} : { reason }),
      ...(events === undefined ? {} : { events }),
    },
  };
}

/** Resolves `--format` to one the command prints, or a usage problem. */
function formatOf(raw: RawOptions, formats: readonly AgentFormat[]): { readonly format?: AgentFormat; readonly problems?: readonly TaskProblem[] } {
  const format = (raw.format ?? "json") as AgentFormat;
  if (!formats.includes(format)) {
    return {
      problems: [{
        path: "/format",
        code: "agent.usage",
        message: `--format must be ${formats.join(" or ")}, not ${raw.format ?? ""}.`,
      }],
    };
  }
  return { format };
}

/** Runs `mizzen agent ...` and returns the CLI exit code. */
export async function runAgent(args: readonly string[], io: AgentIo): Promise<number> {
  const [command, ...rest] = args;
  if (command === undefined) {
    io.error(agentUsage);
    return 2;
  }
  if (command === "-h" || command === "--help" || command === "help") {
    io.log(agentUsage);
    return 0;
  }
  if (rest.includes("-h") || rest.includes("--help")) {
    io.log(agentUsage);
    return 0;
  }

  if (command === "capabilities") {
    const parsed = parseOptions(rest, ["format"]);
    if (parsed.raw === undefined) return refuse(io, "json", "agent.capabilities", parsed.problems ?? [], 2);
    const chosen = formatOf(parsed.raw, ["json", "text"]);
    if (chosen.format === undefined) return refuse(io, "json", "agent.capabilities", chosen.problems ?? [], 2);
    const capabilities = capabilitiesDocument(version);
    const document = {
      version: 1,
      ok: true,
      command: "agent.capabilities",
      package: capabilities.package,
      capabilities: capabilities.capabilities,
    };
    const missing = CAPABILITIES.filter((entry) => !entry.available).map((entry) => entry.name);
    const summary = `mizzen: ${CAPABILITIES.length - missing.length} of ${CAPABILITIES.length} capabilities available${missing.length === 0 ? "" : `; unavailable: ${missing.join(", ")}`}.`;
    return emit(io, chosen.format, document, summary);
  }

  if (command === "schema") {
    const parsed = parseOptions(rest, ["format"]);
    if (parsed.raw === undefined) return refuse(io, "json", "agent.schema", parsed.problems ?? [], 2);
    const chosen = formatOf(parsed.raw, ["json", "text"]);
    if (chosen.format === undefined) return refuse(io, "json", "agent.schema", chosen.problems ?? [], 2);
    if (parsed.raw.positionals.length > 1) {
      return refuse(io, chosen.format, "agent.schema", [{ path: "", code: "agent.usage", message: "agent schema takes at most one command name." }], 2);
    }
    const name = parsed.raw.positionals[0];
    if (name === undefined) {
      const list = schemaList();
      const commands = list.commands as readonly { name: string; summary: string }[];
      const document = { version: 1, ok: true, command: "agent.schema", commands };
      return emit(io, chosen.format, document, `mizzen: ${commands.length} documented commands; pass one name for its schema.`);
    }
    const entry = commandSchema(name);
    if (entry === undefined) return refuse(io, chosen.format, "agent.schema", unknownSchema(name), 2);
    const document = {
      version: 1,
      ok: true,
      command: "agent.schema",
      name,
      cli: entry.cli,
      summary: entry.summary,
      input: entry.input,
      output: entry.output,
      exitCodes: entry.exitCodes,
    };
    return emit(io, chosen.format, document, `mizzen: ${name}: ${String(entry.summary)}`);
  }

  if (command !== "task") {
    return refuse(io, "json", "agent", [{ path: "", code: "agent.usage", message: `unknown agent command: ${command}; choose capabilities, schema, or task.` }], 2);
  }

  const [subcommand, ...taskArgs] = rest;
  if (subcommand === undefined || subcommand === "-h" || subcommand === "--help" || subcommand === "help") {
    io.log(agentUsage);
    return subcommand === undefined ? 2 : 0;
  }

  if (subcommand === "register" || subcommand === "preview") {
    const parsed = parseOptions(taskArgs, ["file", "stdin", "format"]);
    if (parsed.raw === undefined) return refuse(io, "json", `agent.task.${subcommand}`, parsed.problems ?? [], 2);
    const chosen = formatOf(parsed.raw, ["json", "text"]);
    if (chosen.format === undefined) return refuse(io, "json", `agent.task.${subcommand}`, chosen.problems ?? [], 2);
    if (parsed.raw.positionals.length > 1) {
      return refuse(io, chosen.format, `agent.task.${subcommand}`, [{ path: "", code: "agent.usage", message: `${subcommand} takes at most one site folder.` }], 2);
    }
    const root = parsed.raw.positionals[0] ?? ".";
    const source = { ...(parsed.raw.file === undefined ? {} : { file: parsed.raw.file }), stdin: parsed.raw.stdin };
    if (subcommand === "register") {
      return registerCommand({ root, source, format: chosen.format }, io);
    }
    return previewCommand({ root, source, format: chosen.format }, io);
  }

  if (subcommand === "run") {
    const parsed = parseOptions(taskArgs, ["dry-run", "format", "events"]);
    if (parsed.raw === undefined) return refuse(io, "json", "agent.task.run", parsed.problems ?? [], 2);
    const chosen = formatOf(parsed.raw, ["json", "text", "ndjson"]);
    if (chosen.format === undefined) return refuse(io, "json", "agent.task.run", chosen.problems ?? [], 2);
    const [id, root] = parsed.raw.positionals;
    if (id === undefined) {
      return refuse(io, chosen.format, "agent.task.run", [{ path: "/id", code: "agent.usage", message: "agent task run needs a task id." }], 2);
    }
    if (parsed.raw.positionals.length > 2) {
      return refuse(io, chosen.format, "agent.task.run", [{ path: "", code: "agent.usage", message: "agent task run takes one task id and one site folder." }], 2);
    }
    return runCommand({
      root: root ?? ".",
      id,
      dryRun: parsed.raw.dryRun,
      format: chosen.format,
      ...(parsed.raw.events === undefined ? {} : { eventsFile: parsed.raw.events }),
    }, io);
  }

  if (subcommand === "status") {
    const parsed = parseOptions(taskArgs, ["format"]);
    if (parsed.raw === undefined) return refuse(io, "json", "agent.task.status", parsed.problems ?? [], 2);
    const chosen = formatOf(parsed.raw, ["json", "text"]);
    if (chosen.format === undefined) return refuse(io, "json", "agent.task.status", chosen.problems ?? [], 2);
    const [id, root] = parsed.raw.positionals;
    if (id === undefined) return refuse(io, chosen.format, "agent.task.status", [{ path: "/id", code: "agent.usage", message: "agent task status needs a task id." }], 2);
    if (parsed.raw.positionals.length > 2) return refuse(io, chosen.format, "agent.task.status", [{ path: "", code: "agent.usage", message: "agent task status takes one task id and one site folder." }], 2);
    return statusCommand({ root: root ?? ".", id, format: chosen.format }, io);
  }

  if (subcommand === "resume") {
    const parsed = parseOptions(taskArgs, ["approve", "format"]);
    if (parsed.raw === undefined) return refuse(io, "json", "agent.task.resume", parsed.problems ?? [], 2);
    const chosen = formatOf(parsed.raw, ["json", "text"]);
    if (chosen.format === undefined) return refuse(io, "json", "agent.task.resume", chosen.problems ?? [], 2);
    const [id, root] = parsed.raw.positionals;
    if (id === undefined) return refuse(io, chosen.format, "agent.task.resume", [{ path: "/id", code: "agent.usage", message: "agent task resume needs a task id." }], 2);
    if (parsed.raw.positionals.length > 2) return refuse(io, chosen.format, "agent.task.resume", [{ path: "", code: "agent.usage", message: "agent task resume takes one task id and one site folder." }], 2);
    const approve = parsed.raw.approve === undefined
      ? undefined
      : parsed.raw.approve === "all"
        ? "all"
        : parsed.raw.approve.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
    return resumeCommand({ root: root ?? ".", id, format: chosen.format, ...(approve === undefined ? {} : { approve }) }, io);
  }

  if (subcommand === "cancel") {
    const parsed = parseOptions(taskArgs, ["reason", "format"]);
    if (parsed.raw === undefined) return refuse(io, "json", "agent.task.cancel", parsed.problems ?? [], 2);
    const chosen = formatOf(parsed.raw, ["json", "text"]);
    if (chosen.format === undefined) return refuse(io, "json", "agent.task.cancel", chosen.problems ?? [], 2);
    const [id, root] = parsed.raw.positionals;
    if (id === undefined) return refuse(io, chosen.format, "agent.task.cancel", [{ path: "/id", code: "agent.usage", message: "agent task cancel needs a task id." }], 2);
    if (parsed.raw.positionals.length > 2) return refuse(io, chosen.format, "agent.task.cancel", [{ path: "", code: "agent.usage", message: "agent task cancel takes one task id and one site folder." }], 2);
    return cancelCommand({ root: root ?? ".", id, reason: parsed.raw.reason ?? "Canceled by the agent CLI.", format: chosen.format }, io);
  }

  return refuse(io, "json", "agent.task", [{ path: "", code: "agent.usage", message: `unknown task subcommand: ${subcommand}; choose ${AGENT_TASK_COMMANDS.join(", ")}.` }], 2);
}
