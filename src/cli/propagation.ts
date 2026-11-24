/**
 * `mizzen propagate <command> [dir]`: validate who consumes what, diff two locked snapshots, preview the downstream
 * impact, propose tasks, and apply the result under each consumer's approval policy.
 *
 * - `check` validates the consumer manifest and reports every invalid dependency at its JSON Pointer.
 * - `diff` prints the versioned semantic events between two locked snapshots.
 * - `preview` names the downstream snapshots, pages, and proposed tasks before anything is published.
 * - `propose` prints the task proposals with their scope, acceptance criteria, rationale, decisions, and evidence.
 * - `apply` records receipts and creates only the tasks the approval policy permits.
 * - `verify` marks a receipt verified after its downstream task passes.
 * - `receipt` reads back an earlier receipt by id.
 *
 * Every subcommand is offline. A snapshot path is one verified bundle, or a folder of `*.bundle.json` files; an
 * adjacent `<name>.decisions.json` adds that snapshot's public decisions.
 */
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { DecisionRecord } from "../contracts/decisions.ts";
import type {
  PropagationLedger,
  PropagationManifest,
  SemanticChange,
  SnapshotView,
  TaskProposal,
} from "../contracts/propagation.ts";
import { readBundle } from "../federation/bundle.ts";
import { byCodePoint, compareChanges } from "../propagation/contract.ts";
import { diffSnapshots } from "../propagation/diff.ts";
import { parsePropagationManifest, PROPAGATION_MANIFEST_FILE } from "../propagation/manifest.ts";
import { proposeTask } from "../propagation/propose.ts";
import {
  emptyLedger,
  findReceipt,
  isPropagationLedger,
  ledgerText,
  verifyReceipt,
  withVerifiedReceipt,
} from "../propagation/receipt.ts";
import { applyPropagation, previewPropagation } from "../propagation/run.ts";
import { snapshotOfBundle } from "../propagation/snapshot.ts";

/** Where the command prints. */
export interface PropagationIo {
  readonly log: (message: string) => void;
  readonly error: (message: string) => void;
}

export const propagationUsage = `Usage: mizzen propagate <command> [dir] [options]

Commands:
  check [dir]               Validate the consumer manifest (--manifest <file>, --json)
  diff [dir]                Diff two locked snapshots into semantic events (--baseline, --current, --json)
  preview [dir]             Show downstream snapshots, pages, and tasks (--baseline, --current, --json)
  propose [dir]             Print the task proposals for a change (--baseline, --current, --json)
  apply [dir]               Record receipts and propose permitted tasks (--baseline, --current, --approve)
  verify <receipt> [dir]    Mark a receipt verified after its downstream task passes
  receipt <receipt> [dir]   Print one stored receipt by id

Options:
  --manifest <file>    The consumer manifest; default <dir>/propagation.json
  --baseline <path>    The earlier locked snapshot: one bundle, or a folder of *.bundle.json files
  --current <path>     The later locked snapshot, in the same form
  --ledger <file>      The receipt ledger; default <dir>/.mizzen/propagation.json
  --approve <a,b>      Principals approving this run; each consumer accepts only its declared approvers
  --allow <a,b>        Audiences the caller may read; without it only public snapshots are visible
  --dry-run            For apply or verify: read and report without writing the ledger
  --json               Print the versioned JSON instead of text
`;

/** The parsed arguments. */
interface Args {
  readonly command: string;
  readonly root: string;
  readonly value?: string;
  readonly json: boolean;
  readonly dryRun: boolean;
  readonly manifest?: string;
  readonly baseline?: string;
  readonly current?: string;
  readonly ledger?: string;
  readonly approve: readonly string[];
  readonly allow: readonly string[];
}

/** Parses the arguments, or the reason they are not one this command reads. */
function parsePropagation(args: readonly string[]): Args | { readonly error: string } {
  const [command, ...tail] = args;
  if (command === undefined) return { error: "" };
  const known = ["check", "diff", "preview", "propose", "apply", "verify", "receipt"];
  if (!known.includes(command)) return { error: `unknown command: propagate ${command}` };
  const rest = tail;
  let root = ".";
  let value: string | undefined;
  let json = false;
  let dryRun = false;
  let manifest: string | undefined;
  let baseline: string | undefined;
  let current: string | undefined;
  let ledger: string | undefined;
  let approve: string[] = [];
  let allow: string[] = [];
  const list = (text: string): string[] => text.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
  const takesValue = new Set(["--manifest", "--baseline", "--current", "--ledger", "--approve", "--allow"]);
  const receiptCommand = command === "verify" || command === "receipt";
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (arg === "-h" || arg === "--help") return { error: "" };
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (takesValue.has(arg)) {
      const next = rest[++index];
      if (next === undefined || next.startsWith("-")) return { error: `${arg} needs a value` };
      if (arg === "--manifest") manifest = next;
      else if (arg === "--baseline") baseline = next;
      else if (arg === "--current") current = next;
      else if (arg === "--ledger") ledger = next;
      else if (arg === "--approve") approve = list(next);
      else allow = list(next);
      continue;
    }
    if (arg.startsWith("-")) return { error: `unknown option: ${arg}` };
    if (receiptCommand && value === undefined) value = arg;
    else if (root === ".") root = arg;
    else return { error: `unexpected argument: ${arg}` };
  }
  return {
    command,
    root,
    ...(value === undefined ? {} : { value }),
    json,
    dryRun,
    ...(manifest === undefined ? {} : { manifest }),
    ...(baseline === undefined ? {} : { baseline }),
    ...(current === undefined ? {} : { current }),
    ...(ledger === undefined ? {} : { ledger }),
    approve,
    allow,
  };
}

/** True when `path` is a folder. */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** The public decisions beside a bundle: `<name>.bundle.json` reads `<name>.decisions.json`. */
async function decisionsBeside(file: string): Promise<readonly DecisionRecord[] | undefined> {
  const candidate = file.endsWith(".bundle.json")
    ? `${file.slice(0, -".bundle.json".length)}.decisions.json`
    : `${file}.decisions.json`;
  let text: string;
  try {
    text = await readFile(candidate, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${candidate} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "object" && entry !== null && typeof (entry as { id?: unknown }).id === "string")) {
    throw new Error(`${candidate} must be a JSON array of decision records.`);
  }
  return parsed as readonly DecisionRecord[];
}

/** Reads one verified snapshot from a bundle file. */
async function snapshotFile(file: string): Promise<SnapshotView> {
  const text = await readFile(file, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${file} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const read = readBundle(parsed);
  if (read.bundle === undefined) throw new Error(`${file} was refused: ${read.problem}`);
  const decisions = await decisionsBeside(file);
  return snapshotOfBundle(read.bundle, decisions);
}

/** Reads one path as a map of verified snapshots by project. */
async function readSnapshots(path: string): Promise<Map<string, SnapshotView>> {
  const full = resolve(path);
  if (!(await isDirectory(full))) {
    const snapshot = await snapshotFile(full);
    return new Map([[snapshot.project, snapshot]]);
  }
  const names = (await readdir(full)).filter((name) => name.endsWith(".bundle.json")).sort(byCodePoint);
  if (names.length === 0) throw new Error(`${path} holds no *.bundle.json file.`);
  const snapshots = new Map<string, SnapshotView>();
  for (const name of names) {
    const snapshot = await snapshotFile(join(full, name));
    snapshots.set(snapshot.project, snapshot);
  }
  return snapshots;
}

/** Reads and validates the consumer manifest, or throws with every problem listed. */
async function readManifest(path: string): Promise<PropagationManifest> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${path} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const result = parsePropagationManifest(parsed);
  if (result.manifest === undefined) {
    throw new Error(result.problems.map((problem) => `${problem.path || "/"}: ${problem.message}`).join("\n"));
  }
  return result.manifest;
}

/** Reads a ledger by path, or the empty ledger when it is absent. */
async function readLedgerFile(path: string): Promise<PropagationLedger> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyLedger();
    throw error;
  }
  const parsed = JSON.parse(text) as unknown;
  if (!isPropagationLedger(parsed)) throw new Error(`${path} is not a propagation ledger this engine reads.`);
  return parsed;
}

/** Writes a ledger to one path, creating its folder. */
async function writeLedgerFile(path: string, ledger: PropagationLedger): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, ledgerText(ledger));
}

/** One line for a change. */
function changeLine(change: SemanticChange): string {
  const where = change.source === undefined ? "" : ` ${change.source.file}:${change.source.line}`;
  return `  ${change.kind.padEnd(9)} ${change.project} ${change.ref}${where} ${change.hash.slice(0, 12)}`;
}

/** The proposal as text. */
function proposalText(proposal: TaskProposal): string[] {
  const lines = [
    `Task ${proposal.id.slice(0, 12)} for ${proposal.consumer} (${proposal.severity}, ${proposal.action})`,
    `  ${proposal.goal}`,
    `  rationale: ${proposal.rationale}`,
  ];
  if (proposal.scope.pages.length > 0) lines.push(`  pages: ${proposal.scope.pages.join(", ")}`);
  if (proposal.scope.files.length > 0) lines.push(`  files: ${proposal.scope.files.join(", ")}`);
  for (const criterion of proposal.acceptance) {
    lines.push(`  accept ${criterion.id}: ${criterion.statement}`);
  }
  for (const decision of proposal.decisions) lines.push(`  decision ${decision.id}: ${decision.reason}`);
  for (const evidence of proposal.evidence) lines.push(`  evidence ${evidence.id} (${evidence.project}, ${evidence.kind})`);
  if (proposal.withheldEvidence > 0) lines.push(`  withheld evidence: ${proposal.withheldEvidence}`);
  return lines;
}

/** Runs one subcommand; returns the exit code. */
export async function runPropagation(args: readonly string[], io: PropagationIo): Promise<number> {
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    io.log(`${propagationUsage.replace(/\n$/, "")}\n`);
    return 0;
  }
  const parsed = parsePropagation(args);
  if ("error" in parsed) {
    if (parsed.error === "") {
      io.log(`${propagationUsage.replace(/\n$/, "")}\n`);
      return 0;
    }
    io.error(`mizzen: ${parsed.error}\n\n${propagationUsage}`);
    return 2;
  }
  const root = resolve(parsed.root);
  const manifestPath = parsed.manifest === undefined ? join(root, PROPAGATION_MANIFEST_FILE) : resolve(parsed.manifest);
  const ledgerPath = parsed.ledger === undefined ? join(root, ".mizzen/propagation.json") : resolve(parsed.ledger);

  if (parsed.command === "check") {
    let text: string;
    try {
      text = await readFile(manifestPath, "utf8");
    } catch (error) {
      io.error(`mizzen: cannot read ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch (error) {
      io.error(`mizzen: ${manifestPath} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
    const result = parsePropagationManifest(value);
    if (parsed.json) {
      io.log(`${JSON.stringify({ version: 1, valid: result.problems.length === 0, consumers: result.manifest?.consumers.length ?? 0, problems: result.problems }, null, 2)}\n`);
    } else if (result.problems.length === 0) {
      io.log(`${manifestPath}: ${result.manifest?.consumers.length ?? 0} consumer${result.manifest?.consumers.length === 1 ? "" : "s"} valid\n`);
    } else {
      for (const problem of result.problems) io.error(`mizzen: ${problem.path || "/"}: ${problem.code}: ${problem.message}`);
    }
    return result.problems.length === 0 ? 0 : 1;
  }

  if (parsed.command === "verify" || parsed.command === "receipt") {
    const id = parsed.value;
    if (id === undefined) {
      io.error(`mizzen: propagate ${parsed.command} needs a receipt id`);
      return 2;
    }
    const ledger = await readLedgerFile(ledgerPath);
    if (parsed.command === "receipt") {
      const receipt = findReceipt(ledger, id);
      if (receipt === undefined) {
        io.error(`mizzen: no receipt ${id} in ${ledgerPath}`);
        return 1;
      }
      if (parsed.json) {
        io.log(`${JSON.stringify(receipt, null, 2)}\n`);
      } else {
        io.log(`Receipt ${receipt.id}\n  ${receipt.consumer} ${receipt.upstream.project} ${receipt.upstream.version}: ${receipt.status} (${receipt.severity}, ${receipt.action})\n  ${receipt.reason}\n`);
      }
      return 0;
    }
    const verified = verifyReceipt(ledger, id);
    if (verified === undefined) {
      io.error(`mizzen: no receipt ${id} in ${ledgerPath}`);
      return 1;
    }
    if (!parsed.dryRun && !verified.unchanged) {
      await writeLedgerFile(ledgerPath, withVerifiedReceipt(ledger, verified.receipt));
    }
    if (parsed.json) {
      io.log(`${JSON.stringify(verified, null, 2)}\n`);
    } else {
      io.log(`Receipt ${id}: ${verified.receipt.status}${verified.unchanged ? " (unchanged)" : ""}\n`);
    }
    return 0;
  }

  if (parsed.baseline === undefined || parsed.current === undefined) {
    io.error(`mizzen: propagate ${parsed.command} needs --baseline <path> and --current <path>`);
    return 2;
  }

  if (parsed.command === "diff") {
    const baseline = await readSnapshots(parsed.baseline);
    const current = await readSnapshots(parsed.current);
    const events: SemanticChange[] = [];
    for (const [project, snapshot] of current) {
      const earlier = baseline.get(project);
      if (earlier === undefined) continue;
      events.push(...diffSnapshots(earlier, snapshot));
    }
    events.sort(compareChanges);
    if (parsed.json) {
      io.log(
        `${JSON.stringify(
          {
            version: 1,
            baseline: [...baseline.values()].map((snapshot) => ({ project: snapshot.project, snapshot: snapshot.snapshot })).sort((a, b) => byCodePoint(a.project, b.project)),
            current: [...current.values()].map((snapshot) => ({ project: snapshot.project, snapshot: snapshot.snapshot })).sort((a, b) => byCodePoint(a.project, b.project)),
            events,
          },
          null,
          2,
        )}\n`,
      );
      return 0;
    }
    if (events.length === 0) {
      io.log("No external semantic change.\n");
      return 0;
    }
    io.log(`Semantic changes: ${events.length}\n${events.map(changeLine).join("\n")}\n`);
    return 0;
  }

  const baseline = await readSnapshots(parsed.baseline);
  const current = await readSnapshots(parsed.current);
  const manifest = await readManifest(manifestPath);
  const allow = parsed.allow.length === 0 ? undefined : parsed.allow;

  if (parsed.command === "preview") {
    const preview = previewPropagation({ manifest, baseline, current, ...(allow === undefined ? {} : { allow }) });
    if (parsed.json) {
      io.log(`${JSON.stringify(preview, null, 2)}\n`);
      return preview.partial ? 1 : 0;
    }
    const lines = [`Preview: ${preview.events.length} change${preview.events.length === 1 ? "" : "s"}${preview.partial ? " (partial)" : ""}`];
    for (const impact of preview.consumers) {
      lines.push(`  ${impact.consumer}: ${impact.severity} -> ${impact.action}`);
      lines.push(`    snapshots: ${impact.snapshots.map((entry) => `${entry.project}${entry.from === undefined ? "" : ` ${entry.from}->`}${entry.to}`).join(", ")}`);
      if (impact.pages.length > 0) lines.push(`    pages: ${impact.pages.join(", ")}`);
      if (impact.tasks.length > 0) lines.push(`    tasks: ${impact.tasks.join(", ")}`);
      lines.push(`    ${impact.reason}`);
    }
    if (preview.unaffected.length > 0) lines.push(`  unaffected: ${preview.unaffected.join(", ")}`);
    for (const failure of preview.failures) lines.push(`  ${failure.consumer}: ${failure.kind}: ${failure.reason}`);
    io.log(`${lines.join("\n")}\n`);
    return preview.partial ? 1 : 0;
  }

  if (parsed.command === "propose") {
    const preview = previewPropagation({ manifest, baseline, current, ...(allow === undefined ? {} : { allow }) });
    const byId = new Map(manifest.consumers.map((consumer) => [consumer.id, consumer]));
    const proposals: TaskProposal[] = [];
    for (const impact of preview.consumers) {
      const consumer = byId.get(impact.consumer);
      const snapshot = current.get(impact.project);
      if (consumer === undefined || snapshot === undefined) continue;
      if (impact.action !== "task" && impact.action !== "pull-request" && impact.action !== "review") continue;
      proposals.push(proposeTask({ consumer, current: snapshot, affected: impact.affected, severity: impact.severity, action: impact.action }));
    }
    if (parsed.json) {
      io.log(`${JSON.stringify({ version: 1, proposals, failures: preview.failures, partial: preview.partial }, null, 2)}\n`);
      return preview.partial ? 1 : 0;
    }
    if (proposals.length === 0) io.log("No downstream task proposal.\n");
    else io.log(`${proposals.flatMap(proposalText).join("\n")}\n`);
    for (const failure of preview.failures) io.error(`mizzen: ${failure.consumer}: ${failure.kind}: ${failure.reason}`);
    return preview.partial ? 1 : 0;
  }

  if (parsed.command === "apply") {
    const ledger = await readLedgerFile(ledgerPath);
    const result = applyPropagation({
      manifest,
      baseline,
      current,
      ledger,
      ...(allow === undefined ? {} : { allow }),
      ...(parsed.approve.length === 0 ? {} : { approvals: Object.fromEntries(manifest.consumers.map((consumer) => [consumer.id, parsed.approve])) }),
    });
    if (!parsed.dryRun) await writeLedgerFile(ledgerPath, result.ledger);
    if (parsed.json) {
      io.log(`${JSON.stringify({ ...result, ledger: undefined }, null, 2)}\n`);
      return result.partial ? 1 : 0;
    }
    const lines = [`Applied: ${result.created.length} new receipt${result.created.length === 1 ? "" : "s"}, ${result.reused.length} reused${result.partial ? " (partial)" : ""}`];
    for (const receipt of result.receipts) lines.push(`  ${receipt.id.slice(0, 12)} ${receipt.consumer}: ${receipt.status} (${receipt.severity}, ${receipt.action})`);
    for (const proposal of result.tasks) lines.push(...proposalText(proposal));
    for (const failure of result.failures) lines.push(`  ${failure.consumer}: ${failure.kind}: ${failure.reason}`);
    io.log(`${lines.join("\n")}\n`);
    return result.partial ? 1 : 0;
  }

  io.error(`mizzen: unknown command: propagate ${parsed.command}`);
  return 2;
}
