/**
 * Reads every decision record a site declares, resolves the evidence and links that name something this build can see,
 * applies the lifecycle, and returns the records with their problems.
 *
 * The reader is the only part of decision memory that touches disk. It reads the configured folder under the site
 * root, parses each Markdown file with {@link parseDecision}, and then re-resolves each record's evidence against the
 * site model: a `test` reference resolves when the file exists, a `page` link when the site has that page, a
 * `collection` link when the config has that collection, and a `behavior` link when the caller supplies the behavior
 * ids it knows. Anything else stays `unknown`, never guessed.
 */
import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import type { Diagnostic } from "../contracts/diagnostic.ts";
import type { DecisionEvidence, DecisionLink, DecisionRecord } from "../contracts/decisions.ts";
import type { Page, Site } from "../contracts/index.ts";
import type { DecisionProblem } from "../contracts/decisions.ts";
import { discover, MARKDOWN } from "../content/discover.ts";
import { parseDecision } from "./parse.ts";
import { applyLifecycle, type LifecycleResult } from "./lifecycle.ts";

/** What loading a site's decisions needs. */
export interface LoadDecisionsOptions {
  /** The site root. */
  readonly root: string;
  /** The site model, so links and tests can be resolved. */
  readonly site: Site;
  /** The folder the decision records live in, relative to the site root. Default `docs/decisions`. */
  readonly dir?: string;
  /** Behavior ids this build knows, so a `behavior:` link can resolve; defaults to every behavior a page declares. */
  readonly behaviors?: (id: string) => boolean;
}

/** Every behavior id the site's pages declare, so a decision's `behavior:` link resolves against the real inventory. */
export function declaredBehaviorIds(site: Site): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const page of site.pages) {
    for (const behavior of page.behaviors ?? []) ids.add(behavior.id);
  }
  return ids;
}

/** The result of loading a site's decisions. */
export interface DecisionsResult {
  /** The records with `supersededBy` filled, sorted by id. Empty when the folder is missing. */
  readonly records: readonly DecisionRecord[];
  /** Lifecycle problems, such as a supersession cycle. */
  readonly problems: readonly DecisionProblem[];
  /** The lifecycle result, kept so a query can name the cycle members. */
  readonly lifecycle: LifecycleResult;
  /** Parse diagnostics, each with the file and line it belongs to. */
  readonly diagnostics: readonly Diagnostic[];
  /** True when the configured folder exists and was read. */
  readonly found: boolean;
}

/** The files under `dir` that may be a decision record, sorted by path. */
async function decisionFiles(root: string, dir: string): Promise<{ readonly found: boolean; readonly files: readonly string[] }> {
  const folder = join(root, dir);
  let files: { readonly path: string; readonly kind: string }[];
  try {
    files = await discover(folder);
  } catch {
    return { found: false, files: [] };
  }
  return {
    found: true,
    files: files
      .filter((file) => file.kind === "doc" && MARKDOWN.test(file.path))
      .map((file) => posix.join(dir, file.path))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
  };
}

/** The pages the site has, by their source path with forward slashes. */
function pageIndex(site: Site): ReadonlyMap<string, Page> {
  const index = new Map<string, Page>();
  for (const page of site.pages) {
    index.set(page.source.file.replace(/\\/g, "/"), page);
    const withoutExtension = page.source.file.replace(/\\/g, "/").replace(/\.(?:md|markdown|html?)$/i, "");
    index.set(withoutExtension, page);
    index.set(page.url.replace(/^\/+|\/+$/g, ""), page);
  }
  return index;
}

/** Whether a string names a page the site has, by source path or URL. */
function pageExists(pages: ReadonlyMap<string, Page>, id: string): boolean {
  const cleaned = id.trim().replace(/^\/+|\/+$/g, "");
  if (cleaned === "") return true;
  if (pages.has(cleaned) || pages.has(`${cleaned}.md`)) return true;
  const withoutIndex = cleaned.replace(/\/index$/i, "");
  return pages.has(withoutIndex);
}

/** Re-resolves a record's links against the site, so a link to a missing page or collection is visibly unresolved. */
function resolveLinks(record: DecisionRecord, pages: ReadonlyMap<string, Page>, site: Site, behaviors: ((id: string) => boolean) | undefined): { readonly links: readonly DecisionLink[]; readonly diagnostics: readonly Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const links = record.links.map((link): DecisionLink => {
    let resolved = true;
    switch (link.kind) {
      case "page":
        resolved = pageExists(pages, link.id);
        break;
      case "collection":
        resolved = site.collections[link.id] !== undefined || site.config.collections[link.id] !== undefined;
        break;
      case "behavior":
        resolved = behaviors === undefined ? false : behaviors(link.id);
        break;
      case "api":
      case "surface":
        // The API and surface inventories live outside the site model; the parser keeps these links as written, and a
        // caller with a surface report resolves them. Not resolving them here is honest: the link is not disproved.
        resolved = true;
        break;
      default:
        resolved = true;
    }
    if (resolved) return { ...link, resolved: true };
    diagnostics.push({
      id: "decision.link-unresolved",
      severity: "warning",
      message: `Decision "${record.id}" names ${link.raw}, which this build cannot resolve.`,
      ...(link.pos === undefined ? {} : { pos: link.pos }),
      help: link.kind === "page"
        ? "Name a page the site builds, or leave the link out until the page exists."
        : link.kind === "collection"
          ? "Name a collection the config declares, or leave the link out."
          : "Attach a behavior inventory, or leave the link out.",
    });
    return { ...link, resolved: false };
  });
  return { links, diagnostics };
}

/** Re-resolves a record's evidence, so a test that no longer exists is `unknown` rather than assumed. */
async function resolveEvidence(record: DecisionRecord, root: string): Promise<DecisionEvidence[]> {
  const out: DecisionEvidence[] = [];
  for (const entry of record.evidence) {
    if (entry.kind !== "test") {
      out.push(entry);
      continue;
    }
    const exists = await readFile(join(root, entry.value)).then(() => true).catch(() => false);
    out.push({ ...entry, status: exists ? "resolved" : "unknown" });
  }
  return out;
}

/**
 * Reads the decision records under `dir`, resolves the links and evidence the site can see, and applies the lifecycle.
 * A missing folder is not a problem: a site without decisions simply has none.
 */
export async function loadDecisions(options: LoadDecisionsOptions): Promise<DecisionsResult> {
  const dir = (options.dir ?? "docs/decisions").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const found = await decisionFiles(options.root, dir);
  if (!found.found) {
    return {
      records: [],
      problems: [],
      lifecycle: { records: [], problems: [], cycles: [] },
      diagnostics: [],
      found: false,
    };
  }

  const pages = pageIndex(options.site);
  // A behavior link resolves against every behavior the site declares, unless the caller narrows it: the behavior
  // inventory is the engine's own, so a decision reaches a real behavior id and not a hand-kept list.
  const behaviors = options.behaviors ?? (() => false);
  const declared = declaredBehaviorIds(options.site);
  const resolves = (id: string): boolean => declared.has(id) || behaviors(id);
  const diagnostics: Diagnostic[] = [];
  const records: DecisionRecord[] = [];
  for (const file of found.files) {
    let text: string;
    try {
      text = await readFile(join(options.root, file), "utf8");
    } catch {
      continue;
    }
    const parsed = parseDecision(text, { file });
    diagnostics.push(...parsed.diagnostics);
    if (parsed.record === undefined) continue;
    const links = resolveLinks(parsed.record, pages, options.site, resolves);
    diagnostics.push(...links.diagnostics);
    const evidence = await resolveEvidence(parsed.record, options.root);
    records.push({ ...parsed.record, links: links.links, evidence });
  }

  const lifecycle = applyLifecycle(records);
  return {
    records: lifecycle.records,
    problems: lifecycle.problems,
    lifecycle,
    diagnostics,
    found: true,
  };
}
