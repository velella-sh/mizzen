/**
 * `mizzen federation <command> [dir]` reads and queries the federated knowledge of independent projects.
 *
 * - `fetch` reads the manifest and pins every project's bundle in `federation.lock.json`. It is the only subcommand
 *   that reads the network; a normal build reads only the lock and the local bundle bytes.
 * - `status` reports the manifest hash, every pinned bundle, and every project whose bundle is missing.
 * - `graph` composes the locked bundles into one graph and prints it.
 * - `query` answers one cross-repository query and returns fully qualified citations.
 * - `pack` compiles one context pack across projects under a single shared budget.
 * - `chain` traces an evidence chain from a claim to another project's test or data, preserving every digest.
 * - `resolve` resolves a stable reference to a pinned snapshot or a compatible channel.
 *
 * Every subcommand is offline except `fetch`; nothing reads the clock, and every list is sorted.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  FederatedGraph,
  FederatedQuery,
  FederatedReference,
  FederationConfig,
  KnowledgeBundle,
} from "../contracts/index.ts";
import { loadConfig } from "../config/load.ts";
import { traceEvidenceChain } from "../federation/chain.ts";
import { composeFederation } from "../federation/compose.ts";
import { byCodePoint } from "../federation/contract.ts";
import { fetchFederation } from "../federation/fetch.ts";
import { loadFederation, type FederationLoad } from "../federation/lock.ts";
import { compileFederationPack } from "../federation/pack.ts";
import { queryFederation } from "../federation/query.ts";
import { readReference, resolveReference } from "../federation/reference.ts";

/** Where the command prints. */
export interface FederationIo {
  readonly log: (message: string) => void;
  readonly error: (message: string) => void;
}

export const federationUsage = `Usage: mizzen federation <command> [dir] [options]

Commands:
  fetch [dir]              Fetch and pin every project's bundle in federation.lock.json (--check compares)
  status [dir]             Report the manifest hash, the pinned bundles, and every missing bundle (--json)
  graph [dir]              Print the composed graph over every visible project (--json)
  query [dir]              Answer one cross-repository query (--from <id>, --to <id>, --project <id>, --json)
  pack [dir]               Compile one context pack across projects (--goal <text>, --budget <tokens>, --from <ids>)
  chain [dir]              Trace a claim's evidence chain across projects (--claim <id>, --project <id>, --json)
  resolve [dir]            Resolve a stable reference to a pinned snapshot or a compatible channel (--reference <file>)

Options:
  --manifest <file>    Read this manifest instead of the config's (fetch only)
  --check              For fetch: read and verify without writing
  --json               Print the versioned JSON instead of text
  --from <ids>         For query: the starting citations, comma-separated; for pack: the pinned starts
  --to <id>            For query: the citation to reach, for the shortest path
  --project <id>       The project that qualifies a local id
  --depth <n>          For query: the longest path from --from (default 3, at most 32)
  --allow <a,b>        Audiences the caller may read; without it only public projects are visible
  --goal <text>        For pack: the topic the pack is about
  --budget <tokens>    For pack: the one shared budget
  --per-project <n>    For pack: the most fragments one project may contribute
  --claim <id>         For chain: the claim to start from
  --reference <file>   For resolve: a JSON file holding one stable reference
`;

/** The pieces every subcommand needs. */
interface Loaded {
  readonly federation: FederationConfig;
  readonly root: string;
  readonly loaded: FederationLoad;
}

/** The `federation` config key, or the reason it is absent. */
function federationOf(root: string): { readonly config?: FederationConfig; readonly problem?: string } {
  const { config, diagnostics } = loadConfig(root);
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) return { problem: errors.map((diagnostic) => `${diagnostic.id}: ${diagnostic.message}`).join("\n") };
  if (config.federation === undefined) {
    return { problem: "mizzen.yml has no `federation` key. Add `federation: { manifest, project }` first." };
  }
  return { config: config.federation };
}

/** Reads the lock and its bundles for the site at `root`. */
async function load(root: string): Promise<Loaded | { readonly problem: string }> {
  const configured = federationOf(root);
  if (configured.config === undefined) return { problem: configured.problem ?? "federation is not configured." };
  const loaded = await loadFederation(root);
  return { federation: configured.config, root, loaded };
}

/** The text a reader sees for one bundle. */
function bundleLine(project: string, bundle: KnowledgeBundle): string {
  return `  ${project} ${bundle.snapshot.version} (${bundle.snapshot.id}) ${bundle.role} ${bundle.digest.slice(0, 12)}`;
}

/** The graph as JSON, without the project-scoped data a caller does not need. */
function graphJson(graph: FederatedGraph): unknown {
  return {
    version: graph.version,
    digest: graph.digest,
    partial: graph.partial,
    projects: graph.projects,
    nodes: graph.nodes.map((node) => node.citation),
    edges: graph.edges,
    removed: graph.removed,
    missing: graph.missing,
  };
}

/** Parses the command's arguments into a subcommand and its options. */
interface Args {
  readonly command: string;
  readonly root: string;
  readonly json: boolean;
  readonly check: boolean;
  readonly manifest?: string;
  readonly from: readonly string[];
  readonly to?: string;
  readonly project?: string;
  readonly depth?: number;
  readonly allow?: readonly string[];
  readonly goal?: string;
  readonly budget?: number;
  readonly perProject?: number;
  readonly claim?: string;
  readonly reference?: string;
}

/** Parses the arguments, or returns the reason they are not one this command reads. */
function parseFederation(args: readonly string[]): Args | { readonly error: string } {
  const [command, ...rest] = args;
  if (command === undefined) return { error: "" };
  const known = ["fetch", "status", "graph", "query", "pack", "chain", "resolve"];
  if (!known.includes(command)) return { error: `unknown command: federation ${command}` };
  let root = ".";
  let json = false;
  let check = false;
  let manifest: string | undefined;
  let from: string[] = [];
  let to: string | undefined;
  let project: string | undefined;
  let depth: number | undefined;
  let allow: string[] | undefined;
  let goal: string | undefined;
  let budget: number | undefined;
  let perProject: number | undefined;
  let claim: string | undefined;
  let reference: string | undefined;
  const list = (value: string): string[] => value.split(",").map((item) => item.trim()).filter((item) => item !== "");
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (arg === "-h" || arg === "--help") return { error: "" };
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--check") {
      check = true;
      continue;
    }
    if (arg.startsWith("-")) {
      const next = rest[++index];
      if (next === undefined || next.startsWith("-")) return { error: `${arg} needs a value` };
      if (arg === "--manifest") manifest = next;
      else if (arg === "--from") from = list(next);
      else if (arg === "--to") to = next;
      else if (arg === "--project") project = next;
      else if (arg === "--allow") allow = list(next);
      else if (arg === "--goal") goal = next;
      else if (arg === "--claim") claim = next;
      else if (arg === "--reference") reference = next;
      else if (arg === "--depth" || arg === "--budget" || arg === "--per-project") {
        const value = Number(next);
        if (!Number.isInteger(value) || value < 0) return { error: `${arg} needs a whole number` };
        if (arg === "--depth") depth = value;
        else if (arg === "--budget") budget = value;
        else perProject = value;
      } else return { error: `unknown option: ${arg}` };
    } else if (root === ".") root = arg;
    else return { error: `unexpected argument: ${arg}` };
  }
  return {
    command,
    root,
    json,
    check,
    ...(manifest === undefined ? {} : { manifest }),
    from,
    ...(to === undefined ? {} : { to }),
    ...(project === undefined ? {} : { project }),
    ...(depth === undefined ? {} : { depth }),
    ...(allow === undefined ? {} : { allow }),
    ...(goal === undefined ? {} : { goal }),
    ...(budget === undefined ? {} : { budget }),
    ...(perProject === undefined ? {} : { perProject }),
    ...(claim === undefined ? {} : { claim }),
    ...(reference === undefined ? {} : { reference }),
  };
}

/** Runs one subcommand; returns the exit code. */
export async function runFederation(args: readonly string[], io: FederationIo): Promise<number> {
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    io.log(`${federationUsage.replace(/\n$/, "")}\n`);
    return 0;
  }
  const parsed = parseFederation(args);
  if ("error" in parsed) {
    if (parsed.error === "") {
      io.log(`${federationUsage.replace(/\n$/, "")}\n`);
      return 0;
    }
    io.error(`mizzen: ${parsed.error}\n\n${federationUsage}`);
    return 2;
  }
  const root = resolve(parsed.root);

  if (parsed.command === "fetch") {
    const configured = federationOf(root);
    if (configured.config === undefined) {
      io.error(`mizzen: ${configured.problem}`);
      return 2;
    }
    const manifest = parsed.manifest ?? configured.config.manifest;
    const result = await fetchFederation({ root, manifest, fetch: (url, init) => fetch(url, init), ...(parsed.check ? { check: true } : {}) });
    for (const line of result.lines) io.log(line);
    for (const problem of result.problems) io.error(`mizzen: ${problem.code}: ${problem.message}`);
    if (result.problems.length > 0) return 1;
    if (result.lines.length === 0) io.log("federation.lock.json is up to date");
    return 0;
  }

  const state = await load(root);
  if ("problem" in state) {
    io.error(`mizzen: ${state.problem}`);
    return 1;
  }
  const { loaded } = state.loaded;

  if (parsed.command === "status") {
    if (parsed.json) {
      io.log(
        JSON.stringify(
          {
            version: 1,
            manifest: loaded.lock?.manifest,
            partial: loaded.partial,
            fingerprint: loaded.fingerprint,
            bundles: [...loaded.bundles.values()].sort((a, b) => byCodePoint(a.project, b.project)).map((bundle) => ({
              project: bundle.project,
              namespace: bundle.namespace,
              role: bundle.role,
              snapshot: bundle.snapshot,
              digest: bundle.digest,
            })),
            missing: loaded.missing,
          },
          null,
          2,
        ),
      );
      return 0;
    }
    const lines = [`Federation: ${loaded.bundles.size} bundle${loaded.bundles.size === 1 ? "" : "s"}${loaded.partial ? " (partial)" : ""}`];
    if (loaded.lock !== undefined) lines.push(`  manifest ${loaded.lock.manifest.sha256.slice(0, 12)} from ${loaded.lock.manifest.source}`);
    for (const bundle of [...loaded.bundles.values()].sort((a, b) => byCodePoint(a.project, b.project))) lines.push(bundleLine(bundle.project, bundle));
    for (const entry of loaded.missing) lines.push(`  missing ${entry.project}${entry.optional ? " (optional)" : ""}: ${entry.reason}`);
    io.log(`${lines.join("\n")}\n`);
    return 0;
  }

  const graph = composeFederation(loaded, { ...(parsed.allow === undefined ? {} : { allow: parsed.allow }) });

  if (parsed.command === "graph") {
    io.log(`${JSON.stringify(graphJson(graph), null, 2)}\n`);
    return 0;
  }

  if (parsed.command === "query") {
    const query: FederatedQuery = {
      ...(parsed.from[0] === undefined ? {} : { from: parsed.from[0] }),
      ...(parsed.project === undefined ? {} : { project: parsed.project }),
      ...(parsed.to === undefined ? {} : { to: parsed.to }),
      ...(parsed.depth === undefined ? {} : { depth: parsed.depth }),
      ...(parsed.allow === undefined ? {} : { allow: parsed.allow }),
    };
    const result = queryFederation(graph, query);
    io.log(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  if (parsed.command === "pack") {
    if (parsed.goal === undefined) {
      io.error("mizzen: federation pack needs --goal");
      return 2;
    }
    if (parsed.budget === undefined) {
      io.error("mizzen: federation pack needs --budget");
      return 2;
    }
    const pack = compileFederationPack(loaded, {
      goal: parsed.goal,
      from: parsed.from,
      budget: parsed.budget,
      ...(parsed.project === undefined ? {} : { project: parsed.project }),
      ...(parsed.allow === undefined ? {} : { allow: parsed.allow }),
      ...(parsed.perProject === undefined ? {} : { perProject: parsed.perProject }),
    });
    io.log(parsed.json ? `${JSON.stringify({ ...pack, markdown: undefined }, null, 2)}\n` : pack.markdown);
    return 0;
  }

  if (parsed.command === "chain") {
    if (parsed.claim === undefined) {
      io.error("mizzen: federation chain needs --claim");
      return 2;
    }
    const chain = traceEvidenceChain(graph, loaded, parsed.claim, parsed.project);
    if (parsed.json) {
      io.log(`${JSON.stringify(chain, null, 2)}\n`);
    } else {
      const lines = [`Evidence chain from ${chain.claim.id}${chain.complete ? "" : " (incomplete)"}`];
      for (const link of chain.links) lines.push(`  ${link.from.id} -[${link.kind}]-> ${link.to.id} ${link.verified ? "verified" : "DIGEST MISMATCH"}`);
      for (const entry of chain.missing) lines.push(`  missing ${entry.project}: ${entry.reason}`);
      io.log(`${lines.join("\n")}\n`);
    }
    return chain.complete ? 0 : 1;
  }

  if (parsed.command === "resolve") {
    if (parsed.reference === undefined) {
      io.error("mizzen: federation resolve needs --reference");
      return 2;
    }
    let text: string;
    try {
      text = await readFile(resolve(parsed.reference), "utf8");
    } catch (error) {
      io.error(`mizzen: cannot read ${parsed.reference}: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
    const reference: FederatedReference | undefined = readReference(text);
    if (reference === undefined) {
      io.error(`mizzen: ${parsed.reference} is not a federation reference`);
      return 2;
    }
    const resolution = resolveReference(graph, loaded, reference);
    io.log(`${JSON.stringify(resolution, null, 2)}\n`);
    return resolution.status === "resolved" ? 0 : 1;
  }

  io.error(`mizzen: unknown command: federation ${parsed.command}`);
  return 2;
}
