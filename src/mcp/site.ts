/**
 * The site an MCP server answers about: built once into a temporary folder, rebuilt when a source file changed, and
 * read back through the files the build wrote (`sourcemap.json`, `trust.json`, the Markdown twins) and the site model.
 * Nothing here writes into the site.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Diagnostic, Page, Site } from "../contracts/index.ts";
import type { AccessPolicy, AccessResource } from "../contracts/permissions.ts";
import { readablePage } from "../permissions/read.ts";
import { readRule } from "../permissions/evaluate.ts";
import { loadConfig } from "../config/load.ts";
import { buildModel } from "../model/build.ts";
import { build } from "../pipeline/build.ts";
import { confine, McpError, toSitePath } from "./limits.ts";

/** One heading of a page, as `sourcemap.json` records it. */
export interface SectionEntry {
  readonly id: string;
  readonly level: number;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
  readonly text: string;
}

/** One document page: the model's page and what the build recorded about its source. */
export interface PageInfo {
  readonly page: Page;
  /** Source file, site-relative. */
  readonly source: string;
  readonly template?: string;
  readonly sections: readonly SectionEntry[];
  /** Trust level from `trust.json`, or `unknown`. */
  readonly trust: string;
}

/** Options of {@link SiteState.open}. */
export interface SiteOptions {
  readonly root: string;
  readonly themeRoot: string;
  readonly defaultLayout?: string;
  /** The access policy every tool call is held to; absent means public read only. */
  readonly access?: AccessPolicy;
}

/** Files and folders the fingerprint ignores: hidden ones (`.mizzen`, `.git`) and dependencies. */
const SKIPPED = (name: string): boolean => name.startsWith(".") || name === "node_modules";

async function fingerprint(root: string): Promise<string> {
  const hash = createHash("sha256");
  const walk = async (dir: string): Promise<void> => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      if (SKIPPED(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else {
        const info = await stat(path).catch(() => undefined);
        if (info !== undefined) hash.update(`${path}\0${info.size}\0${info.mtimeMs}\n`);
      }
    }
  };
  await walk(root);
  return hash.digest("hex");
}

export class SiteState {
  readonly root: string;
  readonly access: AccessPolicy | undefined;
  readonly #options: SiteOptions;
  #parent = "";
  #seq = 0;
  #print = "";
  #queue: Promise<unknown> = Promise.resolve();
  out = "";
  site!: Site;
  diagnostics: readonly Diagnostic[] = [];
  pages: readonly PageInfo[] = [];

  private constructor(options: SiteOptions, root: string) {
    this.#options = options;
    this.root = root;
    this.access = options.access;
  }

  /** Builds the site once and returns its state. */
  static async open(options: SiteOptions): Promise<SiteState> {
    const { realpath } = await import("node:fs/promises");
    const state = new SiteState(options, await realpath(options.root));
    state.#parent = await mkdtemp(join(tmpdir(), "mizzen-mcp-"));
    await state.#rebuild();
    return state;
  }

  /** Names of the collections the site declares. */
  get collections(): readonly string[] {
    return Object.keys(this.site.config.collections).sort();
  }

  /** Whether the policy allows reading one page; without a policy every page stays visible, as before. */
  readable(page: Page): boolean {
    return this.access === undefined || readablePage(this.access, page);
  }

  /** The page list a tool may read, in the same order. */
  get readablePages(): readonly PageInfo[] {
    return this.access === undefined ? this.pages : this.pages.filter((info) => readablePage(this.access!, info.page));
  }

  /** Whether the policy allows one collection's data; without a policy every collection stays visible. */
  readableCollection(name: string): boolean {
    if (this.access === undefined) return true;
    return readRule(this.access, { kind: "collection", id: name, collection: name }).allowed;
  }

  /** Whether the policy allows one record, by its collection audience and field policy. */
  readableRecord(collection: string, id: string, fields: Readonly<Record<string, unknown>>): boolean {
    if (this.access === undefined) return true;
    const resource: AccessResource = { kind: "record", id, collection };
    if (!readRule(this.access, resource).allowed) return false;
    const allowed = this.access.read.fields?.[collection];
    if (allowed === undefined) return true;
    return Object.keys(fields).every(
      (field) => readRule(this.access!, { kind: "field", id: field, collection, field }).allowed,
    );
  }

  /** The page a source file belongs to, when it is one this policy may read. */
  readableSource(file: string): boolean {
    if (this.access === undefined) return true;
    const info = this.pages.find((candidate) => candidate.source === file);
    return info === undefined || readablePage(this.access, info.page);
  }

  /** Rebuilds when a source file changed since the last build; returns whether it did. Builds never overlap. */
  refresh(force = false): Promise<boolean> {
    const run = this.#queue.then(async () => {
      const print = await fingerprint(this.root);
      if (!force && print === this.#print) return false;
      await this.#rebuild();
      return true;
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #rebuild(): Promise<void> {
    const print = await fingerprint(this.root);
    const out = join(this.#parent, `out-${this.#seq++}`);
    const result = await build({
      root: this.root,
      out,
      themeRoot: this.#options.themeRoot,
      defaultLayout: this.#options.defaultLayout ?? "doc",
    });
    const model = await buildModel(this.root);
    const previous = this.out;
    this.out = out;
    this.site = model.site;
    this.diagnostics = result.diagnostics;
    this.#print = print;
    this.pages = await this.#readPages();
    if (previous !== "") await rm(previous, { recursive: true, force: true });
  }

  async #readPages(): Promise<readonly PageInfo[]> {
    const map = JSON.parse(await readFile(join(this.out, "sourcemap.json"), "utf8")) as {
      pages: { url: string; source: string; template?: string; sections: SectionEntry[] }[];
    };
    const trust = await readFile(join(this.out, "trust.json"), "utf8")
      .then((text) => (JSON.parse(text) as { pages?: Record<string, { level?: string }> }).pages ?? {})
      .catch(() => ({}) as Record<string, { level?: string }>);
    const byUrl = new Map(this.site.pages.map((page) => [page.url, page] as const));
    const pages: PageInfo[] = [];
    for (const entry of map.pages) {
      const page = byUrl.get(entry.url);
      if (page === undefined) continue;
      pages.push({
        page,
        source: entry.source,
        ...(entry.template === undefined ? {} : { template: entry.template }),
        sections: entry.sections,
        trust: trust[entry.url]?.level ?? "unknown",
      });
    }
    return pages;
  }

  /** The page at `url` (with or without a trailing slash) or whose source is `path`. */
  find(ref: string): PageInfo | undefined {
    const wanted = ref.replace(/\\/g, "/");
    const withSlash = wanted.endsWith("/") || /\.[a-z0-9]+$/i.test(wanted) ? wanted : `${wanted}/`;
    return this.pages.find((p) => p.page.url === wanted || p.page.url === withSlash || p.source === wanted || p.template === wanted);
  }

  /** The text of a source file, confined to the site. */
  async readSource(file: string): Promise<string> {
    return readFile(await confine(this.root, file), "utf8");
  }

  /** The text of a file of the built site (a twin, `llms.txt`), confined to the build folder. */
  async readBuilt(file: string): Promise<string> {
    const path = await confine(this.out, file);
    return readFile(path, "utf8");
  }

  /** Folders that must never appear in an answer. */
  get privateFolders(): readonly string[] {
    return [this.root, this.#parent];
  }

  /** A site-relative display path for an absolute one. */
  relative(absolute: string): string {
    return toSitePath(this.root, absolute);
  }

  async close(): Promise<void> {
    await this.#queue.catch(() => undefined);
    await rm(this.#parent, { recursive: true, force: true });
  }
}

/** Throws a tool-readable error when the site has no page for `ref`. */
export function requirePage(site: SiteState, ref: string): PageInfo {
  const found = site.find(ref);
  if (found === undefined) throw new McpError("unknown-page", `No page matches "${ref}".`);
  return found;
}

/** Whether the config of the site at `root` declares collections, without building it. */
export function declaresCollections(root: string): readonly string[] {
  return Object.keys(loadConfig(root).config.collections).sort();
}
