/**
 * `mizzen author <subcommand>`: turn surface gaps into authoring tasks, export one with its context pack, validate a
 * returned draft, preview and verify it, prepare a pull-request proposal, and write an approved page.
 *
 * The command never calls a model. Draft generation is the external agent's job; this CLI exports the evidence,
 * validates the returned JSON, runs the checks, and stops before writing unless the repository policy and a person's
 * approval allow it.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { AccessGrant, AccessPolicy } from "../contracts/permissions.ts";
import type { AuthoringDraft, AuthoringPreview, AuthoringTask, AuthoringTaskList, AuthoringVerification } from "../contracts/authoring.ts";
import { buildModel } from "../model/build.ts";
import { surfaceReportOf } from "../surface/report.ts";
import { formatText } from "../pipeline/diagnostics.ts";
import { readAccessPolicyFile } from "../permissions/file.ts";
import {
  authoringExportOf,
  authoringProposalOf,
  authoringTaskFor,
  authoringTasksOf,
  authoringVerify,
  parseAuthoringDraft,
  validateAuthoringDraft,
  writeAuthoringDraft,
} from "../authoring/index.ts";

/** Where the command prints. */
export interface AuthorIo {
  readonly log: (message: string) => void;
  readonly error: (message: string) => void;
}

export const authorUsage = `Usage: mizzen author <subcommand> [dir] [options]

  tasks [dir]            List one authoring task per documentation gap (--json, --version, --budget, --out)
  export <item> [dir]    Print the task and context pack for an external agent (--out, --version, --budget)
  draft <draft.json> [dir]
                         Validate a returned draft, its citations, unknowns, and location (--json)
  preview <draft.json> [dir]
                         Build the page in a copy, show the diff and citations, and gate the write
                         (--theme, --out, --policy, --approval, --approve, --json)
  verify <draft.json> [dir]
                         Check examples, behaviors, links, coverage, and the build (--theme, --json)
  propose <draft.json> [dir]
                         Print the pull-request proposal after verification (--theme, --out, --json)
  write <draft.json> [dir]
                         Write the approved page (--theme, --policy, --approval, --approve, --json)
`;

/** The subcommands, in help order. */
const SUBCOMMANDS = ["tasks", "export", "draft", "preview", "verify", "propose", "write"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

/** One parsed invocation. */
interface AuthorArgs {
  readonly subcommand: Subcommand;
  readonly item?: string;
  readonly draft?: string;
  readonly root: string;
  readonly json: boolean;
  readonly out?: string;
  readonly version?: string;
  readonly budget?: number;
  readonly itemFilter?: string;
  readonly theme?: string;
  readonly policy?: string;
  readonly approval?: string;
  readonly approve: boolean;
}

/** True for one of the subcommands. */
function isSubcommand(value: string): value is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(value);
}

/** Parses the command's arguments. */
function parseAuthor(args: readonly string[]): AuthorArgs | { readonly error: string } | { readonly help: true } {
  const [subcommand, ...rest] = args;
  if (subcommand === undefined || subcommand === "-h" || subcommand === "--help") return { help: true };
  if (!isSubcommand(subcommand)) return { error: `unknown author subcommand: ${subcommand}` };
  let root = ".";
  let item: string | undefined;
  let draft: string | undefined;
  let json = false;
  let out: string | undefined;
  let version: string | undefined;
  let budget: number | undefined;
  let itemFilter: string | undefined;
  let theme: string | undefined;
  let policy: string | undefined;
  let approval: string | undefined;
  let approve = false;
  const positionals: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (arg === "-h" || arg === "--help") return { help: true };
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--approve") {
      approve = true;
      continue;
    }
    if (arg.startsWith("-")) {
      const next = rest[++index];
      if (next === undefined || next.startsWith("-")) return { error: `${arg} needs a value` };
      if (arg === "--out") out = next;
      else if (arg === "--version") version = next;
      else if (arg === "--theme") theme = next;
      else if (arg === "--policy") policy = next;
      else if (arg === "--approval") approval = next;
      else if (arg === "--item") itemFilter = next;
      else if (arg === "--budget") {
        if (!/^\d+$/.test(next) || Number(next) < 1) return { error: "--budget must be a positive whole number of tokens" };
        budget = Number(next);
      } else return { error: `unknown option: ${arg}` };
      continue;
    }
    positionals.push(arg);
  }

  if (subcommand === "export") {
    if (positionals.length === 0) return { error: "author export needs a surface item: author export <item> [dir]" };
    if (positionals.length > 2) return { error: `unexpected argument: ${positionals[2]}` };
    item = positionals[0]!;
    root = positionals[1] ?? ".";
  } else if (subcommand === "tasks") {
    if (positionals.length > 1) return { error: `unexpected argument: ${positionals[1]}` };
    root = positionals[0] ?? ".";
  } else {
    if (positionals.length === 0) return { error: `author ${subcommand} needs a draft file: author ${subcommand} <draft.json> [dir]` };
    if (positionals.length > 2) return { error: `unexpected argument: ${positionals[2]}` };
    draft = positionals[0]!;
    root = positionals[1] ?? ".";
  }

  const needsTheme = subcommand === "preview" || subcommand === "verify" || subcommand === "propose" || subcommand === "write";
  if (theme !== undefined && !needsTheme) return { error: "--theme is only valid for preview, verify, propose, and write" };
  const needsGate = subcommand === "preview" || subcommand === "write";
  if ((policy !== undefined || approval !== undefined || approve) && !needsGate) {
    return { error: "--policy, --approval, and --approve are only valid for preview and write" };
  }
  const needsBudget = subcommand === "tasks" || subcommand === "export";
  if (budget !== undefined && !needsBudget) return { error: "--budget is only valid for tasks and export" };
  if (itemFilter !== undefined && subcommand !== "tasks") return { error: "--item is only valid for tasks" };
  return {
    subcommand,
    root,
    json,
    approve,
    ...(item === undefined ? {} : { item }),
    ...(draft === undefined ? {} : { draft }),
    ...(out === undefined ? {} : { out }),
    ...(version === undefined ? {} : { version }),
    ...(budget === undefined ? {} : { budget }),
    ...(itemFilter === undefined ? {} : { itemFilter }),
    ...(theme === undefined ? {} : { theme }),
    ...(policy === undefined ? {} : { policy }),
    ...(approval === undefined ? {} : { approval }),
  };
}

/** Writes a file, creating its folder. */
async function writeOut(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
}

/** Reads the draft, or explains why it is not one. */
async function readDraft(path: string): Promise<{ readonly draft?: AuthoringDraft; readonly problems: readonly string[] }> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    return { problems: [`${path}: cannot read the draft: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const parsed = parseAuthoringDraft(value);
  return {
    ...(parsed.draft === undefined ? {} : { draft: parsed.draft }),
    problems: parsed.problems.map((problem) => `${problem.path === "" ? "/" : problem.path}: ${problem.code}: ${problem.message}`),
  };
}

/** Reads an approval file, or explains why it is not one. */
async function readApproval(path: string): Promise<{ readonly approval?: AccessGrant; readonly problems: readonly string[] }> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    return { problems: [`${path}: cannot read the approval: ${error instanceof Error ? error.message : String(error)}`] };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { problems: [`${path}: an approval must be a JSON object.`] };
  }
  const grant = value as Partial<AccessGrant>;
  for (const key of ["id", "capability", "principal", "decision", "reason", "snapshot", "policy"] as const) {
    if (typeof grant[key] !== "string" || (grant[key] as string).trim() === "") {
      return { problems: [`${path}: \`${key}\` must be a non-empty string.`] };
    }
  }
  if (grant.capability !== "write") return { problems: [`${path}: an authoring approval must name the write capability.`] };
  if (grant.decision !== "approved" && grant.decision !== "rejected") {
    return { problems: [`${path}: \`decision\` must be approved or rejected.`] };
  }
  if (grant.files !== undefined && (!Array.isArray(grant.files) || grant.files.some((file) => typeof file !== "string"))) {
    return { problems: [`${path}: \`files\` must be a list of paths.`] };
  }
  return { approval: grant as AccessGrant, problems: [] };
}

/** Reads a policy file, or explains why it is not one. */
async function readPolicy(path: string): Promise<{ readonly policy?: AccessPolicy; readonly problems: readonly string[] }> {
  const loaded = await readAccessPolicyFile(path);
  return { ...(loaded.policy === undefined ? {} : { policy: loaded.policy }), problems: loaded.problems };
}

/** The task a draft belongs to, or an error sentence. */
function taskOf(tasks: AuthoringTaskList, item: string): AuthoringTask | { readonly error: string } {
  const task = authoringTaskFor(tasks, item);
  return task ?? { error: `No authoring task exists for \`${item}\`.` };
}

/** The theme root, resolved through the CLI's own rule, or an error sentence. */
async function themeOf(root: string, flag: string | undefined): Promise<string | { readonly error: string }> {
  const { resolveThemeRoot } = await import("./index.ts");
  const themeRoot = await resolveThemeRoot(root, flag);
  return themeRoot ?? { error: "no theme found; set theme.name in the config or pass --theme" };
}

/** The text form of one task. */
function taskText(task: AuthoringTask): string {
  const evidence = task.outline.filter((section) => section.needsEvidence).map((section) => section.heading);
  const lines = [
    `- ${task.item}  ${task.pageType.kind}  ${task.location.url}`,
    `  source: ${task.location.source}`,
    `  block: ${task.location.block}; navigation: ${task.location.nav.list}${task.location.nav.parent === undefined ? "" : ` / ${task.location.nav.parent}`}, titled ${task.location.nav.title}`,
    `  unknown(s): ${task.unknowns.length}; question(s): ${task.questions.length}`,
  ];
  if (evidence.length > 0) lines.push(`  needs evidence: ${evidence.join(", ")}`);
  for (const conflict of task.conflicts) lines.push(`  conflict ${conflict.kind}: ${conflict.message}`);
  return lines.join("\n");
}

/** The text form of a task list. */
function tasksText(list: AuthoringTaskList): string {
  const lines = [`${list.tasks.length} authoring task(s)`];
  for (const task of list.tasks) lines.push(taskText(task));
  for (const skip of list.skipped) lines.push(`- skipped ${skip.item}: ${skip.reason}`);
  return lines.join("\n");
}

/** The text form of a validation. */
function validationText(validation: ReturnType<typeof validateAuthoringDraft>): string {
  const lines = [
    `${validation.item}: ${validation.ok ? "ok" : "not ready"}`,
    `claims: ${validation.claims.length}; normative: ${validation.claims.filter((claim) => claim.normative).length}; citations: ${validation.citations.length}; uncited: ${validation.uncited.length}`,
  ];
  for (const claim of validation.uncited) lines.push(`- uncited line ${claim.line}: ${claim.text}`);
  for (const problem of validation.problems) lines.push(`- ${problem.code} ${problem.path}: ${problem.message}`);
  for (const conflict of validation.conflicts) lines.push(`- conflict ${conflict.kind} ${conflict.value}: ${conflict.message}`);
  return lines.join("\n");
}

/** The text form of a preview. */
function previewText(preview: AuthoringPreview): string {
  const lines = [
    `${preview.item}: ${preview.page === undefined ? "not built" : `built ${preview.page.file}`}`,
    `write: ${preview.write} (${preview.writeReason})`,
    `citations: ${preview.citations.length}; uncited: ${preview.uncited.length}`,
    `diff: ${preview.diff === "" ? "no change" : `${preview.diff.split("\n").length} line(s)`}`,
  ];
  for (const citation of preview.citations) lines.push(`- [[${citation.kind}:${citation.ref}]] line ${citation.line}: ${citation.claim}`);
  for (const claim of preview.uncited) lines.push(`- uncited line ${claim.line}: ${claim.text}`);
  for (const problem of preview.problems) lines.push(`- ${problem.code} ${problem.path}: ${problem.message}`);
  if (preview.diff !== "") lines.push("", preview.diff);
  return lines.join("\n");
}

/** The text form of a verification. */
function verificationText(verification: AuthoringVerification): string {
  const lines = [
    `${verification.item}: ${verification.verdict}`,
    `checks: ${verification.checks.map((entry) => `${entry.id}=${entry.status}`).join(", ")}`,
    `proof: ${verification.proof?.hash ?? "none"}`,
    `remaining unknown(s): ${verification.remainingUnknowns.length}`,
    `remaining question(s): ${verification.remainingQuestions.length}`,
  ];
  for (const unknown of verification.remainingUnknowns) lines.push(`- unknown ${unknown.id}: ${unknown.statement}`);
  for (const question of verification.remainingQuestions) lines.push(`- question ${question.id}: ${question.question}`);
  for (const failure of verification.failures) lines.push(`- failure: ${failure}`);
  return lines.join("\n");
}

/** Runs `mizzen author` and returns the exit code. */
export async function runAuthor(args: readonly string[], io: AuthorIo): Promise<number> {
  const parsed = parseAuthor(args);
  if ("help" in parsed || args.length === 0) {
    io.log(`${authorUsage.replace(/\n$/, "")}\n`);
    return 0;
  }
  if ("error" in parsed) {
    io.error(`mizzen: ${parsed.error}\n\n${authorUsage}`);
    return 2;
  }
  const root = resolve(parsed.root);
  const model = await buildModel(root);
  const buildErrors = model.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  const { report, diagnostics } = await surfaceReportOf({
    root,
    site: model.site,
    ...(parsed.version === undefined ? {} : { version: parsed.version }),
  });
  const findings = [...buildErrors, ...diagnostics];
  if (findings.length > 0) io.error(formatText(findings).replace(/\n$/, ""));

  if (parsed.subcommand === "tasks") {
    const result = await authoringTasksOf({
      root,
      site: model.site,
      report,
      ...(parsed.version === undefined ? {} : { version: parsed.version }),
      ...(parsed.itemFilter === undefined ? {} : { items: [parsed.itemFilter] }),
      ...(parsed.budget === undefined ? {} : { budget: { contextTokens: parsed.budget, toolCalls: 30, timeMs: 300_000 } }),
    });
    for (const problem of result.problems) io.error(`mizzen: ${problem.code} ${problem.path}: ${problem.message}`);
    const text = parsed.json ? `${JSON.stringify(result.list, null, 2)}\n` : `${tasksText(result.list)}\n`;
    if (parsed.out === undefined) io.log(text.replace(/\n$/, ""));
    else await writeOut(resolve(parsed.out), text);
    return findings.some((finding) => finding.severity === "error") || result.problems.length > 0 ? 1 : 0;
  }

  if (parsed.subcommand === "export") {
    const task = authoringTaskFor(
      (
        await authoringTasksOf({
          root,
          site: model.site,
          report,
          ...(parsed.version === undefined ? {} : { version: parsed.version }),
          ...(parsed.item === undefined ? {} : { items: [parsed.item] }),
        })
      ).list,
      parsed.item!,
    );
    if (task === undefined) {
      io.error(`mizzen: no authoring task exists for \`${parsed.item}\``);
      return 1;
    }
    const result = await authoringExportOf({
      task,
      site: model.site,
      root,
      ...(parsed.budget === undefined ? {} : { maxTokens: parsed.budget }),
    });
    if (result.exported === undefined) {
      for (const problem of result.problems) io.error(`mizzen: ${problem}`);
      return 1;
    }
    const text = `${JSON.stringify(result.exported, null, 2)}\n`;
    if (parsed.out === undefined) io.log(text.replace(/\n$/, ""));
    else await writeOut(resolve(parsed.out), text);
    return findings.some((finding) => finding.severity === "error") ? 1 : 0;
  }

  const loaded = await readDraft(parsed.draft!);
  if (loaded.draft === undefined) {
    if (parsed.json) io.log(`${JSON.stringify({ version: 1, problems: loaded.problems }, null, 2)}\n`.replace(/\n$/, ""));
    else for (const problem of loaded.problems) io.error(`mizzen: ${problem}`);
    return 1;
  }
  const task = taskOf(
    (
      await authoringTasksOf({
        root,
        site: model.site,
        report,
        ...(parsed.version === undefined ? {} : { version: parsed.version }),
        items: [loaded.draft.item],
      })
    ).list,
    loaded.draft.item,
  );
  if ("error" in task) {
    io.error(`mizzen: ${task.error}`);
    return 1;
  }

  if (parsed.subcommand === "draft") {
    const validation = validateAuthoringDraft(loaded.draft, task, model.site);
    const text = parsed.json ? `${JSON.stringify(validation, null, 2)}\n` : `${validationText(validation)}\n`;
    if (parsed.out === undefined) io.log(text.replace(/\n$/, ""));
    else await writeOut(resolve(parsed.out), text);
    return validation.ok ? 0 : 1;
  }

  const theme = await themeOf(root, parsed.theme);
  if (typeof theme !== "string") {
    io.error(`mizzen: ${theme.error}`);
    return 2;
  }
  const policy: { readonly policy?: AccessPolicy; readonly problems: readonly string[] } =
    parsed.policy === undefined ? { problems: [] } : await readPolicy(parsed.policy);
  if (policy.policy === undefined && policy.problems.length > 0) {
    for (const problem of policy.problems) io.error(`mizzen: ${problem}`);
    return 2;
  }
  const approval: { readonly approval?: AccessGrant; readonly problems: readonly string[] } =
    parsed.approval === undefined ? { problems: [] } : await readApproval(parsed.approval);
  if (approval.approval === undefined && approval.problems.length > 0) {
    for (const problem of approval.problems) io.error(`mizzen: ${problem}`);
    return 2;
  }
  const gate = {
    ...(policy.policy === undefined ? {} : { policy: policy.policy }),
    ...(approval.approval === undefined ? {} : { approval: approval.approval }),
    ...(parsed.approve ? { approve: true } : {}),
  };

  if (parsed.subcommand === "preview") {
    const { authoringPreview } = await import("../authoring/preview.ts");
    const preview = await authoringPreview({
      root,
      site: model.site,
      task,
      draft: loaded.draft,
      themeRoot: theme,
      ...(parsed.version === undefined ? {} : { version: parsed.version }),
      ...gate,
    });
    const text = parsed.json ? `${JSON.stringify(preview, null, 2)}\n` : `${previewText(preview)}\n`;
    if (parsed.out === undefined) io.log(text.replace(/\n$/, ""));
    else {
      const directory = resolve(parsed.out);
      await writeOut(join(directory, "preview.json"), text);
      await writeOut(join(directory, "diff.patch"), preview.diff);
      if (preview.page !== undefined) await writeOut(join(directory, "page.html"), preview.page.html);
    }
    return preview.problems.length === 0 && preview.uncited.length === 0 ? 0 : 1;
  }

  if (parsed.subcommand === "verify") {
    const verification = await authoringVerify({
      root,
      site: model.site,
      task,
      draft: loaded.draft,
      themeRoot: theme,
      ...(parsed.version === undefined ? {} : { version: parsed.version }),
    });
    const text = parsed.json ? `${JSON.stringify(verification, null, 2)}\n` : `${verificationText(verification)}\n`;
    if (parsed.out === undefined) io.log(text.replace(/\n$/, ""));
    else await writeOut(resolve(parsed.out), text);
    if (verification.verdict === "proved") return 0;
    return 1;
  }

  if (parsed.subcommand === "propose") {
    const verification = await authoringVerify({
      root,
      site: model.site,
      task,
      draft: loaded.draft,
      themeRoot: theme,
      ...(parsed.version === undefined ? {} : { version: parsed.version }),
    });
    const { authoringPreview } = await import("../authoring/preview.ts");
    const preview = await authoringPreview({
      root,
      site: model.site,
      task,
      draft: loaded.draft,
      themeRoot: theme,
      ...(parsed.version === undefined ? {} : { version: parsed.version }),
    });
    const proposal = authoringProposalOf(task, verification, loaded.draft, preview);
    const text = parsed.json ? `${JSON.stringify(proposal, null, 2)}\n` : `${proposal.title}\n${proposal.branch} <- ${proposal.base}\n${proposal.noop ? `no-op: ${proposal.noopReason ?? ""}` : `files: ${proposal.files.map((file) => file.path).join(", ")}`}\n${proposal.body}`;
    if (parsed.out === undefined) io.log(text.replace(/\n$/, ""));
    else await writeOut(resolve(parsed.out), `${JSON.stringify(proposal, null, 2)}\n`);
    return proposal.noop ? 1 : 0;
  }

  const written = await writeAuthoringDraft({
    root,
    site: model.site,
    task,
    draft: loaded.draft,
    themeRoot: theme,
    ...gate,
  });
  const text = parsed.json
    ? `${JSON.stringify(written, null, 2)}\n`
    : `${written.written ? `wrote ${written.path}` : "not written"}: ${written.gate} (${written.reason})\n`;
  io.log(text.replace(/\n$/, ""));
  return written.written ? 0 : 1;
}
