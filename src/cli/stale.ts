/**
 * `mizzen stale`: pages that name the files they describe (`covers`) and the review lock that says when those files
 * were last read against the page.
 *
 * - `mizzen stale [dir] [--json] [--fail]` lists the pages whose covered files changed, were removed, or were added by
 *   a glob since the page was marked, with the files and a fix hint. It exits 1 under `--fail` when any page is stale.
 * - `mizzen stale mark <page…|--all> [--reason <text>] [--date YYYY-MM-DD] [--site <dir>]` writes the current hashes of
 *   the named pages to `docs-review.lock.json` and appends a line to `docs-review.audit.jsonl`.
 *
 * Arguments are parsed here, not in `index.ts`, and the command never builds the site.
 */
import { appendFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { redactAuditText } from "../edits/audit.ts";
import { loadCoveredPages } from "../stale/pages.ts";
import { compareToLock, formatStaleJson, formatStaleText } from "../stale/report.ts";
import { readReviewLock, reviewDate, withPage, writeReviewLock } from "../stale/lock.ts";

/** Where the command prints. */
export interface StaleIo {
  readonly log: (message: string) => void;
  readonly error: (message: string) => void;
}

/** The append-only record of each mark, beside the lock. */
export const REVIEW_AUDIT_FILE = "docs-review.audit.jsonl";

export const staleUsage = `Usage: mizzen stale [dir] [--json] [--fail]
       mizzen stale mark <page…> [options]
       mizzen stale mark --all [options]

  (none)   List the pages whose covered files changed since they were marked
  mark     Record the current hashes of a page's covered files as reviewed

Options:
  --all               Mark every page that has covers
  --reason <text>     Why the page is marked; recorded in ${REVIEW_AUDIT_FILE}
  --date <YYYY-MM-DD> Review date (default: the commit date of HEAD)
  --site <dir>        Site root for mark (default: .)
  --json              For the list: print JSON
  --fail              For the list: exit 1 when any page is stale
`;

/** Parsed `stale mark` arguments. */
interface MarkArgs {
  readonly pages: readonly string[];
  readonly all: boolean;
  readonly reason?: string;
  readonly date?: string;
  readonly site: string;
}

function parseMark(args: readonly string[]): MarkArgs | { readonly error: string } {
  const pages: string[] = [];
  let all = false;
  let reason: string | undefined;
  let date: string | undefined;
  let site = ".";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const value = (): string | undefined => args[++i];
    if (arg === "--all") all = true;
    else if (arg === "--reason" || arg === "--date" || arg === "--site") {
      const v = value();
      if (v === undefined || v.startsWith("--")) return { error: `${arg} needs a value` };
      if (arg === "--reason") reason = v;
      else if (arg === "--date") date = v;
      else site = v;
    } else if (arg.startsWith("-")) return { error: `unknown option: ${arg}` };
    else pages.push(arg);
  }
  if (!all && pages.length === 0) return { error: "stale mark needs a page, or --all" };
  if (all && pages.length > 0) return { error: "stale mark takes pages or --all, not both" };
  return { pages, all, site, ...(reason === undefined ? {} : { reason }), ...(date === undefined ? {} : { date }) };
}

/** Runs `mizzen stale <args>` and returns the exit code. */
export async function runStale(args: readonly string[], io: StaleIo): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "-h" || subcommand === "--help" || subcommand === "help") {
    io.log(staleUsage);
    return 0;
  }
  if (subcommand === "mark") return mark(rest, io);
  return list(args, io);
}

async function list(args: readonly string[], io: StaleIo): Promise<number> {
  let root: string | undefined;
  let json = false;
  let fail = false;
  for (const arg of args) {
    if (arg === "--json") json = true;
    else if (arg === "--fail") fail = true;
    else if (arg.startsWith("-")) {
      io.error(`mizzen: unknown option: ${arg}\n\n${staleUsage}`);
      return 2;
    } else if (root === undefined) root = arg;
    else {
      io.error(`mizzen: unexpected argument: ${arg}\n\n${staleUsage}`);
      return 2;
    }
  }
  const siteRoot = resolve(root ?? ".");
  const loaded = await loadCoveredPages(siteRoot);
  if (loaded.errors.length > 0) {
    for (const message of loaded.errors) io.error(`mizzen: ${message}`);
    return 1;
  }
  const lock = await readReviewLock(siteRoot);
  for (const d of lock.diagnostics) io.error(`mizzen: ${d.message}`);
  if (lock.diagnostics.some((d) => d.severity === "error")) return 1;
  for (const page of loaded.pages) {
    for (const d of page.diagnostics) io.error(`mizzen: ${d.pos === undefined ? page.page : `${d.pos.file}:${d.pos.line}`}: ${d.message}`);
  }
  const stale = compareToLock(loaded.pages, lock.lock);
  io.log(json ? formatStaleJson(stale) : formatStaleText(stale));
  return fail && stale.length > 0 ? 1 : 0;
}

async function mark(args: readonly string[], io: StaleIo): Promise<number> {
  if (args.includes("-h") || args.includes("--help")) {
    io.log(staleUsage);
    return 0;
  }
  const parsed = parseMark(args);
  if ("error" in parsed) {
    io.error(`mizzen: ${parsed.error}\n\n${staleUsage}`);
    return 2;
  }
  const root = resolve(parsed.site);
  const loaded = await loadCoveredPages(root);
  if (loaded.errors.length > 0) {
    for (const message of loaded.errors) io.error(`mizzen: ${message}`);
    return 1;
  }

  const byPage = new Map(loaded.pages.map((p) => [p.page, p]));
  const wanted = parsed.all ? loaded.pages.map((p) => p.page) : [...new Set(parsed.pages.map((p) => p.replace(/\\/g, "/").replace(/^\.\//, "")))];
  if (wanted.length === 0) {
    io.error("mizzen: no page has covers; nothing to mark.");
    return 1;
  }

  // Check every named page before anything is written, so one refusal marks nothing.
  let failed = false;
  for (const name of wanted) {
    const page = byPage.get(name);
    if (page === undefined) {
      io.error(`mizzen: ${name} has no covers; add \`covers\` to its front matter before marking it.`);
      failed = true;
      continue;
    }
    for (const d of page.diagnostics) {
      const where = d.pos === undefined ? name : `${d.pos.file}:${d.pos.line}`;
      if (d.severity === "error") {
        io.error(`mizzen: ${where}: ${d.message}`);
        failed = true;
      } else io.error(`mizzen: ${where}: ${d.message}`);
    }
  }
  if (failed) return 1;

  const date = await reviewDate(root, parsed.date);
  if ("error" in date) {
    io.error(`mizzen: ${date.error}`);
    return 2;
  }

  const current = await readReviewLock(root);
  if (current.diagnostics.length > 0) {
    // A broken lock would be overwritten; refuse unless every page is being marked again.
    if (!parsed.all) {
      for (const d of current.diagnostics) io.error(`mizzen: ${d.message}`);
      return 1;
    }
  }
  let lock = current.lock;
  const reason = parsed.reason === undefined ? undefined : redactAuditText(parsed.reason);
  let ledger = "";
  for (const name of wanted) {
    const page = byPage.get(name)!;
    lock = withPage(lock, name, { reviewed: date.date, files: page.files });
    ledger += `${JSON.stringify({
      version: 1,
      event: "mark",
      page: name,
      date: date.date,
      files: page.files.map((f) => ({ path: f.path, sha256: f.sha256 })),
      ...(reason === undefined ? {} : { reason }),
    })}\n`;
    io.log(`${name}: marked as reviewed on ${date.date} (${page.files.length} file${page.files.length === 1 ? "" : "s"})`);
  }
  await writeReviewLock(root, lock);
  await appendFile(join(root, REVIEW_AUDIT_FILE), ledger);
  return 0;
}
