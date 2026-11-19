/**
 * `mizzen trace show|search|replay|export|handoff <trace.json>`: read a recorded trace, never run it.
 *
 * `show` prints the task, snapshot, stages, statuses, and evidence references. `search` filters
 * events by stage, file, task, and status. `replay` checks the recorded events against their order,
 * input hashes, and results, optionally against an expected replay, and writes nothing. `export`
 * writes only the authorized projection, with a file name derived from the trace hashes. `handoff`
 * prints what a new agent needs: the state, changes, decisions, and unfinished calls.
 *
 * Every subcommand reads one JSON file. A malformed trace is refused with its own path and code; a
 * replay difference exits 1; usage errors exit 2. `--json` prints the structured result instead of
 * the text summary.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { TraceDocument, TraceEventStatus, TraceStage } from "../contracts/trace.ts";
import { exportJson, exportTrace } from "../trace/export.ts";
import { handoffOf } from "../trace/handoff.ts";
import { parseTrace } from "../trace/parse.ts";
import { compactSummary, searchTrace, summaryOf, TRACE_STAGES, TRACE_STATUSES } from "../trace/query.ts";
import { replayTrace } from "../trace/replay.ts";

/** Where the command prints. */
export interface TraceIo {
  readonly write: (message: string) => void;
  readonly error: (message: string) => void;
}

export const traceUsage = `Usage: mizzen trace <subcommand> <trace.json> [options]

  show <trace.json>         Print the task, snapshot, stages, statuses, and evidence
  search <trace.json>       Print events matching --stage, --file, --task, and --status
  replay <trace.json>       Check the recorded order, input hashes, and results; writes nothing
  export <trace.json>       Write or print only the authorized fields
  handoff <trace.json>      Print the state, changes, decisions, and remaining work

Options:
  --json                 Print the structured result
  --stage <stage>        For search: context, edit, verify, decision, or handoff
  --file <path>          For search: a site-relative file
  --task <id|text>       For search: a task id or part of its goal
  --status <status>      For search: ok, failed, refused, or skipped
  --snapshot <id>        For replay: the snapshot the replay must run against
  --expect <trace.json>  For replay: a second trace to compare, event by event
  --out <dir>            For export: write <dir>/<trace-id>.json instead of stdout
`;

/** One parsed invocation. */
interface TraceArgs {
  readonly subcommand: "show" | "search" | "replay" | "export" | "handoff";
  readonly file: string;
  readonly json: boolean;
  readonly stage?: TraceStage;
  readonly eventFile?: string;
  readonly task?: string;
  readonly status?: TraceEventStatus;
  readonly snapshot?: string;
  readonly expect?: string;
  readonly out?: string;
}

/** Parses `trace` arguments after the command name. */
function parseTraceArgs(args: readonly string[]): TraceArgs | { readonly error: string } {
  const [subcommand, ...rest] = args;
  if (subcommand === undefined) return { error: "trace needs a subcommand: show, search, replay, export, or handoff" };
  if (subcommand === "-h" || subcommand === "--help") return { error: "" };
  if (
    subcommand !== "show" &&
    subcommand !== "search" &&
    subcommand !== "replay" &&
    subcommand !== "export" &&
    subcommand !== "handoff"
  ) {
    return { error: `unknown trace subcommand: ${subcommand}` };
  }

  let file: string | undefined;
  let json = false;
  let stage: TraceStage | undefined;
  let eventFile: string | undefined;
  let task: string | undefined;
  let status: TraceEventStatus | undefined;
  let snapshot: string | undefined;
  let expect: string | undefined;
  let out: string | undefined;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    const value = (): string | { readonly error: string } => {
      const next = rest[++index];
      if (next === undefined || next.startsWith("-")) return { error: `${arg} needs a value` };
      return next;
    };
    if (arg === "-h" || arg === "--help") return { error: "" };
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg.startsWith("-")) {
      const given = value();
      if (typeof given !== "string") return given;
      if (arg === "--stage") {
        if (!(TRACE_STAGES as readonly string[]).includes(given)) {
          return { error: `--stage must be one of: ${TRACE_STAGES.join(", ")}` };
        }
        stage = given as TraceStage;
      } else if (arg === "--file") {
        eventFile = given;
      } else if (arg === "--task") {
        task = given;
      } else if (arg === "--status") {
        if (!(TRACE_STATUSES as readonly string[]).includes(given)) {
          return { error: `--status must be one of: ${TRACE_STATUSES.join(", ")}` };
        }
        status = given as TraceEventStatus;
      } else if (arg === "--snapshot") {
        snapshot = given;
      } else if (arg === "--expect") {
        expect = given;
      } else if (arg === "--out") {
        out = given;
      } else {
        return { error: `unknown option: ${arg}` };
      }
      continue;
    }
    if (file === undefined) file = arg;
    else return { error: `unexpected argument: ${arg}` };
  }

  if (file === undefined) return { error: `trace ${subcommand} needs a trace file` };
  if (subcommand !== "search" && (stage !== undefined || eventFile !== undefined || task !== undefined || status !== undefined)) {
    return { error: `--stage, --file, --task, and --status are only valid for trace search` };
  }
  if (subcommand !== "replay" && (snapshot !== undefined || expect !== undefined)) {
    return { error: `--snapshot and --expect are only valid for trace replay` };
  }
  if (subcommand !== "export" && out !== undefined) return { error: "--out is only valid for trace export" };
  return {
    subcommand,
    file,
    json,
    ...(stage === undefined ? {} : { stage }),
    ...(eventFile === undefined ? {} : { eventFile }),
    ...(task === undefined ? {} : { task }),
    ...(status === undefined ? {} : { status }),
    ...(snapshot === undefined ? {} : { snapshot }),
    ...(expect === undefined ? {} : { expect }),
    ...(out === undefined ? {} : { out }),
  };
}

/** Reads and validates one trace file. */
async function readTrace(file: string, io: TraceIo): Promise<TraceDocument | undefined> {
  let text: string;
  try {
    text = await readFile(resolve(file), "utf8");
  } catch (err) {
    io.error(`mizzen: trace: cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    io.error(`mizzen: trace: ${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
  const parsed = parseTrace(value);
  if (parsed.trace === undefined) {
    for (const problem of parsed.problems) {
      io.error(`mizzen: trace: ${file}${problem.path}: ${problem.message} (${problem.code})`);
    }
    return undefined;
  }
  return parsed.trace;
}

/** Runs `mizzen trace`; returns the exit code. */
export async function runTrace(args: readonly string[], io: TraceIo): Promise<number> {
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help" || args[0] === "help") {
    io.write(`${traceUsage.replace(/\n$/, "")}\n`);
    return 0;
  }
  const parsed = parseTraceArgs(args);
  if ("error" in parsed) {
    if (parsed.error === "") {
      io.write(`${traceUsage.replace(/\n$/, "")}\n`);
      return 0;
    }
    io.error(`mizzen: ${parsed.error}\n\n${traceUsage}`);
    return 2;
  }

  const trace = await readTrace(parsed.file, io);
  if (trace === undefined) return 2;

  if (parsed.subcommand === "show") {
    const summary = compactSummary(summaryOf(trace));
    if (parsed.json) {
      io.write(`${JSON.stringify(summary, null, 2)}\n`);
      return 0;
    }
    io.write(showText(trace));
    return 0;
  }

  if (parsed.subcommand === "search") {
    const events = searchTrace(trace, {
      ...(parsed.stage === undefined ? {} : { stage: parsed.stage }),
      ...(parsed.eventFile === undefined ? {} : { file: parsed.eventFile }),
      ...(parsed.task === undefined ? {} : { task: parsed.task }),
      ...(parsed.status === undefined ? {} : { status: parsed.status }),
    });
    if (parsed.json) {
      io.write(`${JSON.stringify(events, null, 2)}\n`);
      return 0;
    }
    if (events.length === 0) io.write("mizzen trace: no events match\n");
    for (const event of events) {
      const file = event.file === undefined ? "" : ` ${event.file}`;
      const result = event.result === null ? "" : ` -> ${event.result}`;
      io.write(`#${event.sequence} ${event.stage} ${event.kind} ${event.capability} ${event.status}${file}${result}\n`);
    }
    return 0;
  }

  if (parsed.subcommand === "replay") {
    let expect: unknown;
    if (parsed.expect !== undefined) {
      try {
        expect = JSON.parse(await readFile(resolve(parsed.expect), "utf8")) as unknown;
      } catch (err) {
        io.error(`mizzen: trace: cannot read ${parsed.expect}: ${err instanceof Error ? err.message : String(err)}`);
        return 2;
      }
    }
    const result = replayTrace(trace, {
      ...(parsed.snapshot === undefined ? {} : { snapshot: parsed.snapshot }),
      ...(expect === undefined ? {} : { expect }),
    });
    if (parsed.json) {
      io.write(`${JSON.stringify(result, null, 2)}\n`);
      return result.ok ? 0 : 1;
    }
    if (result.ok) {
      io.write(`mizzen trace: replay ok: ${result.events} events at snapshot ${result.snapshot}; nothing was written\n`);
      return 0;
    }
    for (const problem of result.problems) io.error(`mizzen: trace: ${problem.message} (${problem.code})`);
    for (const difference of result.differences) {
      io.error(`mizzen: trace: ${difference.path}: expected ${difference.expected}, got ${difference.actual} (${difference.kind})`);
    }
    return 1;
  }

  if (parsed.subcommand === "export") {
    let exported;
    try {
      exported = exportTrace(trace);
    } catch (err) {
      io.error(`mizzen: trace: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
    if (parsed.out === undefined) {
      io.write(exportJson(exported));
      return 0;
    }
    const folder = resolve(parsed.out);
    await mkdir(folder, { recursive: true });
    await writeFile(resolve(folder, exported.filename), exportJson(exported), "utf8");
    io.write(`mizzen trace: exported ${exported.filename}\n`);
    return 0;
  }

  const handoff = handoffOf(trace);
  if (parsed.json) {
    io.write(`${JSON.stringify(handoff, null, 2)}\n`);
    return 0;
  }
  io.write(handoffText(handoff));
  return 0;
}

/** The text `show` prints. */
function showText(trace: TraceDocument): string {
  const summary = summaryOf(trace);
  const lines = [
    `trace ${summary.id}`,
    `task ${summary.task.id} ${summary.task.goal}`,
    `snapshot ${summary.snapshot}`,
    `events ${summary.events}, receipts ${summary.receipts}`,
    ...summary.stages.filter((row) => row.events > 0).map((row) => `stage ${row.stage} ${row.events}`),
    ...summary.statuses.filter((row) => row.events > 0).map((row) => `status ${row.status} ${row.events}`),
    ...summary.evidence.map((reference) => `evidence ${reference}`),
    ...(summary.truncation === undefined ? [] : [`truncation ${summary.truncation.summary}`]),
  ];
  return `${lines.join("\n")}\n`;
}

/** The text `handoff` prints. */
function handoffText(handoff: ReturnType<typeof handoffOf>): string {
  const lines = [
    `task ${handoff.task.id} ${handoff.task.goal}`,
    `snapshot ${handoff.snapshot}`,
    `state ${handoff.state ?? "none"}`,
    ...handoff.changes.map((receipt) => `change ${receipt.kind} ${receipt.reference}`),
    ...handoff.decisions.map((decision) => `decision ${decision.sequence} ${decision.kind} ${decision.reason} [${decision.policy}]`),
    ...handoff.remaining.map((item) => `remaining ${item.sequence} ${item.capability} ${item.status}${item.reason === undefined ? "" : ` ${item.reason}`}`),
    ...handoff.receipts.map((receipt) => `receipt ${receipt.kind} ${receipt.reference}`),
    ...(handoff.truncation === undefined ? [] : [`truncation ${handoff.truncation.summary}`]),
  ];
  return `${lines.join("\n")}\n`;
}
