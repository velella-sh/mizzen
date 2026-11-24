/** `mizzen build`, `mizzen check`, `mizzen dev`, `mizzen doctor`, `mizzen edit apply`, `mizzen edit verify`, `mizzen pack`, `mizzen readiness`, `mizzen verify`, and `mizzen watch`: build a site, report diagnostics, serve it while developing, preflight a site, apply or verify an agent patch, print a context pack, score a build for agents, check a build, or rebuild on change. */
import { access, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config/load.ts";
import { readAsOfFlag, todayOf } from "../dates/as-of.ts";
import { version } from "../index.ts";
import { build } from "../pipeline/build.ts";
import { formatJson, formatSarif, formatText } from "../pipeline/diagnostics.ts";
import { DEFAULT_DEV_HOST, DEFAULT_DEV_OUT, DEFAULT_DEV_PORT, dev } from "./dev.ts";
import { doctor } from "./doctor.ts";
import { dataExplain, dataExtract, dataFetch, dataSnapshot, dataTransform } from "./data.ts";
import { diffRuleVersions } from "../data/rule-diff.ts";
import { dataRefresh } from "./refresh.ts";
import { dataSchema } from "../data/schema-evolution.ts";
import { dataMigrate } from "../data/schema-migrate.ts";
import { verifyData } from "../data/verify.ts";
import { checkQuality } from "../data/quality.ts";
import { dataChanges } from "../data/changes/write.ts";
import { runEvidence } from "./evidence.ts";
import { runExamplesRecord } from "./examples.ts";
import { runNetwork } from "./network.ts";
import { runPublishedSite } from "./published-site.ts";
import { runSiteAttestation } from "./site-attestation.ts";
import { runStale } from "./stale.ts";
import { runGraph } from "./graph.ts";
import { runKnowledge } from "./knowledge.ts";
import { runDecisions } from "./decisions.ts";
import { referencesUsage, runReferences } from "./references.ts";
import { runTrace, traceUsage } from "./trace.ts";
import { runDocsVersion } from "./docs-version.ts";
import { runSurface } from "./surface.ts";
import { runBehavior } from "./behavior.ts";
import { runFederation } from "./federation.ts";
import { runAuthor } from "./author.ts";
import { runImport } from "./import.ts";
import { runInputs } from "./inputs.ts";
import { staleDiagnostics } from "../stale/diagnostics.ts";
import { buildModel } from "../model/build.ts";
import { urlsReport } from "./urls.ts";
import { apiCheck } from "./api.ts";
import { init } from "./init.ts";
import { diffCommand, parseChangeType, parseFailOn, type ChangeType, type FailKind } from "./diff.ts";
import { FORMATS as DIFF_FORMATS, type DiffFormat } from "../diff/format.ts";
import { editApply, EditApplyError, formatEditApplyJson } from "./edit-apply.ts";
import { readAccessPolicyFile } from "../permissions/file.ts";
import {
  conflictLines,
  editRollbackCommand,
  editTransactionCommand,
  formatEditRollbackJson,
  formatEditTransactionJson,
} from "./edit-transaction.ts";
import { EditTransactionError } from "../edits/edit-transaction.ts";
import { formatVerifyProofJson, verifyProof, verifyProofMessage } from "./edit-verify.ts";
import { clientConfig, isClient, serveMcp, CLIENTS } from "./mcp.ts";
import { pack } from "./pack.ts";
import { verify, verifyMessage } from "./verify.ts";
import { compareReports, reproduce } from "./reproduce.ts";
import { BUILD_REPORT_PATH, buildReportOf, writeBuildReport } from "../reproduce/manifest.ts";
import { DEFAULT_WATCH_OUT, watch as watchSite } from "./watch.ts";
import { traceEditApply, traceVerification } from "../trace/instrument.ts";
import { runEval } from "./eval.ts";
import { runAgent } from "../agent-cli/index.ts";
import { readinessCommand, type ReadinessCommandOptions } from "./readiness.ts";
import { formatReadiness, formatReadinessJson, readinessReport } from "../readiness/report.ts";
import { scanBuild } from "../readiness/scan.ts";
import { RUBRIC } from "../readiness/rubric.ts";
import type { ReadinessDimension } from "../contracts/readiness.ts";

/** The command name on the PATH. */
export const NAME = "mizzen";

/** Every command the parser registers, in the order the help lists them. */
export const COMMANDS = ["agent", "api", "author", "behavior", "build", "check", "compare", "data", "decisions", "dev", "diff", "doctor", "edit", "eval", "evidence", "examples", "federation", "graph", "import", "init", "knowledge", "mcp", "network", "pack", "published-site", "readiness", "references", "reproduce", "stale", "surface", "trace", "urls", "verify", "versions", "watch", "inputs"] as const;

const FORMATS = ["text", "json", "sarif"] as const;
type Format = (typeof FORMATS)[number];

/** What `edit apply` and `edit verify` print: the human default, or the machine report. */
const EDIT_FORMATS = ["text", "json"] as const;
type EditFormat = (typeof EDIT_FORMATS)[number];

/** What `pack` prints: the Markdown pack, or its structured evidence. */
const PACK_FORMATS = ["markdown", "json"] as const;
type PackFormat = (typeof PACK_FORMATS)[number];

/** Reads the `--format` value of an edit command, or `undefined` when it is not one it prints. */
function editFormat(raw: string): EditFormat | undefined {
  return (EDIT_FORMATS as readonly string[]).includes(raw) ? (raw as EditFormat) : undefined;
}

/** Layout used when a page names none and the site's defaults name none. */
const DEFAULT_LAYOUT = "doc";

/**
 * The `lateen` checkout beside a source tree, used when a site configures no theme while developing this repository.
 * A packed CLI must not inherit it: from `dist/` the same relative path lands in `node_modules/@velella/lateen`, which
 * would make the engine depend on a theme it does not ship. So a fallback that resolves inside any `node_modules` tree
 * is refused, while the checkout beside a developer's source tree still works.
 */
export function siblingThemeRoot(moduleUrl: string): string | undefined {
  const path = fileURLToPath(new URL("../../../lateen", moduleUrl));
  return path.split(sep).includes("node_modules") ? undefined : path;
}

/** Folder of a `lateen` checkout beside this package, or `undefined` in a packed install. */
const SIBLING_THEME = siblingThemeRoot(import.meta.url);

export const usage = `Usage: ${NAME} <command> [dir] [options]

Commands:
  agent capabilities        Print versioned JSON capabilities: task, pack, edit, verify, replay, eval
  agent schema [name]       Print a command's input schema, output schema, and exit codes
  agent task register [dir]  Register a task from --file <path> or --stdin
  agent task preview [dir]  Show proposed changes, required checks, and affected outputs; writes nothing
  agent task run <id> [dir]  Compile a task; --dry-run previews, --events <file> writes JSON Lines
  agent task status <id> [dir]  Print a task, its last run, and its approvals
  agent task resume <id> [dir]  Resume a waiting or blocked task; --approve <ids|all>
  agent task cancel <id> [dir]  Cancel a task; --reason <text>
  api check [dir]           Fail when the data API breaks a consumer of --against <built folder|git ref>
  author <subcommand> [dir]  Turn surface gaps into tasks, validate a draft, preview it, verify it, propose a PR, or write it
  behavior [dir]            Report behavior contracts, surface/test/evidence links, and drift (--json, --version, --status)
  build [dir]               Build the site into --out (default: dist)
  check [dir]               Build to a temp folder and print diagnostics only
  compare <a> <b>           Compare two build diagnostic reports
  data extract [dir]        Lock local SQLite and NDJSON collection results (--check verifies only)
  data fetch [dir]          Fetch and pin HTTPS collection sources (--check verifies only)
  data refresh [dir]        Fetch selected sources, validate, and write a review report (--collections, --report)
  data changes [name] [dir]  List a collection's pending history events (--write appends, --check fails on any)
  data verify [dir]         Compare the lock's record of each collection with its data; read-only
  data quality [dir]        Report records that fail the config's quality rules (--json, --write, --as-of)
  data snapshot <name> [dir]  Record the last commit and date of a file collection in the lock
  data schema [dir]          Report the fields each schema added or removed since its recorded baseline
  data migrate [name] [dir]  Preview the records a schema's renames would migrate; read-only
  data explain <collection> <id> [dir]
                            Explain one field's lineage (--field <path>, --json, --public)
  data transform [name] [dir]  Preview the records a collection's transform rules produce (--limit, --json)
  data transform-diff <baseline> <proposed> [dir]
                            Compare two rule versions on one input (--collection, --format, --check)
  dev [dir]                 Serve the site, rebuild on change, and reload the browser
  diff <a> <b>              Compare two built folders, or --base <ref> a git ref with the current site
  doctor [dir]              Check the config, content, output paths, runtime, and toolchain
  edit apply <patch.json> [dir]
                            Apply a span patch to its source file and record a proof
  edit transaction <file.json> [dir]
                            Apply a versioned multi-file edit atomically (--dry-run, --rebase, --approve)
  edit rollback <receipt.json> [dir]
                            Restore only the files a transaction receipt names
  edit verify <proof.json>  Check an edit proof or a verification proof (--input <file> for public evidence)
  eval [suite]              Run a deterministic evaluation suite and print its report (--format, --out, --baseline)
  evidence ingest <envelope.json> [dir] [--artifact <file>]
                            Validate evidence and store it by SHA-256
  examples lock [dir]       Record .mizzen-env.json: runtime, packages, fixtures, limits
  examples record [dir]     Run and record fences (--date YYYY-MM-DD --commit <full SHA>)
  federation fetch [dir]    Fetch and pin every project's bundle in federation.lock.json (--check compares)
  federation status [dir]   Report the pinned bundles and every missing bundle (--json)
  federation graph [dir]    Print the composed graph over every visible project (--json)
  federation query [dir]    Answer one cross-repository query (--from, --to, --project, --json)
  federation pack [dir]     Compile one context pack across projects (--goal, --budget, --from)
  federation chain [dir]    Trace a claim's evidence chain across projects (--claim, --project, --json)
  federation resolve [dir]  Resolve a stable reference to a pinned snapshot or a compatible channel (--reference)
  graph [dir]               Query the knowledge graph: neighbors and the shortest path (--from, --to)
  import <name> <dir>         Preview a migration; --out <dir> writes it, --fail-on-manual gates on manual items
  init [dir]                Start a site from a theme starter: --starter <name> copies it, --list names them
  knowledge [dir]           Report explicit unknowns, documentation gaps, and unsupported cases (--json, --baseline)
  decisions [dir]           Report versioned decisions and answer why a behavior or page exists (why <subject>, --json)
  mcp [dir]                 Serve the site to an AI client over MCP on stdio (read-only; --allow-edits adds apply_edit)
  network check <file>      Check the shared network file: ids, paths, titles
  network update [dir]      Fetch the network and write network.lock.json (--check, --accept)
  network sitemap [dir]     Write the organization's sitemap index (--url <origin>, --out <dir>)
  pack [dir]                Print one context pack for a topic or an ad-hoc request, to stdout or --out
  published-site attest <bundle> <provenance.json> [--key <private.pem>]
                            Print a detached site and evidence attestation
  published-site check      Check a published site from --sitemap <url>: status, canonical URL, redirects
  published-site verify <bundle> <attestation.json> <trust-policy.json>
                            Verify a local bundle offline and print a JSON report
  readiness [built]         Score a built folder against the public readiness rubric (--report, --badge, --compare)
  references check <file|-> [dir]
                            Resolve a JSON array of stored block references: resolved, removed, or unknown
  reproduce <report> [dir]  Preflight a recorded build, rebuild it, and compare the reports (--check: preflight only)
  stale [dir]               List pages whose covered files changed since review (--json, --fail, --changed <files…>, --git-diff <base>)
  stale mark <page…>        Record a page's covered files as reviewed (--all for every page)
  trace show <trace.json>   Print a recorded agent trace: task, snapshot, stages, and evidence
  trace search <trace.json>  Filter events by --stage, --file, --task, or --status
  trace replay <trace.json>  Check the recorded order, input hashes, and results; writes nothing
  trace export <trace.json>  Write or print only the authorized fields (--out <dir>)
  trace handoff <trace.json>  Print the state, changes, decisions, and remaining work
  urls check [dir]          Compare record page URLs with urls.lock.json
  verify [dir]              Check a built folder against the hash in its manifest
  versions snapshot <vN> [dir]
                            Copy the current pages and navigation into a new version folder
  surface [dir]             Report public-surface documentation coverage and gaps (--json, --baseline, --min)
  watch [dir]               Rebuild the site whenever a source or theme file changes
  inputs export [dir]       Write selected collection sources to one transferable package (--collections, --out)
  inputs inspect <file>     Print a package's format, inputs, sizes, and hashes (--json); changes nothing
  inputs verify <file>      Check every content hash and that no undeclared bytes follow; changes nothing
  inputs import <file> [dir]
                            Install a package's inputs and lock entries (--accept on a conflict)

Options:
  --out <path>         Output folder: build (default: dist), dev (default: .mizzen/dev), watch (default: .mizzen/watch), import (the generated project), author preview (a folder; other author commands write a file here); pack writes a file here instead of stdout; inputs export writes the package here
  --theme <dir>        Theme root folder (layouts/, chrome/, components/); author preview, verify, propose, and write build with it
  --diagnose           For build: write .mizzen/build-report.json after the build
  --format <format>    text, json, or sarif (check and doctor; default: text); text, json, or markdown for diff; text or json for compare, reproduce, readiness, data schema, data transform-diff, edit apply, edit verify, urls check, and published-site check; markdown or json for pack
  --sitemap <url>      Sitemap or sitemap index URL for published-site check
  --domain <host>      The one host published-site check may request (default: the sitemap's host)
  --redirects <file>   Redirect map for published-site check: a JSON object from a source address to its final address
  --hash <hex>         Expected build hash for verify (default: the manifest's)
  --site <dir>         Site root for edit verify (default: .)
  --input <file>       Public evidence for a verification proof: files, before, checks, output, human review, and package binding
  --doctor             Rerun the doctor for edit verify
  --port <number>      Port for dev (default: 3000; 0 picks a free one)
  --host <host>        Host for dev (default: 127.0.0.1)
  --as-of <date|today> The date the build pretends it is, YYYY-MM-DD (build, check, watch, data quality); today reads the system date once. Wins over the config's asOf
  --workers <n|auto>   Render pages in n worker threads; auto is the CPU count minus one (default: 1)
  --check              For data fetch: compare with mizzen.lock.json without writing; for data transform-diff: exit 1 on a change, 2 on a failure; for reproduce: preflight only
  --allow-dirty        For data snapshot: record the last commit although the file has uncommitted changes
  --json               For data quality: print the findings and scopes as JSON; for data refresh: print the report; for data explain: print the versioned lineage report; for inputs inspect: print the report as JSON; for author: print the task list, validation, preview, verification, proposal, or write result
  --field <path>       For data explain: the field to trace, such as title or author.name
  --public             For data explain: print only permitted metadata, with no values or internal paths
  --limit <n>          For data transform: records to show per collection (default: 5)
  --write              For data quality: record the current data as data-quality.json
  --update-urls        For build: accept changed record URLs and write urls.lock.json
  --report             For build: print why each page was rebuilt after a warm build
  --report <file>      For data refresh: write the structured report here; for readiness: write the versioned JSON report
  --update-blocks      For build: give pages stable block ids and write blocks.lock.json
  --request <file|->   Versioned JSON context request for pack; - reads stdin
  --task <file>        JSON task contract for pack; compiles task-aware context against the site
  --topic <name>       Topic for pack (default: the site's only topic); not with --request or --task
  --budget <tokens>    Token budget for pack, overriding the topic's; for author tasks or export: the task or pack budget
  --against <x>        For api check: a built folder or a git ref holding the API consumers rely on
  --base <path>        For build: write the site under this base path (such as /preview/pr-1); for diff: build this git ref and compare it with the current site (one dir)
  --commit <sha>       For build: record this commit in a preview's manifest (default: GITHUB_SHA)
  --preview-canonical <url>
                       For build: mark every page noindex and point its canonical at this URL plus the page's URL
  --baseline <dir>     For build: the latest public build to compare this preview with, written to .mizzen/preview-diff.json; needs --preview-canonical
  --fail-on <kinds>    For diff: exit 1 on removed-pages, broken-urls, or render-only (comma-separated)
  --change-type <type> For diff: list only one change type, such as heading, table, link, or record
  --fail-on-manual     For import: exit 1 while a manual item has no recorded decision
  --allow <ids>        For import: comma-separated manual-item ids recorded as reviewed, with --fail-on-manual
  --max-entries <n>    For diff --format markdown: table rows before "N more" (default: 50)
  --link-base <url>    For diff --format markdown: link page URLs under this base
  --allow-edits        For mcp: also offer apply_edit, which writes a patch to source with a proof
  --print-config <c>   For mcp: print the configuration for claude-code, claude-desktop, cursor, or vscode, and exit
  --starter <name>     For init: the theme starter to copy into the folder (default folder: .)
  --collections <a,b>  For inputs export: collections to carry; their references targets are added. For data refresh: collections to fetch (default: every collection)
  --collection <name>  For data transform-diff: the collection to compare when both configs declare several
  --accept <ids|all>   For inputs import: inputs whose differing destination files or lock entries may be replaced
  --list               For init: print the theme's starters with their titles and descriptions
  --min <section>=<n>  For readiness: minimum score for one rubric section (repeatable)
  --min-overall <n>    For readiness: minimum overall score
  --fail-on-unknown    For readiness: fail when a rule has no evidence
  --evals <file>       For readiness: an evaluation report whose suite, version, and build snapshot must match
  --badge <file>       For readiness: write a deterministic SVG badge (.md writes Markdown)
  --evidence <url>     For readiness: public CI evidence link kept in the report and badge
  --compare <file>     For readiness: compare this build with an earlier verified report
  --lang <a,b>         For init: keep only these of the starter's optional languages
  --dry-run            For edit apply: print the diff without writing; for versions snapshot: print the files without writing
  --allow-unchecked    Apply an edit apply patch that carries neither "expected" nor "beforeHash"
  --proof <path>       Proof record for edit apply (default: <patch>.proof.json)
  --baseline <file>    For surface or behavior: compare against an earlier report written by this command
  --min <percent>      For surface: exit 1 when the documented percentage is below this, 0 to 100
  --min-verified <pct> For behavior: exit 1 when the verified percentage is below this, 0 to 100
  --manifest <file>    For federation fetch: read this manifest instead of the config's federation.manifest
  --goal <text>        For federation pack: the topic the pack is about
  --budget <tokens>    For federation pack: the one shared budget
  --per-project <n>    For federation pack: the most fragments one project may contribute
  --claim <id>         For federation chain: the claim to start from
  --reference <file>   For federation resolve: a JSON file holding one stable reference
  --version <version>  For surface or behavior: the product version to inventory or query; for author: the version the gap is inventoried at
  --status <status>    For behavior: only supported, experimental, deprecated, or removed
  --os <name>          For behavior: only behaviors that cover this operating system
  --language <name>    For behavior: only behaviors that cover this language
  --runtime <name>     For behavior: only behaviors that cover this runtime
  --policy <file>      For author preview or write: the repository access policy the write must satisfy
  --approval <file>    For author preview or write: an approval made under that policy and snapshot
  --approve            For author preview or write: approve the write on the command line
  --item <id>          For author tasks: only this public surface item, such as symbol:parseWidget
  -h, --help           Show this help

Exit codes: 0 ok, 1 errors, 2 usage.`;

export type Io = {
  readonly log?: (message: string) => void;
  readonly error?: (message: string) => void;
  /** Writes a command's payload, such as a pack, to stdout; defaults to `process.stdout.write`. */
  readonly write?: (text: string) => void;
  /** Reads stdin for `pack --request -`; defaults to the process's stream, left open after the read. */
  readonly readStdin?: () => Promise<string>;
  /** The system clock for `--as-of today`; defaults to `new Date()`. The one place a build's date may come from a clock. */
  readonly now?: () => Date;
};

type BuildOpts = {
  readonly command: "build";
  readonly root: string;
  readonly out: string;
  readonly theme?: string;
  readonly workers?: number;
  readonly updateUrls?: boolean;
  readonly updateBlocks?: boolean;
  readonly asOf?: string;
  readonly report?: boolean;
  readonly basePath?: string;
  readonly previewCanonical?: string;
  readonly baseline?: string;
  readonly commit?: string;
  readonly diagnose?: boolean;
};

type CheckOpts = {
  readonly command: "check";
  readonly root: string;
  readonly format: Format;
  readonly theme?: string;
  readonly workers?: number;
  readonly asOf?: string;
  /** Also score the staging build against the public readiness rubric. */
  readonly agents?: boolean;
};

type ReadinessOpts = {
  readonly command: "readiness";
} & ReadinessCommandOptions;

type DoctorOpts = {
  readonly command: "doctor";
  readonly root: string;
  readonly format: Format;
  readonly theme?: string;
};

type DevOpts = {
  readonly command: "dev";
  readonly root: string;
  readonly out?: string;
  readonly port: number;
  readonly host: string;
  readonly theme?: string;
};

type PackOpts = {
  readonly command: "pack";
  readonly root: string;
  readonly topic?: string;
  readonly budget?: number;
  readonly request?: string;
  readonly task?: string;
  readonly format?: PackFormat;
  readonly out?: string;
};

type VerifyOpts = {
  readonly command: "verify";
  readonly root: string;
  readonly hash?: string;
};

type EditVerifyOpts = {
  readonly command: "edit-verify";
  readonly proof: string;
  readonly site: string;
  readonly doctor: boolean;
  readonly format: EditFormat;
  readonly input?: string;
};

type WatchOpts = {
  readonly command: "watch";
  readonly root: string;
  readonly out?: string;
  readonly theme?: string;
  readonly asOf?: string;
};

type DataFetchOpts = {
  readonly command: "data-fetch";
  readonly root: string;
  readonly check: boolean;
};

type DataExtractOpts = {
  readonly command: "data-extract";
  readonly root: string;
  readonly check: boolean;
};

type DataRefreshOpts = {
  readonly command: "data-refresh";
  readonly root: string;
  readonly collections?: readonly string[];
  readonly report: string;
  readonly json: boolean;
};

type DataSnapshotOpts = {
  readonly command: "data-snapshot";
  readonly root: string;
  readonly name: string;
  readonly allowDirty: boolean;
};

type DataChangesOpts = {
  readonly command: "data-changes";
  readonly root: string;
  readonly name?: string;
  readonly write: boolean;
  readonly check: boolean;
  readonly from?: string;
};

type DataVerifyOpts = {
  readonly command: "data-verify";
  readonly root: string;
};

type DataSchemaOpts = {
  readonly command: "data-schema";
  readonly root: string;
  readonly format: "text" | "json";
};

type DataMigrateOpts = {
  readonly command: "data-migrate";
  readonly root: string;
  readonly name?: string;
};

type DataExplainOpts = {
  readonly command: "data-explain";
  readonly root: string;
  readonly collection: string;
  readonly id: string;
  readonly field: string;
  readonly json: boolean;
  readonly public: boolean;
};

type DataTransformOpts = {
  readonly command: "data-transform";
  readonly root: string;
  readonly name?: string;
  readonly limit?: number;
  readonly json: boolean;
};

type DataTransformDiffOpts = {
  readonly command: "data-transform-diff";
  readonly root: string;
  readonly baseline: string;
  readonly proposed: string;
  readonly collection?: string;
  readonly format: "text" | "json";
  readonly check: boolean;
};

type DataQualityOpts = {
  readonly command: "data-quality";
  readonly root: string;
  readonly json: boolean;
  readonly write: boolean;
  readonly asOf?: string;
};

type InputsOpts = {
  readonly command: "inputs";
  readonly args: readonly string[];
};

type InitOpts = {
  readonly command: "init";
  readonly root: string;
  readonly starter?: string;
  readonly list: boolean;
  readonly langs?: readonly string[];
  readonly theme?: string;
};

type UrlsCheckOpts = {
  readonly command: "urls";
  readonly root: string;
  readonly format: "text" | "json";
};

type EvidenceOpts = {
  readonly command: "evidence";
  readonly args: readonly string[];
};

type NetworkOpts = {
  readonly command: "network";
  readonly args: readonly string[];
};

type PublishedSiteOpts = {
  readonly command: "published-site";
  readonly args: readonly string[];
};

type StaleOpts = {
  readonly command: "stale";
  readonly args: readonly string[];
};

type ReferencesOpts = {
  readonly command: "references";
  readonly args: readonly string[];
};

type TraceOpts = {
  readonly command: "trace";
  readonly args: readonly string[];
};

type EvalOpts = {
  readonly command: "eval";
  readonly args: readonly string[];
};

type AgentOpts = {
  readonly command: "agent";
  readonly args: readonly string[];
};

type ExamplesOpts = {
  readonly command: "examples";
  readonly args: readonly string[];
};

type GraphOpts = {
  readonly command: "graph";
  readonly args: readonly string[];
};

type KnowledgeOpts = {
  readonly command: "knowledge";
  readonly args: readonly string[];
};

type VersionsOpts = {
  readonly command: "versions";
  readonly args: readonly string[];
};

type SurfaceOpts = {
  readonly command: "surface";
  readonly args: readonly string[];
};

type DecisionsOpts = {
  readonly command: "decisions";
  readonly args: readonly string[];
};

type BehaviorOpts = {
  readonly command: "behavior";
  readonly args: readonly string[];
};

type FederationOpts = {
  readonly command: "federation";
  readonly args: readonly string[];
};

type AuthorOpts = {
  readonly command: "author";
  readonly args: readonly string[];
};

type EditApplyOpts = {
  readonly command: "edit-apply";
  readonly root: string;
  readonly patch: string;
  readonly dryRun: boolean;
  readonly allowUnchecked?: boolean;
  readonly proof?: string;
  readonly policy?: string;
  readonly format: EditFormat;
};

type EditTransactionOpts = {
  readonly command: "edit-transaction";
  readonly root: string;
  readonly transaction: string;
  readonly dryRun: boolean;
  readonly rebase: boolean;
  readonly approve: boolean;
  readonly receipt?: string;
  readonly proof?: string;
  readonly audit?: string;
  readonly format: EditFormat;
  readonly policy?: string;
};

type EditRollbackOpts = {
  readonly command: "edit-rollback";
  readonly root: string;
  readonly receipt: string;
  readonly format: EditFormat;
};

type DiffOpts = {
  readonly command: "diff";
  readonly dirs: readonly string[];
  readonly base?: string;
  readonly format: DiffFormat;
  readonly failOn: readonly FailKind[];
  readonly changeTypes?: readonly ChangeType[];
  readonly maxEntries?: number;
  readonly linkBase?: string;
  readonly theme?: string;
};

type ReproduceOpts = {
  readonly command: "reproduce";
  readonly manifest: string;
  readonly root: string;
  readonly out: string;
  readonly theme?: string;
  readonly check: boolean;
  readonly format: "text" | "json";
};

type CompareOpts = {
  readonly command: "compare";
  readonly before: string;
  readonly after: string;
  readonly format: "text" | "json";
};

type ApiCheckOpts = {
  readonly command: "api-check";
  readonly root: string;
  readonly against: string;
  readonly theme?: string;
};

type McpOpts = {
  readonly command: "mcp";
  readonly root: string;
  readonly theme?: string;
  readonly allowEdits: boolean;
  readonly printConfig?: string;
  readonly policy?: string;
};

type ImportOpts = {
  readonly command: "import";
  readonly name: string;
  readonly root: string;
  readonly out?: string;
  readonly failOnManual?: boolean;
  readonly allow?: readonly string[];
};

type Parsed =
  | { readonly help: true }
  | { readonly error: string }
  | {
      readonly options:
        | BuildOpts
        | CheckOpts
        | ReadinessOpts
        | DevOpts
        | DoctorOpts
        | EditApplyOpts
        | EditTransactionOpts
        | EditRollbackOpts
        | EditVerifyOpts
        | PackOpts
        | DiffOpts
        | ReproduceOpts
        | CompareOpts
        | ApiCheckOpts
        | VerifyOpts
        | WatchOpts
        | DataFetchOpts
        | DataExtractOpts
        | DataRefreshOpts
        | DataSnapshotOpts
        | DataVerifyOpts
        | DataSchemaOpts
        | DataMigrateOpts
        | DataExplainOpts
        | DataTransformOpts
        | DataTransformDiffOpts
        | DataQualityOpts
        | DataChangesOpts
        | UrlsCheckOpts
        | InitOpts
        | ImportOpts
        | InputsOpts
        | McpOpts
        | EvidenceOpts
        | NetworkOpts
        | PublishedSiteOpts
        | ReferencesOpts
        | ExamplesOpts
        | GraphOpts
        | KnowledgeOpts
        | StaleOpts
        | TraceOpts
        | EvalOpts
        | AgentOpts
        | VersionsOpts
        | SurfaceOpts
        | DecisionsOpts
        | BehaviorOpts
        | FederationOpts
        | AuthorOpts;
    };

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Resolves a theme package name from `from` (a folder that may hold node_modules). */
function resolvePackage(name: string, from: string): string | undefined {
  try {
    const require = createRequire(join(from, "package.json"));
    return dirname(require.resolve(`${name}/package.json`));
  } catch {
    try {
      const require = createRequire(join(from, "noop.js"));
      return dirname(require.resolve(`${name}/package.json`));
    } catch {
      return undefined;
    }
  }
}

/**
 * Picks the theme root: `--theme`, then `theme.name` in the site config (path or package),
 * then a `lateen` checkout beside this package when it exists.
 */
export async function resolveThemeRoot(siteRoot: string, themeFlag: string | undefined): Promise<string | undefined> {
  if (themeFlag !== undefined) return resolve(themeFlag);

  const { config } = loadConfig(siteRoot);
  const name = config.theme.name;
  if (name !== undefined && name.length > 0) {
    if (name.startsWith(".") || name.startsWith("/") || isAbsolute(name)) {
      return resolve(siteRoot, name);
    }
    if (await exists(resolve(siteRoot, name))) return resolve(siteRoot, name);
    const fromSite = resolvePackage(name, siteRoot);
    if (fromSite !== undefined) return fromSite;
    const fromCwd = resolvePackage(name, process.cwd());
    if (fromCwd !== undefined) return fromCwd;
    return undefined;
  }

  if (SIBLING_THEME !== undefined && (await exists(SIBLING_THEME))) return SIBLING_THEME;
  return undefined;
}

/**
 * Parses `mizzen edit apply ...`. A two-word command keeps room for the other subcommands an
 * agent workflow needs without changing the shape of every option.
 */
function parseEditApply(args: readonly string[]): Parsed {
  const [subcommand, ...rest] = args;
  if (subcommand === undefined) return { error: "edit needs a subcommand: apply or verify" };
  if (subcommand === "-h" || subcommand === "--help") return { help: true };
  if (subcommand !== "apply") return { error: `unknown edit subcommand: ${subcommand}` };

  let patch: string | undefined;
  let root: string | undefined;
  let proof: string | undefined;
  let policy: string | undefined;
  let dryRun = false;
  let allowUnchecked = false;
  let format: EditFormat = "text";
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    const value = (): string => {
      const next = rest[++i];
      if (next === undefined || next.startsWith("-")) throw new Error(`${arg} needs a value`);
      return next;
    };
    try {
      if (arg === "-h" || arg === "--help") return { help: true };
      if (arg === "--dry-run") dryRun = true;
      else if (arg === "--allow-unchecked") allowUnchecked = true;
      else if (arg === "--proof") proof = value();
      else if (arg === "--policy") policy = value();
      else if (arg === "--format") {
        const raw = value();
        const parsed = editFormat(raw);
        if (parsed === undefined) return { error: `--format for edit apply must be text or json, not ${raw}` };
        format = parsed;
      } else if (arg.startsWith("-")) return { error: `unknown option: ${arg}` };
      else if (patch === undefined) patch = arg;
      else if (root === undefined) root = arg;
      else return { error: `unexpected argument: ${arg}` };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  if (patch === undefined) return { error: "edit apply needs a patch file: edit apply <patch.json> [dir]" };
  return {
    options: {
      command: "edit-apply",
      root: root ?? ".",
      patch,
      dryRun,
      format,
      ...(allowUnchecked ? { allowUnchecked: true } : {}),
      ...(proof === undefined ? {} : { proof }),
      ...(policy === undefined ? {} : { policy }),
    },
  };
}

/** Parses `mizzen edit transaction <file> [dir] [--dry-run] [--rebase] [--approve] ...`. */
function parseEditTransaction(args: readonly string[]): Parsed {
  const [subcommand, ...rest] = args;
  if (subcommand === "-h" || subcommand === "--help" || subcommand === "help") return { help: true };
  if (subcommand !== "transaction") return { error: `unknown edit subcommand: ${subcommand}` };

  let transaction: string | undefined;
  let root: string | undefined;
  let receipt: string | undefined;
  let proof: string | undefined;
  let audit: string | undefined;
  let policy: string | undefined;
  let dryRun = false;
  let rebase = false;
  let approve = false;
  let format: EditFormat = "text";
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    const value = (): string => {
      const next = rest[++i];
      if (next === undefined || next.startsWith("-")) throw new Error(`${arg} needs a value`);
      return next;
    };
    try {
      if (arg === "-h" || arg === "--help") return { help: true };
      if (arg === "--dry-run") dryRun = true;
      else if (arg === "--rebase") rebase = true;
      else if (arg === "--approve") approve = true;
      else if (arg === "--receipt") receipt = value();
      else if (arg === "--proof") proof = value();
      else if (arg === "--audit") audit = value();
      else if (arg === "--policy") policy = value();
      else if (arg === "--format") {
        const parsed = editFormat(value());
        if (parsed === undefined) return { error: `--format for edit transaction must be text or json, not ${rest[i]}` };
        format = parsed;
      } else if (arg.startsWith("-")) return { error: `unknown option: ${arg}` };
      else if (transaction === undefined) transaction = arg;
      else if (root === undefined) root = arg;
      else return { error: `unexpected argument: ${arg}` };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
  if (transaction === undefined) {
    return { error: "edit transaction needs a file: edit transaction <transaction.json> [dir]" };
  }
  return {
    options: {
      command: "edit-transaction",
      root: root ?? ".",
      transaction,
      dryRun,
      rebase,
      approve,
      ...(receipt === undefined ? {} : { receipt }),
      ...(proof === undefined ? {} : { proof }),
      ...(audit === undefined ? {} : { audit }),
      ...(policy === undefined ? {} : { policy }),
      format,
    },
  };
}

/** Parses `mizzen edit rollback <receipt.json> [dir]`. */
function parseEditRollback(args: readonly string[]): Parsed {
  const [subcommand, ...rest] = args;
  if (subcommand === "-h" || subcommand === "--help" || subcommand === "help") return { help: true };
  if (subcommand !== "rollback") return { error: `unknown edit subcommand: ${subcommand}` };

  let receipt: string | undefined;
  let root: string | undefined;
  let format: EditFormat = "text";
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    const value = (): string => {
      const next = rest[++i];
      if (next === undefined || next.startsWith("-")) throw new Error(`${arg} needs a value`);
      return next;
    };
    try {
      if (arg === "-h" || arg === "--help") return { help: true };
      if (arg === "--format") {
        const parsed = editFormat(value());
        if (parsed === undefined) return { error: `--format for edit rollback must be text or json, not ${rest[i]}` };
        format = parsed;
      } else if (arg.startsWith("-")) return { error: `unknown option: ${arg}` };
      else if (receipt === undefined) receipt = arg;
      else if (root === undefined) root = arg;
      else return { error: `unexpected argument: ${arg}` };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
  if (receipt === undefined) {
    return { error: "edit rollback needs a receipt: edit rollback <receipt.json> [dir]" };
  }
  return { options: { command: "edit-rollback", root: root ?? ".", receipt, format } };
}

/** Parses `edit verify <proof.json> [--site <dir>] [--doctor]`. */
function parseEditVerify(args: readonly string[]): Parsed {
  const [subcommand, ...rest] = args;
  if (subcommand === "-h" || subcommand === "--help" || subcommand === "help") return { help: true };
  if (subcommand === undefined) return { error: "edit needs a subcommand: apply or verify" };
  if (subcommand !== "verify") return { error: `unknown command: edit ${subcommand}` };

  let proof: string | undefined;
  let site = ".";
  let doctor = false;
  let format: EditFormat = "text";
  let input: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    const value = (): string => {
      const next = rest[++i];
      if (next === undefined || next.startsWith("-")) throw new Error(`${arg} needs a value`);
      return next;
    };
    try {
      if (arg === "-h" || arg === "--help") return { help: true };
      if (arg === "--site") site = value();
      else if (arg === "--doctor") doctor = true;
      else if (arg === "--input") input = value();
      else if (arg === "--format") {
        const raw = value();
        const parsed = editFormat(raw);
        if (parsed === undefined) return { error: `--format for edit verify must be text or json, not ${raw}` };
        format = parsed;
      } else if (arg.startsWith("-")) return { error: `unknown option: ${arg}` };
      else if (proof === undefined) proof = arg;
      else return { error: `unexpected argument: ${arg}` };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  if (proof === undefined) return { error: `edit verify needs a proof file: ${NAME} edit verify <proof.json>` };
  return { options: { command: "edit-verify", proof, site, doctor, format, ...(input === undefined ? {} : { input }) } };
}

/** Parses `data snapshot <name> [dir] [--allow-dirty]`. */
function parseDataSnapshot(rest: readonly string[]): Parsed {
  let name: string | undefined;
  let root: string | undefined;
  let allowDirty = false;
  for (const arg of rest) {
    if (arg === "-h" || arg === "--help") return { help: true };
    if (arg === "--allow-dirty") allowDirty = true;
    else if (arg.startsWith("-")) return { error: `unknown option: ${arg}` };
    else if (name === undefined) name = arg;
    else if (root === undefined) root = arg;
    else return { error: `unexpected argument: ${arg}` };
  }
  if (name === undefined) return { error: "data snapshot needs a collection name" };
  return { options: { command: "data-snapshot", root: root ?? ".", name, allowDirty } };
}

/** Parses `data changes [name] [dir] [--write] [--check] [--from <ref|folder>]`. */
function parseDataChanges(rest: readonly string[]): Parsed {
  const positional: string[] = [];
  let write = false;
  let check = false;
  let from: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "-h" || arg === "--help") return { help: true };
    if (arg === "--write") write = true;
    else if (arg === "--check") check = true;
    else if (arg === "--from") {
      from = rest[++i];
      if (from === undefined) return { error: "--from needs a git ref or a folder" };
    } else if (arg.startsWith("-")) return { error: `unknown option: ${arg}` };
    else positional.push(arg);
  }
  if (positional.length > 2) return { error: `unexpected argument: ${positional[2]}` };
  if (write && check) return { error: "--write and --check cannot be used together" };
  const [name, root] = positional;
  return { options: { command: "data-changes", root: root ?? ".", ...(name === undefined ? {} : { name }), write, check, ...(from === undefined ? {} : { from }) } };
}

/** Parses `data schema [dir] [--format text|json]`. */
function parseDataSchema(rest: readonly string[]): Parsed {
  let root: string | undefined;
  let format: "text" | "json" = "text";
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "-h" || arg === "--help") return { help: true };
    if (arg === "--format") {
      const raw = rest[++i];
      if (raw !== "text" && raw !== "json") return { error: `--format for data schema must be text or json, not ${raw ?? ""}` };
      format = raw;
    } else if (arg.startsWith("-")) return { error: `unknown option: ${arg}` };
    else if (root === undefined) root = arg;
    else return { error: `unexpected argument: ${arg}` };
  }
  return { options: { command: "data-schema", root: root ?? ".", format } };
}

/** Parses `data migrate [collection] [dir]`. */
function parseDataMigrate(rest: readonly string[]): Parsed {
  const positional: string[] = [];
  for (const arg of rest) {
    if (arg === "-h" || arg === "--help") return { help: true };
    if (arg.startsWith("-")) return { error: `unknown option: ${arg}` };
    positional.push(arg);
  }
  if (positional.length > 2) return { error: `unexpected argument: ${positional[2]}` };
  const [name, root] = positional;
  return { options: { command: "data-migrate", root: root ?? ".", ...(name === undefined ? {} : { name }) } };
}

/** Parses `data explain <collection> <id> [dir] --field <path> [--json] [--public]`. */
function parseDataExplain(rest: readonly string[]): Parsed {
  const positional: string[] = [];
  let field: string | undefined;
  let json = false;
  let publicReport = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "-h" || arg === "--help") return { help: true };
    if (arg === "--json") json = true;
    else if (arg === "--public") publicReport = true;
    else if (arg === "--field") {
      const next = rest[++i];
      if (next === undefined || next.startsWith("-")) return { error: "--field needs a field path" };
      field = next;
    } else if (arg.startsWith("-")) return { error: `unknown option: ${arg}` };
    else positional.push(arg);
  }
  if (positional.length < 2) return { error: "data explain needs a collection and a record id: data explain <collection> <id> [dir] --field <path>" };
  if (positional.length > 3) return { error: `unexpected argument: ${positional[3]}` };
  if (field === undefined) return { error: "data explain needs --field <path>" };
  const [collection, id, root] = positional;
  return {
    options: {
      command: "data-explain",
      root: root ?? ".",
      collection: collection!,
      id: id!,
      field,
      json,
      public: publicReport,
    },
  };
}

/** Parses `data transform [name] [dir] [--limit <n>] [--json]`. */
function parseDataTransform(rest: readonly string[]): Parsed {
  let name: string | undefined;
  let root: string | undefined;
  let limit: number | undefined;
  let json = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "-h" || arg === "--help") return { help: true };
    if (arg === "--json") json = true;
    else if (arg === "--limit") {
      const raw = rest[++i];
      const value = raw === undefined ? Number.NaN : Number(raw);
      if (!Number.isSafeInteger(value) || value < 1) return { error: "--limit needs a whole number of at least 1" };
      limit = value;
    } else if (arg.startsWith("-")) return { error: `unknown option: ${arg}` };
    else if (name === undefined) name = arg;
    else if (root === undefined) root = arg;
    else return { error: `unexpected argument: ${arg}` };
  }
  return {
    options: {
      command: "data-transform",
      root: root ?? ".",
      ...(name === undefined ? {} : { name }),
      ...(limit === undefined ? {} : { limit }),
      json,
    },
  };
}

/** Parses `data transform-diff <baseline> <proposed> [dir] [--collection <name>] [--format text|json] [--check]`. */
function parseDataTransformDiff(rest: readonly string[]): Parsed {
  const positional: string[] = [];
  let collection: string | undefined;
  let format: "text" | "json" = "text";
  let check = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "-h" || arg === "--help") return { help: true };
    if (arg === "--check") check = true;
    else if (arg === "--collection") {
      const next = rest[++i];
      if (next === undefined || next.startsWith("-")) return { error: "--collection needs a name" };
      collection = next;
    } else if (arg === "--format") {
      const next = rest[++i];
      if (next !== "text" && next !== "json") return { error: `--format for data transform-diff must be text or json, not ${next ?? ""}` };
      format = next;
    } else if (arg.startsWith("-")) return { error: `unknown option: ${arg}` };
    else positional.push(arg);
  }
  if (positional.length < 2) return { error: "data transform-diff needs a baseline and a proposed config: data transform-diff <baseline> <proposed> [dir]" };
  if (positional.length > 3) return { error: `unexpected argument: ${positional[3]}` };
  const [baseline, proposed, root] = positional;
  return {
    options: {
      command: "data-transform-diff",
      root: root ?? ".",
      baseline: baseline!,
      proposed: proposed!,
      ...(collection === undefined ? {} : { collection }),
      format,
      check,
    },
  };
}

/** Parses `data fetch [dir] [--check]` and `data snapshot <name> [dir] [--allow-dirty]`. */
function parseData(args: readonly string[]): Parsed {
  const [subcommand, ...rest] = args;
  if (subcommand === undefined) return { error: "data needs a subcommand: extract, fetch, snapshot, changes, verify, schema, migrate, transform" };
  if (subcommand === "-h" || subcommand === "--help" || subcommand === "help") return { help: true };
  if (subcommand === "schema") return parseDataSchema(rest);
  if (subcommand === "migrate") return parseDataMigrate(rest);
  if (subcommand === "explain") return parseDataExplain(rest);
  if (subcommand === "transform") return parseDataTransform(rest);
  if (subcommand === "transform-diff") return parseDataTransformDiff(rest);
  if (subcommand === "snapshot") return parseDataSnapshot(rest);
  if (subcommand === "changes") return parseDataChanges(rest);
  if (subcommand === "verify") {
    let root: string | undefined;
    for (const arg of rest) {
      if (arg === "-h" || arg === "--help") return { help: true };
      if (arg.startsWith("-")) return { error: `unknown option: ${arg}` };
      if (root === undefined) root = arg;
      else return { error: `unexpected argument: ${arg}` };
    }
    return { options: { command: "data-verify", root: root ?? "." } };
  }
  if (subcommand === "quality") {
    let root: string | undefined;
    let json = false;
    let write = false;
    let asOf: string | undefined;
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i]!;
      if (arg === "-h" || arg === "--help") return { help: true };
      if (arg === "--json") json = true;
      else if (arg === "--write") write = true;
      else if (arg === "--as-of") {
        const raw = rest[++i];
        if (raw === undefined || raw.startsWith("-")) return { error: "--as-of needs a value" };
        // `today` is resolved at the edge of main, where the clock may be read; here only the shape is checked.
        const read = readAsOfFlag(raw, () => "0001-01-01");
        if (!read.ok) return { error: `--as-of ${read.message}` };
        asOf = raw;
      } else if (arg.startsWith("-")) return { error: `unknown option: ${arg}` };
      else if (root === undefined) root = arg;
      else return { error: `unexpected argument: ${arg}` };
    }
    return { options: { command: "data-quality", root: root ?? ".", json, write, ...(asOf === undefined ? {} : { asOf }) } };
  }
  if (subcommand === "extract") {
    let root: string | undefined;
    let check = false;
    for (const arg of rest) {
      if (arg === "-h" || arg === "--help") return { help: true };
      if (arg === "--check") check = true;
      else if (arg.startsWith("-")) return { error: `unknown option: ${arg}` };
      else if (root === undefined) root = arg;
      else return { error: `unexpected argument: ${arg}` };
    }
    return { options: { command: "data-extract", root: root ?? ".", check } };
  }
  if (subcommand === "refresh") {
    let root: string | undefined;
    let report: string | undefined;
    let json = false;
    const collections: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i]!;
      if (arg === "-h" || arg === "--help") return { help: true };
      if (arg === "--json") json = true;
      else if (arg === "--collections" || arg === "--report") {
        const value = rest[++i];
        if (value === undefined || value.startsWith("-") || value.trim() === "") {
          return { error: `${arg} needs a value` };
        }
        if (arg === "--report") report = value;
        else {
          for (const name of value.split(",").map((part) => part.trim()).filter((part) => part !== "")) {
            if (!collections.includes(name)) collections.push(name);
          }
        }
      } else if (arg.startsWith("-")) return { error: `unknown option: ${arg}` };
      else if (root === undefined) root = arg;
      else return { error: `unexpected argument: ${arg}` };
    }
    if (report === undefined) return { error: "data refresh needs --report <file>" };
    if (rest.includes("--collections") && collections.length === 0) {
      return { error: "--collections needs at least one collection name" };
    }
    return {
      options: {
        command: "data-refresh",
        root: root ?? ".",
        ...(collections.length === 0 ? {} : { collections }),
        report,
        json,
      },
    };
  }
  if (subcommand !== "fetch") return { error: `unknown data subcommand: ${subcommand}` };

  let root: string | undefined;
  let check = false;
  for (const arg of rest) {
    if (arg === "-h" || arg === "--help") return { help: true };
    if (arg === "--check") check = true;
    else if (arg.startsWith("-")) return { error: `unknown option: ${arg}` };
    else if (root === undefined) root = arg;
    else return { error: `unexpected argument: ${arg}` };
  }
  return { options: { command: "data-fetch", root: root ?? ".", check } };
}

/** Parses `init [dir] [--starter <name>] [--list] [--lang <a,b>] [--theme <dir>]`. */
function parseInit(args: readonly string[]): Parsed {
  let root: string | undefined;
  let starter: string | undefined;
  let list = false;
  let langs: string[] | undefined;
  let theme: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const value = (): string | undefined => {
      const next = args[++i];
      return next === undefined || next.startsWith("-") ? undefined : next;
    };
    if (arg === "-h" || arg === "--help") return { help: true };
    if (arg === "--list") list = true;
    else if (arg === "--starter" || arg === "--lang" || arg === "--theme") {
      const next = value();
      if (next === undefined) return { error: `${arg} needs a value` };
      if (arg === "--starter") starter = next;
      else if (arg === "--theme") theme = next;
      else langs = next.split(",").map((lang) => lang.trim()).filter((lang) => lang !== "");
    } else if (arg.startsWith("-")) return { error: `unknown option: ${arg}` };
    else if (root === undefined) root = arg;
    else return { error: `unexpected argument: ${arg}` };
  }
  if (!list && starter === undefined) return { error: "init needs --starter <name>, or --list to see the starters" };
  return {
    options: {
      command: "init",
      root: root ?? ".",
      list,
      ...(starter === undefined ? {} : { starter }),
      ...(langs === undefined ? {} : { langs }),
      ...(theme === undefined ? {} : { theme }),
    },
  };
}

/** Parses `urls check [dir] [--format text|json]`. */
function parseUrls(args: readonly string[]): Parsed {
  const [subcommand, ...rest] = args;
  if (subcommand === undefined) return { error: "urls needs a subcommand: check" };
  if (subcommand === "-h" || subcommand === "--help" || subcommand === "help") return { help: true };
  if (subcommand !== "check") return { error: `unknown urls subcommand: ${subcommand}` };

  let root: string | undefined;
  let format: "text" | "json" = "text";
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "-h" || arg === "--help") return { help: true };
    if (arg === "--format") {
      const raw = rest[++i];
      if (raw !== "text" && raw !== "json") return { error: `--format for urls check must be text or json, not ${raw ?? ""}` };
      format = raw;
    } else if (arg.startsWith("-")) return { error: `unknown option: ${arg}` };
    else if (root === undefined) root = arg;
    else return { error: `unexpected argument: ${arg}` };
  }
  return { options: { command: "urls", root: root ?? ".", format } };
}

/** Parses `api check [dir] --against <folder|ref> [--theme <dir>]`. */
function parseApi(args: readonly string[]): Parsed {
  const [subcommand, ...rest] = args;
  if (subcommand === undefined) return { error: "api needs a subcommand: check" };
  if (subcommand === "-h" || subcommand === "--help" || subcommand === "help") return { help: true };
  if (subcommand !== "check") return { error: `unknown api subcommand: ${subcommand}` };
  let root: string | undefined;
  let against: string | undefined;
  let theme: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "-h" || arg === "--help") return { help: true };
    if (arg === "--against" || arg === "--theme") {
      const value = rest[++i];
      if (value === undefined || value.startsWith("-")) return { error: `${arg} needs a value` };
      if (arg === "--against") against = value;
      else theme = value;
    } else if (arg.startsWith("-")) return { error: `unknown option: ${arg}` };
    else if (root === undefined) root = arg;
    else return { error: `unexpected argument: ${arg}` };
  }
  if (against === undefined) return { error: "api check needs --against <built folder|git ref>" };
  return { options: { command: "api-check", root: root ?? ".", against, ...(theme === undefined ? {} : { theme }) } };
}

/** Parses `diff <a> <b>` and `diff --base <ref> [dir]`. */
function parseDiff(args: readonly string[]): Parsed {
  const dirs: string[] = [];
  let base: string | undefined;
  let format: DiffFormat = "text";
  let failOn: FailKind[] = [];
  let changeTypes: ChangeType[] | undefined;
  let maxEntries: number | undefined;
  let linkBase: string | undefined;
  let theme: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const value = (): string => {
      const next = args[++i];
      if (next === undefined || next.startsWith("-")) throw new Error(`${arg} needs a value`);
      return next;
    };
    try {
      if (arg === "-h" || arg === "--help") return { help: true };
      if (arg === "--format") {
        const raw = value();
        if (!(DIFF_FORMATS as readonly string[]).includes(raw)) return { error: `--format for diff must be text, json, or markdown, not ${raw}` };
        format = raw as DiffFormat;
      } else if (arg === "--base") base = value();
      else if (arg === "--fail-on") {
        const kinds = parseFailOn(value());
        if (typeof kinds === "string") return { error: kinds };
        failOn = kinds;
      } else if (arg === "--change-type") {
        const types = parseChangeType(value());
        if (typeof types === "string") return { error: types };
        changeTypes = types;
      } else if (arg === "--max-entries") {
        const raw = value();
        const n = Number(raw);
        if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < 1) return { error: `--max-entries must be a positive whole number, not ${raw}` };
        maxEntries = n;
      } else if (arg === "--link-base") linkBase = value();
      else if (arg === "--theme") theme = value();
      else if (arg.startsWith("-")) return { error: `unknown option: ${arg}` };
      else dirs.push(arg);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
  if (base === undefined && dirs.length !== 2) return { error: "diff needs two built folders: mizzen diff <a> <b>" };
  if (base !== undefined && dirs.length > 1) return { error: "diff --base takes at most one site folder" };
  return {
    options: {
      command: "diff",
      dirs: base === undefined ? dirs : [dirs[0] ?? "."],
      format,
      failOn,
      ...(changeTypes === undefined ? {} : { changeTypes }),
      ...(base === undefined ? {} : { base }),
      ...(maxEntries === undefined ? {} : { maxEntries }),
      ...(linkBase === undefined ? {} : { linkBase }),
      ...(theme === undefined ? {} : { theme }),
    },
  };
}

/** Parses `reproduce <report> [dir] [--out <dir>] [--theme <dir>] [--check] [--format text|json]`. */
function parseReproduce(args: readonly string[]): Parsed {
  let manifest: string | undefined;
  let root: string | undefined;
  let out = "dist";
  let theme: string | undefined;
  let check = false;
  let format: "text" | "json" = "text";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const value = (): string => {
      const next = args[++i];
      if (next === undefined || next.startsWith("-")) throw new Error(`${arg} needs a value`);
      return next;
    };
    try {
      if (arg === "-h" || arg === "--help") return { help: true };
      if (arg === "--out") out = value();
      else if (arg === "--theme") theme = value();
      else if (arg === "--check") check = true;
      else if (arg === "--format") {
        const raw = value();
        if (raw !== "text" && raw !== "json") return { error: `--format for reproduce must be text or json, not ${raw}` };
        format = raw;
      } else if (arg.startsWith("-")) return { error: `unknown option for reproduce: ${arg}` };
      else if (manifest === undefined) manifest = arg;
      else if (root === undefined) root = arg;
      else return { error: `unexpected argument: ${arg}` };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
  if (manifest === undefined) return { error: "reproduce needs a report: mizzen reproduce <report> [dir]" };
  return {
    options: {
      command: "reproduce",
      manifest,
      root: root ?? ".",
      out,
      check,
      format,
      ...(theme === undefined ? {} : { theme }),
    },
  };
}

/** Parses `compare <a> <b> [--format text|json]`. */
function parseCompare(args: readonly string[]): Parsed {
  const reports: string[] = [];
  let format: "text" | "json" = "text";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-h" || arg === "--help") return { help: true };
    if (arg === "--format") {
      const next = args[++i];
      if (next === undefined || next.startsWith("-")) return { error: "--format needs a value" };
      if (next !== "text" && next !== "json") return { error: `--format for compare must be text or json, not ${next}` };
      format = next;
    } else if (arg.startsWith("-")) return { error: `unknown option for compare: ${arg}` };
    else reports.push(arg);
  }
  if (reports.length !== 2) return { error: "compare needs two build reports: mizzen compare <a> <b>" };
  return { options: { command: "compare", before: reports[0]!, after: reports[1]!, format } };
}

/** Parses `mcp [dir] [--theme <dir>] [--allow-edits] [--print-config <client>]`. */
function parseMcp(args: readonly string[]): Parsed {
  let root: string | undefined;
  let theme: string | undefined;
  let allowEdits = false;
  let printConfig: string | undefined;
  let policy: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-h" || arg === "--help") return { help: true };
    if (arg === "--allow-edits") allowEdits = true;
    else if (arg === "--policy") {
      const next = args[++i];
      if (next === undefined || next.startsWith("-")) return { error: "--policy needs a file" };
      policy = next;
    } else if (arg === "--theme" || arg === "--print-config") {
      const next = args[++i];
      if (next === undefined || next.startsWith("-")) return { error: `${arg} needs a value` };
      if (arg === "--theme") theme = next;
      else {
        if (!isClient(next)) return { error: `--print-config must be one of ${Object.keys(CLIENTS).join(", ")}, not ${next}` };
        printConfig = next;
      }
    } else if (arg.startsWith("-")) return { error: `unknown option for mcp: ${arg}` };
    else if (root === undefined) root = arg;
    else return { error: `unexpected argument: ${arg}` };
  }
  return { options: { command: "mcp", root: root ?? ".", allowEdits, ...(theme === undefined ? {} : { theme }), ...(printConfig === undefined ? {} : { printConfig }), ...(policy === undefined ? {} : { policy }) } };
}

/** Parses `import <name> [dir] [--out <dir>] [--fail-on-manual] [--allow <ids>]`. */
function parseImport(args: readonly string[]): Parsed {
  let name: string | undefined;
  let root: string | undefined;
  let out: string | undefined;
  let failOnManual = false;
  const allow: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-h" || arg === "--help") return { help: true };
    if (arg === "--out") {
      const next = args[++i];
      if (next === undefined || next.startsWith("-")) return { error: "--out needs a value" };
      out = next;
    } else if (arg === "--fail-on-manual") {
      failOnManual = true;
    } else if (arg === "--allow") {
      const next = args[++i];
      if (next === undefined || next.startsWith("-") || next.trim() === "") return { error: "--allow needs a value" };
      for (const id of next.split(",")) {
        const trimmed = id.trim();
        if (trimmed !== "" && !allow.includes(trimmed)) allow.push(trimmed);
      }
    } else if (arg.startsWith("-")) return { error: `unknown option for import: ${arg}` };
    else if (name === undefined) name = arg;
    else if (root === undefined) root = arg;
    else return { error: `unexpected argument: ${arg}` };
  }
  if (name === undefined) return { error: "import needs an importer name: mizzen import <name> [dir]" };
  return {
    options: {
      command: "import",
      name,
      root: root ?? ".",
      ...(out === undefined ? {} : { out }),
      ...(failOnManual ? { failOnManual: true } : {}),
      ...(allow.length === 0 ? {} : { allow }),
    },
  };
}

/** Parses `readiness [built] [--built <dir>] [--format text|json] ...`. */
function parseReadiness(args: readonly string[]): Parsed {
  let positional: string | undefined;
  let built: string | undefined;
  let format: "text" | "json" = "text";
  let report: string | undefined;
  let badge: string | undefined;
  let compare: string | undefined;
  let evals: string | undefined;
  let evidence: string | undefined;
  let minOverall: number | undefined;
  let failOnUnknown = false;
  const min: Partial<Record<ReadinessDimension, number>> = {};
  const dimensions = new Set(RUBRIC.dimensions.map((dimension) => dimension.id));

  const score = (raw: string, flag: string): number | string => {
    const value = Number(raw);
    if (!/^\d+(?:\.\d+)?$/.test(raw) || !Number.isFinite(value) || value < 0 || value > 100) {
      return `${flag} must be a score from 0 to 100, not ${raw}`;
    }
    return value;
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const value = (): string => {
      const next = args[++i];
      if (next === undefined || next.startsWith("-")) throw new Error(`${arg} needs a value`);
      return next;
    };
    try {
      if (arg === "-h" || arg === "--help") return { help: true };
      if (arg === "--built") built = value();
      else if (arg === "--format") {
        const raw = value();
        if (raw !== "text" && raw !== "json") return { error: `--format for readiness must be text or json, not ${raw}` };
        format = raw;
      } else if (arg === "--report") report = value();
      else if (arg === "--badge") badge = value();
      else if (arg === "--compare") compare = value();
      else if (arg === "--evals") evals = value();
      else if (arg === "--evidence") evidence = value();
      else if (arg === "--min-overall") {
        const parsed = score(value(), arg);
        if (typeof parsed === "string") return { error: parsed };
        minOverall = parsed;
      } else if (arg === "--min") {
        const raw = value();
        const at = raw.indexOf("=");
        if (at < 0) return { error: `--min needs <section>=<score>, not ${raw}` };
        const section = raw.slice(0, at);
        if (!dimensions.has(section as ReadinessDimension)) {
          return { error: `--min names ${section}; use one of ${[...dimensions].join(", ")}` };
        }
        const parsed = score(raw.slice(at + 1), arg);
        if (typeof parsed === "string") return { error: parsed };
        min[section as ReadinessDimension] = parsed;
      } else if (arg === "--fail-on-unknown") failOnUnknown = true;
      else if (arg.startsWith("-")) return { error: `unknown option for readiness: ${arg}` };
      else if (positional === undefined) positional = arg;
      else return { error: `unexpected argument: ${arg}` };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
  if (positional !== undefined && built !== undefined && positional !== built) {
    return { error: "readiness takes one built folder: use the positional path or --built, not both" };
  }
  return {
    options: {
      command: "readiness",
      built: built ?? positional ?? "dist",
      format,
      min,
      failOnUnknown,
      ...(report === undefined ? {} : { report }),
      ...(badge === undefined ? {} : { badge }),
      ...(compare === undefined ? {} : { compare }),
      ...(evals === undefined ? {} : { evals }),
      ...(evidence === undefined ? {} : { evidence }),
      ...(minOverall === undefined ? {} : { minOverall }),
    },
  };
}

/** Parses `argv` after the process name. */
export function parseArgs(args: readonly string[]): Parsed {
  const [command, ...rest] = args;
  if (command === undefined || command === "-h" || command === "--help" || command === "help") {
    return { help: true };
  }
  if (command === "edit") {
    const subcommand = rest[0];
    if (subcommand === "verify") return parseEditVerify(rest);
    if (subcommand === "transaction") return parseEditTransaction(rest);
    if (subcommand === "rollback") return parseEditRollback(rest);
    return parseEditApply(rest);
  }
  if (command === "evidence") {
    if (rest[0] === "-h" || rest[0] === "--help") return { help: true };
    return { options: { command, args: rest } };
  }
  if (command === "network") {
    if (rest[0] === "-h" || rest[0] === "--help") return { help: true };
    return { options: { command: "network", args: rest } };
  }
  if (command === "published-site") {
    if (rest[0] === "-h" || rest[0] === "--help") return { help: true };
    return { options: { command: "published-site", args: rest } };
  }
  if (command === "stale") {
    if (rest[0] === "-h" || rest[0] === "--help") return { help: true };
    return { options: { command: "stale", args: rest } };
  }
  if (command === "references") {
    if (rest[0] === "-h" || rest[0] === "--help") return { help: true };
    return { options: { command: "references", args: rest } };
  }
  if (command === "trace") {
    if (rest[0] === "-h" || rest[0] === "--help") return { help: true };
    return { options: { command: "trace", args: rest } };
  }
  if (command === "eval") {
    if (rest[0] === "-h" || rest[0] === "--help") return { help: true };
    return { options: { command: "eval", args: rest } };
  }
  if (command === "agent") {
    if (rest[0] === "-h" || rest[0] === "--help") return { help: true };
    return { options: { command: "agent", args: rest } };
  }
  if (command === "examples") {
    if (rest.includes("--help") || rest.includes("-h")) return { help: true };
    return { options: { command: "examples", args: rest } };
  }
  if (command === "graph") {
    if (rest[0] === "-h" || rest[0] === "--help") return { help: true };
    return { options: { command: "graph", args: rest } };
  }
  if (command === "knowledge") {
    if (rest[0] === "-h" || rest[0] === "--help") return { help: true };
    return { options: { command: "knowledge", args: rest } };
  }
  if (command === "decisions") {
    if (rest.includes("--help") || rest.includes("-h")) return { help: true };
    return { options: { command: "decisions", args: rest } };
  }
  if (command === "versions") {
    if (rest[0] === "-h" || rest[0] === "--help") return { help: true };
    return { options: { command: "versions", args: rest } };
  }
  if (command === "surface") {
    if (rest.includes("--help") || rest.includes("-h")) return { help: true };
    return { options: { command: "surface", args: rest } };
  }
  if (command === "behavior") {
    if (rest.includes("--help") || rest.includes("-h")) return { help: true };
    return { options: { command: "behavior", args: rest } };
  }
  if (command === "federation") {
    if (rest.includes("--help") || rest.includes("-h")) return { help: true };
    return { options: { command: "federation", args: rest } };
  }
  if (command === "author") {
    if (rest.includes("--help") || rest.includes("-h")) return { help: true };
    return { options: { command: "author", args: rest } };
  }
  if (command === "inputs") {
    if (rest[0] === "-h" || rest[0] === "--help") return { help: true };
    return { options: { command: "inputs", args: rest } };
  }
  if (command === "data") return parseData(rest);
  if (command === "urls") return parseUrls(rest);
  if (command === "init") return parseInit(rest);
  if (command === "import") return parseImport(rest);
  if (command === "diff") return parseDiff(rest);
  if (command === "reproduce") return parseReproduce(rest);
  if (command === "compare") return parseCompare(rest);
  if (command === "readiness") return parseReadiness(rest);
  if (command === "api") return parseApi(rest);
  if (command === "mcp") return parseMcp(rest);
  if (
    command !== "build" &&
    command !== "check" &&
    command !== "dev" &&
    command !== "doctor" &&
    command !== "pack" &&
    command !== "verify" &&
    command !== "watch"
  ) {
    return { error: `unknown command: ${command}` };
  }

  let root: string | undefined;
  let out: string | undefined;
  let theme: string | undefined;
  let format: Format = "text";
  let hash: string | undefined;
  let port: number = DEFAULT_DEV_PORT;
  let host: string = DEFAULT_DEV_HOST;
  let workers: number | undefined;
  let topic: string | undefined;
  let budget: number | undefined;
  let request: string | undefined;
  let task: string | undefined;
  let packFormat: PackFormat | undefined;
  let updateUrls = false;
  let updateBlocks = false;
  let asOf: string | undefined;
  let report = false;
  let diagnose = false;
  let basePath: string | undefined;
  let previewCanonical: string | undefined;
  let baseline: string | undefined;
  let commit: string | undefined;
  let agents = false;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    const value = (): string => {
      const next = rest[++i];
      if (next === undefined || next.startsWith("-")) throw new Error(`${arg} needs a value`);
      return next;
    };
    try {
      if (arg === "-h" || arg === "--help") return { help: true };
      if (arg === "--out") {
        if (command !== "build" && command !== "dev" && command !== "pack" && command !== "watch") {
          return { error: "--out is only valid for build, dev, pack, and watch" };
        }
        out = value();
      } else if (arg === "--theme") {
        if (command === "verify") return { error: "--theme is only valid for build, check, dev, doctor, and watch" };
        theme = value();
      } else if (arg === "--format") {
        if (command !== "check" && command !== "doctor" && command !== "pack") {
          return { error: "--format is only valid for check, doctor, and pack" };
        }
        const raw = value();
        if (command === "pack") {
          if (!PACK_FORMATS.includes(raw as PackFormat)) {
            return { error: `--format for pack must be markdown or json, not ${raw}` };
          }
          packFormat = raw as PackFormat;
        } else {
          if (!FORMATS.includes(raw as Format)) {
            return { error: `--format must be text, json, or sarif, not ${raw}` };
          }
          format = raw as Format;
        }
      } else if (arg === "--hash") {
        if (command !== "verify") return { error: "--hash is only valid for verify" };
        const raw = value();
        if (!/^[0-9a-f]{64}$/.test(raw)) {
          return { error: `--hash must be 64 lowercase hexadecimal characters, not ${raw}` };
        }
        hash = raw;
      } else if (arg === "--port") {
        if (command !== "dev") return { error: "--port is only valid for dev" };
        const raw = value();
        const parsed = Number(raw);
        if (!/^\d+$/.test(raw) || !Number.isInteger(parsed) || parsed > 65535) {
          return { error: `--port must be a whole number from 0 to 65535, not ${raw}` };
        }
        port = parsed;
      } else if (arg === "--host") {
        if (command !== "dev") return { error: "--host is only valid for dev" };
        host = value();
      } else if (arg === "--workers") {
        if (command !== "build" && command !== "check") return { error: "--workers is only valid for build and check" };
        const raw = value();
        if (raw === "auto") {
          workers = Math.max(1, availableParallelism() - 1);
        } else {
          const parsed = Number(raw);
          if (!/^\d+$/.test(raw) || !Number.isInteger(parsed) || parsed < 1) {
            return { error: `--workers must be a whole number of at least 1, or auto, not ${raw}` };
          }
          workers = parsed;
        }
      } else if (arg === "--as-of") {
        if (command !== "build" && command !== "check" && command !== "watch") {
          return { error: "--as-of is only valid for build, check, and watch" };
        }
        const raw = value();
        // `today` is resolved at the edge of main, where the clock may be read; here only the shape is checked.
        const read = readAsOfFlag(raw, () => "0001-01-01");
        if (!read.ok) return { error: `--as-of ${read.message}` };
        asOf = raw;
      } else if (arg === "--update-urls") {
        if (command !== "build") return { error: "--update-urls is only valid for build" };
        updateUrls = true;
      } else if (arg === "--report") {
        if (command !== "build") return { error: "--report is only valid for build" };
        report = true;
      } else if (arg === "--diagnose") {
        if (command !== "build") return { error: "--diagnose is only valid for build" };
        diagnose = true;
      } else if (arg === "--update-blocks") {
        if (command !== "build") return { error: "--update-blocks is only valid for build" };
        updateBlocks = true;
      } else if (arg === "--base") {
        if (command !== "build") return { error: "--base is only valid for build" };
        basePath = value();
      } else if (arg === "--preview-canonical") {
        if (command !== "build") return { error: "--preview-canonical is only valid for build" };
        const raw = value().trim();
        if (!/^https?:\/\/\S+$/i.test(raw)) {
          return { error: `--preview-canonical must be an absolute http(s) URL, not ${raw}` };
        }
        previewCanonical = raw;
      } else if (arg === "--baseline") {
        if (command !== "build") return { error: "--baseline is only valid for build" };
        const raw = value().trim();
        if (raw === "") return { error: "--baseline needs a folder" };
        baseline = raw;
      } else if (arg === "--commit") {
        if (command !== "build") return { error: "--commit is only valid for build" };
        const raw = value().trim();
        if (raw === "") return { error: "--commit needs a value" };
        commit = raw;
      } else if (arg === "--topic") {
        if (command !== "pack") return { error: "--topic is only valid for pack" };
        const raw = value().trim();
        if (raw === "") return { error: "--topic needs a name" };
        topic = raw;
      } else if (arg === "--request") {
        if (command !== "pack") return { error: "--request is only valid for pack" };
        const next = rest[++i];        if (next === undefined || (next.startsWith("-") && next !== "-")) {
          return { error: "--request needs a file path or -" };
        }
        request = next;
      } else if (arg === "--task") {
        if (command !== "pack") return { error: "--task is only valid for pack" };
        task = value();
      } else if (arg === "--budget") {
        if (command !== "pack") return { error: "--budget is only valid for pack" };
        const raw = value();
        const parsed = Number(raw);
        if (!/^\d+$/.test(raw) || !Number.isSafeInteger(parsed) || parsed < 1) {
          return { error: `--budget must be a positive whole number of tokens, not ${raw}` };
        }
        budget = parsed;
      } else if (arg === "--agents") {
        if (command !== "check") return { error: "--agents is only valid for check" };
        agents = true;
      } else if (arg.startsWith("-")) {
        return { error: `unknown option: ${arg}` };
      } else if (root === undefined) {
        root = arg;
      } else {
        return { error: `unexpected argument: ${arg}` };
      }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  const dir = root ?? ".";
  if (baseline !== undefined && previewCanonical === undefined) {
    return { error: "--baseline is only valid with --preview-canonical" };
  }
  if (command === "build") {
    return {
      options: {
        command: "build",
        root: dir,
        out: out ?? "dist",
        ...(theme === undefined ? {} : { theme }),
        ...(workers === undefined ? {} : { workers }),
        ...(updateUrls ? { updateUrls: true } : {}),
        ...(report ? { report: true } : {}),
        ...(diagnose ? { diagnose: true } : {}),
        ...(updateBlocks ? { updateBlocks: true } : {}),
        ...(asOf === undefined ? {} : { asOf }),
        ...(basePath === undefined ? {} : { basePath }),
        ...(previewCanonical === undefined ? {} : { previewCanonical }),
        ...(baseline === undefined ? {} : { baseline }),
        ...(commit === undefined ? {} : { commit }),
      },
    };
  }
  if (command === "dev") {
    return {
      options: {
        command: "dev",
        root: dir,
        ...(out === undefined ? {} : { out }),
        port,
        host,
        ...(theme === undefined ? {} : { theme }),
      },
    };
  }
  if (command === "pack") {
    if (request !== undefined && topic !== undefined) {
      return { error: "--request and --topic cannot be used together: a request names its own task" };
    }
    if (task !== undefined && request !== undefined) {
      return { error: "--task and --request cannot be used together: each names its own task" };
    }
    if (task !== undefined && topic !== undefined) {
      return { error: "--task and --topic cannot be used together: a task names its own evidence" };
    }
    if (request !== undefined && budget !== undefined) {
      return { error: "--request and --budget cannot be used together: the request carries its own budget" };
    }
    return {
      options: {
        command: "pack",
        root: dir,
        ...(topic === undefined ? {} : { topic }),
        ...(budget === undefined ? {} : { budget }),
        ...(request === undefined ? {} : { request }),
        ...(task === undefined ? {} : { task }),
        ...(packFormat === undefined ? {} : { format: packFormat }),
        ...(out === undefined ? {} : { out }),
      },
    };
  }
  if (command === "verify") {
    return {
      options: {
        command: "verify",
        root: dir,
        ...(hash === undefined ? {} : { hash }),
      },
    };
  }
  if (command === "watch") {
    return {
      options: {
        command: "watch",
        root: dir,
        ...(out === undefined ? {} : { out }),
        ...(theme === undefined ? {} : { theme }),
        ...(asOf === undefined ? {} : { asOf }),
      },
    };
  }
  if (command === "doctor") {
    return {
      options: {
        command: "doctor",
        root: dir,
        format,
        ...(theme === undefined ? {} : { theme }),
      },
    };
  }
  return {
    options: {
      command: "check",
      root: dir,
      format,
      ...(theme === undefined ? {} : { theme }),
      ...(workers === undefined ? {} : { workers }),
      ...(asOf === undefined ? {} : { asOf }),
      ...(agents ? { agents: true } : {}),
    },
  };
}

function printDiagnostics(
  diagnostics: Parameters<typeof formatText>[0],
  format: Format,
  log: (message: string) => void,
): void {
  if (format === "json") log(formatJson(diagnostics).replace(/\n$/, ""));
  else if (format === "sarif") {
    log(
      formatSarif(diagnostics, {
        tool: { name: NAME, version },
      }).replace(/\n$/, ""),
    );
  } else log(formatText(diagnostics).replace(/\n$/, ""));
}

/** Runs the CLI. Returns the exit code. */
export async function main(args: readonly string[], io: Io = {}): Promise<number> {
  const log = io.log ?? console.log;
  const error = io.error ?? console.error;
  const write = io.write ?? ((text: string): void => void process.stdout.write(text));

  const parsed = parseArgs(args);
  if ("help" in parsed) {
    log(usage);
    return 0;
  }
  if ("error" in parsed) {
    error(`${NAME}: ${parsed.error}\n\n${usage}`);
    return 2;
  }

  const { options } = parsed;

  // `--as-of today` is the only place the clock is read: once, here, printed, and passed on as a plain date.
  let asOf: string | undefined;
  if ((options.command === "build" || options.command === "check" || options.command === "watch" || options.command === "data-quality") && options.asOf !== undefined) {
    const read = readAsOfFlag(options.asOf, () => todayOf((io.now ?? (() => new Date()))()));
    if (!read.ok) {
      error(`${NAME}: --as-of ${read.message}`);
      return 2;
    }
    asOf = read.date;
    if (read.today) error(`${NAME}: as-of date ${asOf} (today)`);
  }

  if (options.command === "readiness") {
    return await readinessCommand(options, { log, error });
  }

  if (options.command === "mcp") {
    try {
      const root = resolve(options.root);
      if (options.printConfig !== undefined && isClient(options.printConfig)) {
        write(clientConfig(options.printConfig, options.root, options.allowEdits));
        return 0;
      }
      const themeRoot = await resolveThemeRoot(root, options.theme);
      if (themeRoot === undefined) {
        error(`${NAME}: no theme found; set theme.name in the config or pass --theme`);
        return 2;
      }
      const loaded = options.policy === undefined ? undefined : await readAccessPolicyFile(options.policy);
      if (loaded !== undefined && loaded.policy === undefined) {
        for (const problem of loaded.problems) error(`${NAME}: ${problem}`);
        return 2;
      }
      return await serveMcp(
        {
          root,
          themeRoot,
          allowEdits: options.allowEdits,
          version,
          defaultLayout: DEFAULT_LAYOUT,
          ...(loaded?.policy === undefined ? {} : { access: loaded.policy }),
        },
        (message) => process.stderr.write(`${message}\n`),
      );
    } catch (err) {
      error(`${NAME}: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }

  if (options.command === "stale") {
    try {
      return await runStale(options.args, { log, error });
    } catch (err) {
      error(`${NAME}: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }

  if (options.command === "references") {
    try {
      return await runReferences(options.args, { write, error });
    } catch (err) {
      error(`${NAME}: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }

  if (options.command === "trace") {
    try {
      return await runTrace(options.args, { write, error });
    } catch (err) {
      error(`${NAME}: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }

  if (options.command === "eval") {
    return runEval(options.args, { write, error });
  }

  if (options.command === "agent") {
    try {
      return await runAgent(options.args, { log, write, error, ...(io.readStdin === undefined ? {} : { readStdin: io.readStdin }) });
    } catch (err) {
      error(`${NAME}: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }

  if (options.command === "graph") {
    try {
      return await runGraph(options.args, { log, error });
    } catch (err) {
      error(`${NAME}: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }

  if (options.command === "knowledge") {
    try {
      return await runKnowledge(options.args, { log, error });
    } catch (err) {
      error(`${NAME}: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }

  if (options.command === "decisions") {
    try {
      return await runDecisions(options.args, { log, error });
    } catch (err) {
      error(`${NAME}: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }

  if (options.command === "versions") {
    try {
      return await runDocsVersion(options.args, { log, error });
    } catch (err) {
      error(`${NAME}: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }

  if (options.command === "surface") {
    try {
      return await runSurface(options.args, { log, error });
    } catch (err) {
      error(`${NAME}: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }

  if (options.command === "behavior") {
    try {
      return await runBehavior(options.args, { log, error });
    } catch (err) {
      error(`${NAME}: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }

  if (options.command === "author") {
    try {
      return await runAuthor(options.args, { log, error });
    } catch (err) {
      error(`${NAME}: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }

  if (options.command === "federation") {
    try {
      return await runFederation(options.args, { log, error });
    } catch (err) {
      error(`${NAME}: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }

  if (options.command === "evidence") return runEvidence(options.args, { log, error });

  if (options.command === "network") {
    try {
      return await runNetwork(options.args, { log, error });
    } catch (err) {
      error(`${NAME}: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }

  if (options.command === "examples") {
    try {
      return await runExamplesRecord(options.args, { log, error });
    } catch (err) {
      error(`${NAME}: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }

  if (options.command === "published-site") {
    try {
      const subcommand = options.args[0];
      if (subcommand === "attest" || subcommand === "verify") {
        return await runSiteAttestation(options.args, { log, error });
      }
      return await runPublishedSite(options.args, { log, error });
    } catch (err) {
      error(`${NAME}: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }

  if (options.command === "inputs") {
    try {
      return await runInputs(options.args, { log, error });
    } catch (err) {
      error(`${NAME}: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }

  if (options.command === "init") {
    try {
      const target = resolve(options.root);
      const themeRoot = await resolveThemeRoot(target, options.theme);
      const result = await init({
        themeRoot,
        target,
        list: options.list,
        ...(options.starter === undefined ? {} : { starter: options.starter }),
        ...(options.langs === undefined ? {} : { langs: options.langs }),
      });
      for (const message of result.messages) log(message);
      for (const message of result.errors) error(`${NAME}: ${message}`);
      return result.code;
    } catch (err) {
      error(`${NAME}: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }

  if (options.command === "import") {
    try {
      return await runImport(options.name, options.root, { log, error }, options.out, {
        ...(options.failOnManual === undefined ? {} : { failOnManual: options.failOnManual }),
        ...(options.allow === undefined ? {} : { allow: options.allow }),
      });
    } catch (err) {
      error(`${NAME}: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }

  if (options.command === "urls") {
    try {
      const model = await buildModel(resolve(options.root));
      const report = urlsReport(model.urls, options.format, model.diagnostics);
      write(report.output);
      for (const finding of model.diagnostics) {
        if (finding.severity === "error") error(`${finding.id}: ${finding.message}`);
      }
      return report.code;
    } catch (err) {
      error(`${NAME}: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }

  if (options.command === "api-check") {
    try {
      const themeRoot = await resolveThemeRoot(resolve(options.root), options.theme);
      if (themeRoot === undefined) {
        error(`${NAME}: no theme found; set theme.name in the config or pass --theme`);
        return 2;
      }
      return await apiCheck({ root: options.root, against: options.against, themeRoot, defaultLayout: DEFAULT_LAYOUT }, { write, error });
    } catch (err) {
      error(`${NAME}: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }

  if (options.command === "diff") {
    let themeRoot: string | undefined;
    if (options.base !== undefined) {
      try {
        themeRoot = await resolveThemeRoot(resolve(options.dirs[0] ?? "."), options.theme);
      } catch (err) {
        error(`${NAME}: ${err instanceof Error ? err.message : String(err)}`);
        return 2;
      }
    }
    return diffCommand(
      {
        dirs: options.dirs,
        format: options.format,
        failOn: options.failOn,
        ...(options.changeTypes === undefined ? {} : { changeTypes: options.changeTypes }),
        defaultLayout: DEFAULT_LAYOUT,
        ...(options.base === undefined ? {} : { base: options.base }),
        ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
        ...(options.linkBase === undefined ? {} : { linkBase: options.linkBase }),
        ...(themeRoot === undefined ? {} : { themeRoot }),
      },
      { write, error },
    );
  }

  if (options.command === "verify") {
    try {
      const result = await verify({
        dir: options.root,
        ...(options.hash === undefined ? {} : { hash: options.hash }),
      });
      if (result.ok) {
        log(verifyMessage(result));
        return 0;
      }
      error(`${NAME}: ${verifyMessage(result)}`);
      return 1;
    } catch (err) {
      error(`${NAME}: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }

  if (options.command === "pack") {
    try {
      return await pack(
        {
          root: resolve(options.root),
          ...(options.topic === undefined ? {} : { topic: options.topic }),
          ...(options.budget === undefined ? {} : { budget: options.budget }),
          ...(options.request === undefined
            ? {}
            : { request: options.request === "-" ? "-" : resolve(options.request) }),
          ...(options.task === undefined ? {} : { task: resolve(options.task) }),
          ...(options.format === undefined ? {} : { format: options.format }),
          ...(options.out === undefined ? {} : { out: resolve(options.out) }),
        },
        { write, error, ...(io.readStdin === undefined ? {} : { readStdin: io.readStdin }) },
      );
    } catch (err) {
      error(`${NAME}: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }

  if (options.command === "edit-apply") {
    const loaded = options.policy === undefined ? undefined : await readAccessPolicyFile(options.policy);
    if (loaded !== undefined && loaded.policy === undefined) {
      for (const problem of loaded.problems) error(`${NAME}: ${problem}`);
      return 2;
    }
    try {
      const result = await editApply({
        siteRoot: options.root,
        patch: options.patch,
        ...(options.proof === undefined ? {} : { proof: options.proof }),
        ...(options.dryRun ? { dryRun: true } : {}),
        ...(options.allowUnchecked === true ? { allowUnchecked: true } : {}),
        ...(loaded?.policy === undefined ? {} : { access: loaded.policy }),
      });
      await traceEditApply(result, options.root);
      if (options.format === "json") {
        log(formatEditApplyJson(result, 0).replace(/\n$/, ""));
        return 0;
      }
      if (result.dryRun) {
        if (result.diff !== undefined) log(result.diff.replace(/\n$/, ""));
        log(`${NAME} edit apply: dry run: ${result.file} would change; nothing was written`);
        return 0;
      }
      log(`${NAME} edit apply: wrote ${result.file}`);
      log(`${NAME} edit apply: proof ${result.proof ?? ""}`);
      return 0;
    } catch (err) {
      if (err instanceof EditApplyError) {
        const exitCode = err.usage ? 2 : 1;
        if (options.format === "json") log(formatEditApplyJson(err, exitCode).replace(/\n$/, ""));
        else error(`${NAME}: ${err.message}`);
        return exitCode;
      }
      error(`${NAME}: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }

  if (options.command === "edit-transaction") {
    const loaded = options.policy === undefined ? undefined : await readAccessPolicyFile(options.policy);
    if (loaded !== undefined && loaded.policy === undefined) {
      for (const problem of loaded.problems) error(`${NAME}: ${problem}`);
      return 2;
    }
    try {
      const result = await editTransactionCommand({
        transaction: options.transaction,
        siteRoot: options.root,
        ...(options.dryRun ? { dryRun: true } : {}),
        ...(options.rebase ? { rebase: true } : {}),
        ...(options.approve ? { approve: true } : {}),
        ...(options.receipt === undefined ? {} : { receipt: options.receipt }),
        ...(options.proof === undefined ? {} : { proof: options.proof }),
        ...(options.audit === undefined ? {} : { audit: options.audit }),
        ...(loaded?.policy === undefined ? {} : { access: loaded.policy }),
        format: options.format,
      });
      if (options.format === "json") {
        log(formatEditTransactionJson(result, 0).replace(/\n$/, ""));
        return 0;
      }
      if (result.dryRun) {
        if (result.diff !== undefined) log(result.diff.replace(/\n$/, ""));
        for (const check of result.checks) {
          const detail = check.message === undefined ? "" : `: ${check.message}`;
          log(`${NAME} edit transaction: ${check.id} ${check.status}${detail}`);
        }
        log(`${NAME} edit transaction: dry run: ${result.files.length} file(s) would change; nothing was written`);
        return 0;
      }
      for (const file of result.files) {
        log(`${NAME} edit transaction: wrote ${file.file} ${file.beforeHash.slice(0, 12)} -> ${file.afterHash.slice(0, 12)}`);
      }
      if (result.proof !== undefined) log(`${NAME} edit transaction: proof ${result.proof}`);
      if (result.receipt !== undefined) log(`${NAME} edit transaction: receipt ${result.receipt}`);
      return 0;
    } catch (err) {
      if (err instanceof EditTransactionError) {
        const exitCode = err.usage ? 2 : 1;
        if (options.format === "json") log(formatEditTransactionJson(err, exitCode).replace(/\n$/, ""));
        else {
          error(`${NAME}: ${err.message}`);
          for (const line of conflictLines(err.conflicts)) error(`${NAME}: ${line}`);
        }
        return exitCode;
      }
      error(`${NAME}: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }

  if (options.command === "edit-rollback") {
    try {
      const { report } = await editRollbackCommand({
        receipt: options.receipt,
        siteRoot: options.root,
        format: options.format,
      });
      if (options.format === "json") {
        log(formatEditRollbackJson(report, 0).replace(/\n$/, ""));
        return 0;
      }
      for (const file of report.restored) log(`${NAME} edit rollback: restored ${file}`);
      for (const file of report.preserved) log(`${NAME} edit rollback: preserved ${file}`);
      return 0;
    } catch (err) {
      if (err instanceof EditTransactionError) {
        const exitCode = err.usage ? 2 : 1;
        if (options.format === "json") log(formatEditRollbackJson(err, exitCode).replace(/\n$/, ""));
        else error(`${NAME}: ${err.message}`);
        return exitCode;
      }
      error(`${NAME}: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }

  if (options.command === "edit-verify") {
    const result = await verifyProof({
      proof: options.proof,
      siteRoot: options.site,
      doctor: options.doctor,
      ...(options.input === undefined ? {} : { input: options.input }),
    });
    await traceVerification(result);
    const exitCode = result.ok
      ? 0
      : result.failure?.kind === "proof" || result.failure?.kind === "doctor-unavailable" || result.failure?.kind === "input"
        ? 2
        : 1;
    if (options.format === "json") {
      log(formatVerifyProofJson(result, exitCode).replace(/\n$/, ""));
      return exitCode;
    }
    if (result.ok) log(verifyProofMessage(result));
    else error(`${NAME}: ${verifyProofMessage(result)}`);
    return exitCode;
  }

  if (options.command === "compare") {
    try {
      const result = await compareReports({ before: options.before, after: options.after, format: options.format });
      if (result.output !== "") write(result.output);
      for (const problem of result.problems) error(`${NAME}: ${problem}`);
      return result.code;
    } catch (err) {
      error(`${NAME}: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }

  const root = resolve(options.root);
  if (options.command === "data-extract") {
    try {
      const result = await dataExtract({ root, ...(options.check ? { check: true } : {}) });
      for (const message of result.messages) log(message);
      for (const message of result.errors) error(`${NAME}: ${message}`);
      return result.code;
    } catch (err) {
      error(`${NAME}: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }

  if (options.command === "data-fetch") {
    try {
      const result = await dataFetch({ root, ...(options.check ? { check: true } : {}) });
      for (const message of result.messages) log(message);
      for (const message of result.errors) error(`${NAME}: ${message}`);
      return result.code;
    } catch (err) {
      error(`${NAME}: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }

  if (options.command === "data-refresh") {
    try {
      const result = await dataRefresh({
        root,
        report: resolve(options.report),
        ...(options.collections === undefined ? {} : { collections: options.collections }),
      });
      if (options.json) write(JSON.stringify(result.report, null, 2));
      else for (const message of result.messages) log(message);
      for (const message of result.errors) error(`${NAME}: ${message}`);
      return result.code;
    } catch (err) {
      error(`${NAME}: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }

  if (options.command === "data-verify") {
    try {
      const result = await verifyData({ root });
      for (const message of result.messages) log(message);
      for (const message of result.errors) error(`${NAME}: ${message}`);
      return result.code;
    } catch (err) {
      error(`${NAME}: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }

  if (options.command === "data-changes") {
    try {
      const result = await dataChanges({
        root,
        ...(options.name === undefined ? {} : { name: options.name }),
        write: options.write,
        ...(options.from === undefined ? {} : { from: options.from }),
      });
      for (const message of result.messages) log(message);
      for (const message of result.errors) error(`${NAME}: ${message}`);
      if (result.code === 0 && options.check && result.pending.length > 0) {
        for (const item of result.pending) error(`${NAME}: pending ${item.collection}: ${item.event.type} ${item.summary}`);
        error(`${NAME}: data changed without a history entry; run \`${NAME} data changes --write\``);
        return 1;
      }
      return result.code;
    } catch (err) {
      error(`${NAME}: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }

  if (options.command === "data-snapshot") {
    try {
      const result = await dataSnapshot({ root, name: options.name, ...(options.allowDirty ? { allowDirty: true } : {}) });
      for (const message of result.messages) log(message);
      for (const message of result.errors) error(`${NAME}: ${message}`);
      return result.code;
    } catch (err) {
      error(`${NAME}: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }

  if (options.command === "data-schema") {
    try {
      const result = await dataSchema({ root, format: options.format });
      write(result.output);
      for (const message of result.errors) error(`${NAME}: ${message}`);
      return result.code;
    } catch (err) {
      error(`${NAME}: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }

  if (options.command === "data-migrate") {
    try {
      const result = await dataMigrate({ root, ...(options.name === undefined ? {} : { name: options.name }) });
      write(result.output);
      for (const message of result.errors) error(`${NAME}: ${message}`);
      return result.code;
    } catch (err) {
      error(`${NAME}: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }

  if (options.command === "data-transform-diff") {
    try {
      const result = await diffRuleVersions({
        root,
        baseline: options.baseline,
        proposed: options.proposed,
        ...(options.collection === undefined ? {} : { collection: options.collection }),
        format: options.format,
        check: options.check,
      });
      if (result.output !== "") write(result.output);
      for (const message of result.errors) error(`${NAME}: ${message}`);
      return result.code;
    } catch (err) {
      error(`${NAME}: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }

  if (options.command === "data-explain") {
    try {
      const result = await dataExplain({
        root,
        collection: options.collection,
        id: options.id,
        field: options.field,
        json: options.json,
        public: options.public,
      });
      if (result.output !== "") write(result.output);
      for (const message of result.errors) error(`${NAME}: ${message}`);
      return result.code;
    } catch (err) {
      error(`${NAME}: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }

  if (options.command === "data-transform") {
    try {
      const result = await dataTransform({
        root,
        ...(options.name === undefined ? {} : { name: options.name }),
        ...(options.limit === undefined ? {} : { limit: options.limit }),
        json: options.json,
      });
      write(result.output);
      for (const message of result.errors) error(`${NAME}: ${message}`);
      return result.code;
    } catch (err) {
      error(`${NAME}: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }

  if (options.command === "data-quality") {
    try {
      const { config: loaded, diagnostics: configDiagnostics } = loadConfig(root);
      const config = asOf === undefined ? loaded : { ...loaded, asOf };
      const configFailed = configDiagnostics.some((finding) => finding.severity === "error");
      const report = await checkQuality({ root, config, write: options.write === true && !configFailed });
      const diagnostics = [...configDiagnostics, ...report.diagnostics];
      if (options.json) {
        log(JSON.stringify({ findings: report.findings, exceptions: report.exceptions, scopes: report.scopes, groups: report.groups, totals: report.totals, diagnostics, ...(report.wrote === undefined ? {} : { wrote: report.wrote }) }, null, 2));
      } else {
        if (report.wrote !== undefined) log(`wrote ${report.wrote}`);
        for (const finding of report.findings) log(`${finding.severity} ${finding.id}: ${finding.message}`);
        for (const diagnostic of diagnostics) error(`${NAME}: ${diagnostic.id}: ${diagnostic.message}`);
      }
      const failed = diagnostics.some((d) => d.severity === "error") ||
        report.findings.some((finding) => finding.severity === "error");
      return failed ? 1 : 0;
    } catch (err) {
      error(`${NAME}: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }

  if (options.command === "doctor") {
    try {
      const themeRoot = await resolveThemeRoot(root, options.theme);
      const diagnostics = [
        ...(await doctor({
          root,
          defaultLayout: DEFAULT_LAYOUT,
          today: new Date().toISOString().slice(0, 10),
          ...(themeRoot === undefined ? {} : { themeRoot }),
        })),
        ...(await staleDiagnostics(root)),
      ];
      printDiagnostics(diagnostics, options.format, log);
      return diagnostics.some((d) => d.severity === "error") ? 1 : 0;
    } catch (err) {
      error(`${NAME}: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }

  const themeRoot = await resolveThemeRoot(root, options.theme);
  if (themeRoot === undefined) {
    error(
      `${NAME}: no theme root. Pass --theme <dir>, or set theme.name in the site config to a folder or package.\n\n${usage}`,
    );
    return 2;
  }

  if (options.command === "reproduce") {
    try {
      const result = await reproduce({
        manifest: options.manifest,
        root,
        out: resolve(options.out),
        themeRoot,
        check: options.check,
        format: options.format,
      });
      if (result.output !== "") write(result.output);
      for (const problem of result.problems) error(`${NAME}: ${problem}`);
      return result.code;
    } catch (err) {
      error(`${NAME}: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }

  if (options.command === "dev") {
    // A default --out stays inside the site (and hidden, so discovery skips it); an explicit one is from the cwd.
    const out = options.out === undefined ? join(root, DEFAULT_DEV_OUT) : resolve(options.out);
    try {
      const server = await dev({
        root,
        out,
        themeRoot,
        defaultLayout: DEFAULT_LAYOUT,
        port: options.port,
        host: options.host,
        log,
      });
      log(`mizzen dev: serving ${server.url}`);
      const stop = (): void => {
        void server.close();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      try {
        await server.closed;
      } finally {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
      }
      return 0;
    } catch (err) {
      error(`${NAME}: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }

  if (options.command === "watch") {
    // A default --out stays inside the site (and hidden, so discovery skips it); an explicit one is from the cwd.
    const out = options.out === undefined ? join(root, DEFAULT_WATCH_OUT) : resolve(options.out);
    try {
      const watcher = await watchSite({
        root,
        out,
        themeRoot,
        defaultLayout: DEFAULT_LAYOUT,
        cache: true,
        ...(asOf === undefined ? {} : { asOf }),
        log,
      });
      log(`mizzen watch: watching ${root} and ${themeRoot}; press Ctrl-C to stop`);
      // SIGINT is process-level; stopping twice is safe, so a second signal while a build is in flight still exits.
      const stop = (): void => {
        void watcher.stop();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      try {
        await watcher.closed;
      } finally {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
      }
      return 0;
    } catch (err) {
      error(`${NAME}: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }

  if (options.command === "build") {
    // --out is resolved from the current working directory, not the site root.
    const out = resolve(options.out);
    try {
      // CI sets GITHUB_SHA; the flag wins over it. A preview with neither records no commit.
      const envCommit = process.env.GITHUB_SHA?.trim();
      const commit = options.commit ?? (envCommit === undefined || envCommit === "" ? undefined : envCommit);
      const result = await build({
        root,
        out,
        themeRoot,
        defaultLayout: DEFAULT_LAYOUT,
        cache: true,
        ...(options.workers === undefined ? {} : { workers: options.workers }),
        ...(options.updateUrls === true ? { updateUrls: true } : {}),
        ...(options.report === true ? { report: true } : {}),
        ...(options.updateBlocks === true ? { updateBlocks: true } : {}),
        ...(asOf === undefined ? {} : { asOf }),
        ...(options.basePath === undefined ? {} : { basePath: options.basePath }),
        ...(options.baseline === undefined ? {} : { baseline: resolve(options.baseline) }),
        ...(options.previewCanonical === undefined
          ? {}
          : { preview: { canonicalBase: options.previewCanonical, ...(commit === undefined ? {} : { commit }) } }),
      });
      if (result.report !== undefined) write(result.report);
      if (options.diagnose === true) {
        const report = await buildReportOf({
          root,
          out,
          themeRoot,
          ...(asOf === undefined ? {} : { asOf }),
          ...(options.basePath === undefined ? {} : { base: options.basePath }),
        });
        await writeBuildReport(join(root, BUILD_REPORT_PATH), report);
      }
      if (result.diagnostics.length > 0) printDiagnostics(result.diagnostics, "text", log);
      return result.diagnostics.some((d) => d.severity === "error") ? 1 : 0;
    } catch (err) {
      error(`${NAME}: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }

  const stagingParent = await mkdtemp(join(tmpdir(), "mizzen-check-"));
  const out = join(stagingParent, "out");
  try {
    const result = await build({
      root,
      out,
      themeRoot,
      defaultLayout: DEFAULT_LAYOUT,
      ...(options.workers === undefined ? {} : { workers: options.workers }),
      ...(asOf === undefined ? {} : { asOf }),
    });
    const diagnostics = [...result.diagnostics, ...(await staleDiagnostics(root))];
    printDiagnostics(diagnostics, options.format, log);
    if (options.agents) {
      const report = readinessReport(await scanBuild(out));
      log(options.format === "json" ? formatReadinessJson(report).replace(/\n$/, "") : formatReadiness(report).replace(/\n$/, ""));
      if (report.status === "fail") return 1;
    }
    return diagnostics.some((d) => d.severity === "error") ? 1 : 0;
  } catch (err) {
    error(`${NAME}: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  } finally {
    await rm(stagingParent, { recursive: true, force: true });
  }
}
