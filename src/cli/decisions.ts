/**
 * `mizzen decisions [dir]`: reports every versioned decision record, its lifecycle, the decisions in effect, and the
 * answers to a "why" question.
 *
 * The report is deterministic: records are sorted by id, evidence by kind and value, and review is measured against an
 * explicit version or snapshot, never the clock. A private source, rationale, or rejected alternative never appears in
 * the report, its JSON, or a "why" answer: it is replaced with a fixed placeholder.
 *
 * The `why` subcommand answers from a behavior id (`behavior:cache-hit`), a page URL or source path, or any stable id a
 * decision names. It returns the current decision, its rationale and rejected alternatives, and the decisions that came
 * before, each with a citation.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Diagnostic } from "../contracts/diagnostic.ts";
import type { DecisionReport, DecisionWhy } from "../contracts/decisions.ts";
import type { AccessPolicy } from "../contracts/permissions.ts";
import { loadDecisions } from "../decisions/load.ts";
import { decisionReadable } from "../decisions/access.ts";
import { decisionReportOf } from "../decisions/report.ts";
import { why } from "../decisions/why.ts";
import { buildModel } from "../model/build.ts";
import { parseAccessPolicy } from "../permissions/policy.ts";
import { formatText } from "../pipeline/diagnostics.ts";

/** Where the command prints. */
export interface DecisionsIo {
  readonly log: (message: string) => void;
  readonly error: (message: string) => void;
}

export const decisionsUsage = `Usage: mizzen decisions [dir] [options]
       mizzen decisions why <subject> [dir] [options]

  --json               Print the versioned report or answer
  --format <text|json> Choose the output; \`--json\` is the same as \`--format json\`
  --version <v>        Resolve the current decision at this documentation version, such as v1.2
  --snapshot <id>      Resolve the current decision at this build snapshot
  --policy <file>      Apply an access policy: a record it refuses is left out, and its citation obeys the same policy
  --allow <a,b>        Audiences the caller may read; without it, a record with an audience is left out
  --out <file>         Write the report (or answer) to this file instead of stdout
  --fail-on <status>   Exit 1 when any decision has this status (repeatable)
`;

/** The lifecycle statuses a caller can fail on. */
const FAIL_STATUSES = ["proposed", "accepted", "superseded", "deprecated", "rejected"] as const;
type FailStatus = (typeof FAIL_STATUSES)[number];

interface DecisionsArgs {
  readonly root: string;
  readonly why?: string;
  readonly format: "text" | "json";
  readonly version?: string;
  readonly snapshot?: string;
  readonly policy?: string;
  readonly allow: readonly string[];
  readonly out?: string;
  readonly failOn: readonly FailStatus[];
}

/** Parses the command's arguments. */
function parseDecisions(args: readonly string[]): DecisionsArgs | { readonly error: string } {
  let root = ".";
  let whySubject: string | undefined;
  let format: "text" | "json" | undefined;
  let version: string | undefined;
  let snapshot: string | undefined;
  let policy: string | undefined;
  let out: string | undefined;
  const allow: string[] = [];
  const failOn: FailStatus[] = [];
  let sawWhy = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "-h" || arg === "--help") return { error: "" };
    if (arg === "--json") {
      format = "json";
      continue;
    }
    if (arg.startsWith("-")) {
      const next = args[++index];
      if (next === undefined || next.startsWith("-")) return { error: `${arg} needs a value` };
      if (arg === "--format") {
        if (next !== "text" && next !== "json") return { error: "--format must be text or json" };
        format = next;
      } else if (arg === "--version") version = next;
      else if (arg === "--snapshot") snapshot = next;
      else if (arg === "--policy") policy = next;
      else if (arg === "--out") out = next;
      else if (arg === "--allow") allow.push(...next.split(",").map((item) => item.trim()).filter((item) => item !== ""));
      else if (arg === "--fail-on") {
        for (const value of next.split(",").map((item) => item.trim())) {
          if (!(FAIL_STATUSES as readonly string[]).includes(value)) {
            return { error: `--fail-on names "${value}"; use one of ${FAIL_STATUSES.join(", ")}` };
          }
          failOn.push(value as FailStatus);
        }
      } else return { error: `unknown option: ${arg}` };
      continue;
    }
    if (arg === "why" && !sawWhy && whySubject === undefined) {
      sawWhy = true;
      continue;
    }
    if (sawWhy && whySubject === undefined) {
      whySubject = arg;
      continue;
    }
    if (root === ".") root = arg;
    else return { error: `unexpected argument: ${arg}` };
  }
  if (sawWhy && whySubject === undefined) return { error: "why needs a subject, such as behavior:cache-hit or /guide/caching/" };
  return {
    root,
    format: format ?? "text",
    ...(whySubject === undefined ? {} : { why: whySubject }),
    ...(version === undefined ? {} : { version }),
    ...(snapshot === undefined ? {} : { snapshot }),
    ...(policy === undefined ? {} : { policy }),
    allow,
    ...(out === undefined ? {} : { out }),
    failOn,
  };
}

/** Writes a file, creating its folder. */
async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
}

/** Reads an access policy, or explains why it cannot. */
async function readPolicy(path: string): Promise<AccessPolicy | { readonly error: string }> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    const parsed = parseAccessPolicy(value);
    if (parsed.policy === undefined) {
      return { error: `${path} is not a valid access policy: ${parsed.problems.map((problem) => problem.message).join(" ")}` };
    }
    return parsed.policy;
  } catch (error) {
    return { error: `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** The text form of a decision report: the counts, the problems, and the unresolved evidence. */
export function formatDecisionsText(report: DecisionReport): string {
  const lines = [`Decisions: ${report.entries.length} record${report.entries.length === 1 ? "" : "s"}`];
  lines.push(
    `  proposed ${report.counts.proposed}, accepted ${report.counts.accepted}, superseded ${report.counts.superseded}, deprecated ${report.counts.deprecated}, rejected ${report.counts.rejected}`,
  );
  if (report.problems.length > 0) {
    lines.push("Problems:");
    for (const problem of report.problems) lines.push(`  ${problem.severity}: ${problem.message}`);
  }
  if (report.unresolvedEvidence.length > 0) {
    lines.push("Unresolved evidence:");
    for (const entry of report.unresolvedEvidence) lines.push(`  ${entry.decision} ${entry.kind}:${entry.value} (unknown)`);
  }
  return `${lines.join("\n")}\n`;
}

/** The text form of a "why" answer: the current decision, its reasoning, and the history. */
export function formatWhyText(answer: DecisionWhy): string {
  const lines = [`Why ${answer.subject}`];
  if (answer.current === undefined) {
    lines.push("  No decision in effect is visible for this subject.");
  } else {
    const current = answer.current;
    lines.push(`  Current: ${current.id} ${current.title} (${current.status}, ${current.date})`);
    if (current.rationale !== undefined) lines.push(`    Rationale: ${current.rationale}`);
    for (const alternative of current.alternatives) {
      lines.push(`    Rejected: ${alternative.name}${alternative.rejectedBecause === undefined ? "" : ` — ${alternative.rejectedBecause}`}`);
    }
    lines.push(`    Source: ${current.source}`);
  }
  for (const entry of answer.history) lines.push(`  History: ${entry.id} ${entry.title} (${entry.status}, ${entry.date})`);
  return `${lines.join("\n")}\n`;
}

/** Runs `mizzen decisions`; returns the exit code. */
export async function runDecisions(args: readonly string[], io: DecisionsIo): Promise<number> {
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    io.log(`${decisionsUsage.replace(/\n$/, "")}\n`);
    return 0;
  }
  const parsed = parseDecisions(args);
  if ("error" in parsed) {
    if (parsed.error === "") {
      io.log(`${decisionsUsage.replace(/\n$/, "")}\n`);
      return 0;
    }
    io.error(`mizzen: ${parsed.error}\n\n${decisionsUsage}`);
    return 2;
  }

  const root = resolve(parsed.root);
  const model = await buildModel(root);
  const errors: readonly Diagnostic[] = model.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) {
    io.error(formatText(errors).replace(/\n$/, ""));
    return 1;
  }

  const config = model.site.config.decisions;
  const loaded = await loadDecisions({
    root,
    site: model.site,
    dir: config?.dir ?? "docs/decisions",
    ...(config === undefined ? {} : { behaviors: (id: string) => config.behaviors.includes(id) }),
  });

  let policy: AccessPolicy | undefined;
  if (parsed.policy !== undefined) {
    const read = await readPolicy(resolve(parsed.policy));
    if ("error" in read) {
      io.error(`mizzen: ${read.error}`);
      return 2;
    }
    policy = read;
  }

  const query = {
    ...(parsed.version === undefined ? {} : { version: parsed.version }),
    ...(parsed.snapshot === undefined ? {} : { snapshot: parsed.snapshot }),
  };
  // A record the read policy refuses, or whose citation it refuses, is left out entirely; the report and the answer
  // both read the same filtered list, so a citation is never a way around the policy.
  const readable = loaded.records.filter((record) => decisionReadable(record, parsed.allow.length === 0 ? undefined : parsed.allow, policy));
  const report = decisionReportOf(readable, {
    ...(loaded.problems.length === 0 ? {} : { problems: loaded.problems }),
    ...(parsed.allow.length === 0 ? {} : { allow: parsed.allow }),
  });

  if (parsed.why !== undefined) {
    const answer = why(parsed.why, loaded.records, {
      lifecycle: loaded.lifecycle,
      query,
      ...(parsed.allow.length === 0 ? {} : { allow: parsed.allow }),
    });
    const text = parsed.format === "json" ? `${JSON.stringify(answer, null, 2)}\n` : formatWhyText(answer);
    if (parsed.out === undefined) io.log(text.replace(/\n$/, ""));
    else await writeAtomic(resolve(parsed.out), text);
    return answer.answerable ? 0 : 1;
  }

  const text = parsed.format === "json" ? `${JSON.stringify(report, null, 2)}\n` : formatDecisionsText(report);
  if (parsed.out === undefined) io.log(text.replace(/\n$/, ""));
  else await writeAtomic(resolve(parsed.out), text);

  const failures = parsed.failOn.filter((status) => report.counts[status] > 0);
  if (failures.length > 0) {
    io.error(`mizzen: decisions: ${failures.map((status) => `${report.counts[status]} ${status}`).join(", ")}`);
    return 1;
  }
  return 0;
}
