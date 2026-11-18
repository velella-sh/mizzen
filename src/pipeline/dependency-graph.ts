/**
 * An explicit dependency graph over one site's content, so incremental work has one reliable invalidation unit.
 *
 * A node is a file the build reads (page, include, data, navigation, asset) or an output it derives from them. An
 * edge points from the dependent to what it depends on: a page to its includes, an include to its nested includes,
 * a page or include to a site asset its front matter or Markdown body names, and every page output to its page, the
 * navigation, and `_data`. One node exists per file, so a snippet that is also a page is one unit rather than two.
 *
 * The graph is a superset of the truth where the engine cannot narrow it: a layout may read any `_data` value, so
 * every output depends on every ordinary data file. A collection source is narrower: a page that shows a record has
 * an edge to that one file, including a package file and the stored bytes of a pinned URL. When a directive cannot be
 * resolved statically the graph is incomplete, and the invalidation plan asks for a full build instead of guessing.
 *
 * Sources are read through the existing `expandIncludes` and `parseFrontMatter`, so include rules (fences, nesting,
 * cycles) stay in one place. The graph is not wired into `build`; it is a standalone unit the integration issue uses.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { posix, relative, resolve, sep } from "node:path";
import type { Definition, Nodes, Root } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { discover, type DiscoveredFile } from "../content/discover.ts";
import { parseFrontMatter } from "../content/frontmatter.ts";
import { expandIncludes } from "../content/includes.ts";
import { unsafeIdReason } from "../api/ids.ts";
import { apiCollections, apiDir } from "../api/model.ts";
import { apiVersions } from "../api/versions.ts";
import type { Diagnostic, Page, Site, SourcePos } from "../contracts/index.ts";
import type { DataLock } from "../data/lock.ts";
import { LOCK_FILE, readLock, storedPath } from "../data/lock.ts";
import { URLS_LOCK_FILE } from "../data/urls-lock.ts";
import { resolveNpmSource } from "../data/package-source.ts";
import { feedIsWritten } from "../feeds/entries.ts";
import { feedFile } from "../feeds/files.ts";
import { sortDiagnostics } from "./diagnostics.ts";

/** What a node stands for. A file has one kind: its role in the build, with discovery's role winning. */
export type DependencyNodeKind = "page" | "include" | "data" | "navigation" | "asset" | "output" | "record" | "collection";

/** One unit of the build. */
export interface DependencyNode {
  /** Stable identity. A source file is `file:<source-relative path>`; a page output is `output:<url>`. */
  readonly id: string;
  /** What the unit is. */
  readonly kind: DependencyNodeKind;
  /** Path relative to the source folder for a file, relative to the site root for navigation, or the URL of an output. */
  readonly path: string;
  /** True when the build computes this node rather than reading it, such as navigation built from folders. */
  readonly derived?: boolean;
  /** True when a dependency names this file but it does not exist. Such a node has an error diagnostic. */
  readonly missing?: boolean;
  /**
   * What an output node is, beyond being an output: a paginated or expanded list page, a feed file, or an API file.
   * A page output leaves this unset. Only outputs carry it.
   */
  readonly role?: "list" | "feed" | "api";
  /** SHA-256 of a record's id and fields, so a change to one record is seen without comparing the file. Record nodes only. */
  readonly hash?: string;
}

/** One dependency: `from` does not build correctly unless `to` is current. */
export interface DependencyEdge {
  /** Id of the dependent node. */
  readonly from: string;
  /** Id of the dependency. */
  readonly to: string;
  /** Where the dependency is declared, when that is a source position. */
  readonly pos?: SourcePos;
}

/** The graph: nodes and edges, both sorted by their stable keys. */
export interface DependencyGraph {
  /** Every node, sorted by id. */
  readonly nodes: readonly DependencyNode[];
  /** Every edge, sorted by `from`, then `to`, then position; duplicate edges are collapsed. */
  readonly edges: readonly DependencyEdge[];
  /** Data directives the graph could not resolve; any of them makes a complete invalidation the only safe answer. */
  readonly incomplete?: readonly string[];
}

/** What {@link buildDependencyGraph} needs. */
export interface DependencyGraphOptions {
  /** The site root: the folder that holds `mizzen.yml`. */
  readonly root: string;
  /** The model built from `root`, read for pages, their URLs, the config, and the navigation path. */
  readonly site: Site;
  /** Files discovery found. Default: run discovery again on the source folder. */
  readonly files?: readonly DiscoveredFile[];
}

/** What {@link buildDependencyGraph} returns. */
export interface DependencyGraphResult {
  /** The graph, even when `diagnostics` holds errors. */
  readonly graph: DependencyGraph;
  /** Missing dependencies, cycles, and the include problems the expansion reported, sorted. */
  readonly diagnostics: readonly Diagnostic[];
}

/** Prefix of a source-file node id. */
const FILE = "file:";

/** Prefix of a page-output node id. */
const OUTPUT = "output:";

/** Id of the navigation node when there is no navigation file and the folders build it. */
const GENERATED_NAV = "navigation:generated";

/** Prefix of a navigation node id. It is not a source-relative file id, because the file lives under the site root. */
const NAVIGATION = "navigation:";

/** The id of the node for a source-relative file path. */
export function fileNodeId(path: string): string {
  return `${FILE}${normalize(path)}`;
}

/** The id of the node for a page output at `url`. */
export function outputNodeId(url: string): string {
  return `${OUTPUT}${url}`;
}

/** Prefix of a record node id. */
const RECORD = "record:";

/** Prefix of a collection node id: the set of one collection's records, which a list or an index reads as a whole. */
const COLLECTION = "collection:";

/** Prefix of the node for what shapes every page of one collection: its schema, its lock files, and its config entry. */
const COLLECTION_CONFIG = "collection-config:";

/** The id of the node a caller names when a collection's own config entry changed. */
export function collectionConfigNodeId(collection: string): string {
  return `${COLLECTION_CONFIG}${collection}`;
}

/** The id of the node for one record. */
export function recordNodeId(collection: string, id: string): string {
  return `${RECORD}${collection}/${id}`;
}

/** The id of the node for one collection as a whole. */
export function collectionNodeId(collection: string): string {
  return `${COLLECTION}${collection}`;
}

/** Key-sorted JSON, so two equal values hash alike whatever order their keys were built in. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * The hash of one record: its id and its fields. Positions are left out on purpose, so a record that only moved in
 * its file is not a changed record; a page that quotes the position has its own render key.
 */
export function recordHash(record: { readonly id: string; readonly fields: Readonly<Record<string, unknown>> }): string {
  return createHash("sha256").update(canonical({ id: record.id, fields: record.fields })).digest("hex");
}

/** Every record of the site by node id, with its hash. A record of a collection the config declares and a build read. */
export function recordHashes(site: Pick<Site, "collections">): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const [name, collection] of Object.entries(site.collections)) {
    for (const record of collection.records) hashes.set(recordNodeId(name, record.id), recordHash(record));
  }
  return hashes;
}

/** What changed between two sets of record hashes, each list sorted by node id. */
export interface RecordChanges {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

/**
 * Compares record hashes, not file hashes: editing one record of a file of a thousand reports that one node. Either side
 * may be a map from {@link recordHashes} or the record nodes of a graph.
 */
export function changedRecords(
  before: ReadonlyMap<string, string> | DependencyGraph,
  after: ReadonlyMap<string, string> | DependencyGraph,
): RecordChanges {
  const mapOf = (value: ReadonlyMap<string, string> | DependencyGraph): ReadonlyMap<string, string> => {
    if (value instanceof Map) return value;
    const map = new Map<string, string>();
    for (const node of (value as DependencyGraph).nodes) if (node.kind === "record" && node.hash !== undefined) map.set(node.id, node.hash);
    return map;
  };
  const a = mapOf(before);
  const b = mapOf(after);
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [id, hash] of b) {
    const old = a.get(id);
    if (old === undefined) added.push(id);
    else if (old !== hash) changed.push(id);
  }
  for (const id of a.keys()) if (!b.has(id)) removed.push(id);
  return { added: added.sort(byCodePoint), removed: removed.sort(byCodePoint), changed: changed.sort(byCodePoint) };
}

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A path as the source folder spells it: `/`-separated, with no leading `./`. */
function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
}

/** Orders two positions, with a missing position last. */
function comparePos(a: SourcePos | undefined, b: SourcePos | undefined): number {
  if (a === undefined) return b === undefined ? 0 : 1;
  if (b === undefined) return -1;
  return (
    byCodePoint(a.file, b.file) ||
    a.line - b.line ||
    a.column - b.column ||
    a.endLine - b.endLine ||
    a.endColumn - b.endColumn
  );
}

function compareNodes(a: DependencyNode, b: DependencyNode): number {
  return byCodePoint(a.id, b.id);
}

function compareEdges(a: DependencyEdge, b: DependencyEdge): number {
  return byCodePoint(a.from, b.from) || byCodePoint(a.to, b.to) || comparePos(a.pos, b.pos);
}

/** A key that makes duplicate edges collapse, including the position that explains each one. */
function edgeKey(edge: DependencyEdge): string {
  const pos = edge.pos;
  if (pos === undefined) return `${edge.from}\u0000${edge.to}`;
  return `${edge.from}\u0000${edge.to}\u0000${pos.file}\u0000${pos.line}\u0000${pos.column}\u0000${pos.endLine}\u0000${pos.endColumn}`;
}

function sortedEdges(edges: readonly DependencyEdge[]): DependencyEdge[] {
  const unique = new Map<string, DependencyEdge>();
  for (const edge of edges) if (!unique.has(edgeKey(edge))) unique.set(edgeKey(edge), edge);
  return [...unique.values()].sort(compareEdges);
}

/** The position at the start of a file, for a dependency whose span is not known. */
function atFile(file: string): SourcePos {
  return { file, line: 1, column: 1, endLine: 1, endColumn: 1 };
}

/**
 * A path with every `%`-escape decoded against the `/`-separated segment it sits in, so an encoded separator can
 * never become one. `undefined` when an escape is malformed or decodes to a separator or a NUL: such a reference
 * names no file, and guessing one would put a misleading node in the graph. A segment with no `%` is left exactly
 * as written, so a reference that was never encoded is unaffected.
 *
 * A caller must re-check confinement on the result, since a decoded segment can spell `..` that the written form
 * spelled as `%2e%2e`.
 */
function decodeSegments(value: string): string | undefined {
  if (!value.includes("%")) return value;
  const segments = value.split("/");
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!;
    if (!segment.includes("%")) continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return undefined;
    }
    if (decoded === "" || decoded.includes("/") || decoded.includes("\\") || decoded.includes("\0")) return undefined;
    segments[index] = decoded;
  }
  return segments.join("/");
}

/** A source-relative path named by a site-local URL such as `/media/logo.svg`, with `base` removed. */
function localPath(url: string, base: string): string | undefined {
  const clean = url.split(/[?#]/, 1)[0] ?? "";
  if (!clean.startsWith("/")) return undefined;
  if (base !== "" && clean !== base && !clean.startsWith(`${base}/`)) return undefined;
  const withoutBase = base !== "" ? clean.slice(base.length) : clean;
  const encoded = withoutBase.replace(/^\/+/, "");
  if (encoded === "") return undefined;
  const path = decodeSegments(encoded);
  if (path === undefined) return undefined;
  if (path.split("/").some((segment) => segment === "..")) return undefined;
  return path;
}

/** A scheme (`https:`, `mailto:`) or protocol-relative URL, which names no file in the source folder. */
const EXTERNAL = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i;

/**
 * The source-relative path an image URL names from `from`: a root URL goes through {@link localPath}, a relative
 * one resolves from the file that holds it. `undefined` for an external URL, one with a malformed escape, or one
 * that leaves the source folder. Escapes are decoded before the path is resolved, so the edge names the file the
 * built URL reaches, and the parent-segment check runs on the decoded path.
 */
function referencePath(url: string, base: string, from: string): string | undefined {
  if (url === "" || url.startsWith("#") || EXTERNAL.test(url)) return undefined;
  const clean = url.split(/[?#]/, 1)[0] ?? "";
  if (clean === "") return undefined;
  if (clean.startsWith("/")) return localPath(clean, base);
  const path = decodeSegments(clean);
  if (path === undefined || EXTERNAL.test(path)) return undefined;
  const resolved = posix.normalize(posix.join(posix.dirname(normalize(from)), path));
  if (resolved === "" || resolved === "." || resolved === ".." || resolved.startsWith("../")) return undefined;
  return resolved;
}

/** An image reference found in a Markdown body: its URL and where it starts. */
interface AssetReference {
  readonly url: string;
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
}

/** True when a Markdown body is worth parsing for image references. */
const MAY_HAVE_IMAGE = /!\[/;

function walkMdast(node: Nodes, visit: (node: Nodes) => void): void {
  visit(node);
  if ("children" in node) for (const child of node.children) walkMdast(child, visit);
}

/**
 * Every image reference in one Markdown body, with the line and column where it starts (1-based within `body`).
 * Reference-style images resolve through their definitions, and unused definitions are ignored.
 */
function assetReferencesOf(body: string): AssetReference[] {
  if (!MAY_HAVE_IMAGE.test(body)) return [];
  const tree = unified().use(remarkParse).parse(body) as Root;
  const definitions = new Map<string, Definition>();
  walkMdast(tree, (node) => {
    if (node.type === "definition") definitions.set(node.identifier, node);
  });

  const found: AssetReference[] = [];
  const add = (url: string, at: Nodes["position"]): void => {
    if (url === "" || url.startsWith("#") || EXTERNAL.test(url)) return;
    const start = at?.start;
    const end = at?.end;
    if (start === undefined || end === undefined) return;
    found.push({ url, line: start.line, column: start.column, endLine: end.line, endColumn: end.column });
  };
  walkMdast(tree, (node) => {
    if (node.type === "image") add(node.url, node.position);
    else if (node.type === "imageReference") {
      const definition = definitions.get(node.identifier);
      if (definition !== undefined) add(definition.url, node.position);
    }
  });
  return found;
}

/** The source path of the page whose source file is `page.source.file`; the longest matching discovery path wins. */
function sourcePathOf(file: string, paths: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const path of paths) {
    if (file === path || file.endsWith(`/${path}`)) {
      if (best === undefined || path.length > best.length) best = path;
    }
  }
  return best;
}

/** Rotates a cycle so it starts at its smallest id, which makes one cycle one key. */
function rotate(cycle: readonly string[]): string[] {
  let first = 0;
  for (let i = 1; i < cycle.length; i++) if (cycle[i]! < cycle[first]!) first = i;
  return [...cycle.slice(first), ...cycle.slice(0, first)];
}

function cycleKey(cycle: readonly string[]): string {
  return rotate(cycle).join("\u0000");
}

/**
 * Every cycle of the directed graph, once each, by id, starting at the smallest id. Depth-first traversal runs on an
 * explicit stack, so a chain deeper than the JavaScript call stack is analyzed rather than overflowing it.
 */
export function findCycles(nodes: readonly DependencyNode[], edges: readonly DependencyEdge[]): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) adjacency.set(node.id, []);
  for (const edge of edges) adjacency.get(edge.from)?.push(edge.to);
  for (const targets of adjacency.values()) targets.sort(byCodePoint);

  const state = new Map<string, 1 | 2>();
  /** The path being traversed, each step remembering the next adjacency index to read. */
  const path: { id: string; next: number }[] = [];
  const cycles = new Map<string, string[]>();

  for (const node of nodes) {
    if (state.get(node.id) !== undefined) continue;
    state.set(node.id, 1);
    path.push({ id: node.id, next: 0 });
    while (path.length > 0) {
      const step = path[path.length - 1]!;
      const targets = adjacency.get(step.id) ?? [];
      if (step.next >= targets.length) {
        path.pop();
        state.set(step.id, 2);
        continue;
      }
      const next = targets[step.next]!;
      step.next += 1;
      const seen = state.get(next);
      if (seen === 1) {
        const at = path.findIndex((frame) => frame.id === next);
        const cycle = rotate(path.slice(at).map((frame) => frame.id));
        if (!cycles.has(cycleKey(cycle))) cycles.set(cycleKey(cycle), cycle);
      } else if (seen === undefined) {
        state.set(next, 1);
        path.push({ id: next, next: 0 });
      }
    }
  }
  return [...cycles.values()];
}

/**
 * Builds the dependency graph of one site. Reads pages through the existing include expander, so a page's
 * dependencies are the files its own directives name and, transitively, the files those snippets include.
 *
 * A missing include or asset is a node marked `missing` with an error at the referencing line. A cycle is one
 * error per distinct chain, at the edge that closes it. Include findings that already name the problem (`cycle`,
 * `missing`) are replaced by the graph's own diagnostics so one problem is one error.
 */
export async function buildDependencyGraph(options: DependencyGraphOptions): Promise<DependencyGraphResult> {
  const root = resolve(options.root);
  const config = options.site.config;
  const sourceDir = resolve(root, config.source);
  const files = options.files ?? (await discover(sourceDir, { include: config.include, exclude: config.exclude }));

  const nodes = new Map<string, DependencyNode>();
  const edges: DependencyEdge[] = [];
  const diagnostics: Diagnostic[] = [];

  /** Adds a node; a file keeps the role discovery gave it, and a missing reference still marks it. */
  const addNode = (node: DependencyNode): void => {
    const previous = nodes.get(node.id);
    if (previous === undefined) {
      nodes.set(node.id, node);
    } else if (node.missing === true && previous.missing !== true) {
      nodes.set(node.id, { ...previous, missing: true });
    }
  };

  const addEdge = (from: string, to: string, pos?: SourcePos): void => {
    edges.push({ from, to, ...(pos === undefined ? {} : { pos }) });
  };

  const navigationPath = normalize(config.navigation);
  const navigationFile = resolve(root, config.navigation);
  const hasNavigation = existsSync(navigationFile);
  const navigationId = hasNavigation ? `${NAVIGATION}${navigationPath}` : GENERATED_NAV;
  addNode({
    id: navigationId,
    kind: "navigation",
    path: navigationPath,
    ...(hasNavigation ? {} : { derived: true }),
  });

  const discovered = [...files].sort((a, b) => byCodePoint(normalize(a.path), normalize(b.path)));
  const pagePaths: string[] = [];
  const dataIds: string[] = [];
  const dataPaths: string[] = [];
  const filePaths = new Set<string>();

  for (const file of discovered) {
    const path = normalize(file.path);
    filePaths.add(path);
    if (file.kind === "doc") {
      pagePaths.push(path);
      addNode({ id: fileNodeId(path), kind: "page", path });
    } else if (file.kind === "data") {
      if (resolve(sourceDir, path) === navigationFile) continue;
      dataIds.push(fileNodeId(path));
      dataPaths.push(path);
      addNode({ id: fileNodeId(path), kind: "data", path });
    } else {
      addNode({ id: fileNodeId(path), kind: "asset", path });
    }
  }

  // A collection source is a data file whose pages the graph can name: a page that shows a record carries an edge
  // to that one file, not to every file under `_data`. A package source is the installed file, and a remote source is
  // the stored bytes the lock names, so both can be watched even though neither is discovered. A layout may still
  // read all of `_data`, so non-collection data files keep their blanket edge.
  const collectionPaths = new Map<string, string>();
  const collectionIds = new Set<string>();
  const incomplete: string[] = [];
  let lock: DataLock | undefined;
  let lockRead = false;
  for (const [name, collection] of Object.entries(options.site.collections)) {
    const source = collection.source;
    let path: string | undefined;
    if (source.startsWith("npm:")) {
      const resolved = await resolveNpmSource(options.root, source).catch(() => undefined);
      if (resolved?.source !== undefined) path = relative(sourceDir, resolved.source.file).split(sep).join("/");
    } else if (/^https:\/\//.test(source)) {
      if (!lockRead) {
        lockRead = true;
        lock = (await readLock(options.root).catch(() => undefined))?.lock;
      }
      const pinned = lock?.sources[source];
      if (pinned !== undefined) path = relative(sourceDir, storedPath(options.root, pinned.sha256)).split(sep).join("/");
    } else if (!/^[a-z][a-z\d+.-]*:/i.test(source)) {
      path = relative(sourceDir, resolve(options.root, source)).split(sep).join("/");
      if (path.startsWith("../") || path === "..") continue;
    }
    if (path === undefined) continue;
    path = normalize(path);
    collectionPaths.set(name, path);
    collectionIds.add(fileNodeId(path));
    if (!filePaths.has(path)) {
      filePaths.add(path);
      addNode({ id: fileNodeId(path), kind: "data", path });
    }
  }
  const blanketDataIds = dataIds.filter((id) => !collectionIds.has(id));

  // One node per record of a collection whose source a build reads, and one for the collection as a whole. A file no
  // collection reads gets no record node. A record depends on its source file, so a change to the file as a whole (a
  // schema, a lock, a re-read) still reaches every record; a changed record hash names the one that moved.
  const recordNodes = new Set<string>();
  for (const [name, collection] of Object.entries(options.site.collections)) {
    const sourcePath = collectionPaths.get(name);
    if (sourcePath === undefined) continue;
    const collectionId = collectionNodeId(name);
    const configId = collectionConfigNodeId(name);
    addNode({ id: collectionId, kind: "collection", path: name });
    addNode({ id: configId, kind: "collection", path: `${name} (config)` });
    addEdge(collectionId, fileNodeId(sourcePath), atFile(sourcePath));
    addEdge(collectionId, configId);
    // A schema or a lock file decides which records reach a page and which URLs they get, so a change to one is a
    // change to the whole collection. A file that does not exist has no node: its appearance is a change the graph
    // does not know, and the plan then asks for a full build.
    const schema = options.site.config.collections[name]?.schema;
    const shaping = [schema, LOCK_FILE, URLS_LOCK_FILE].filter((file): file is string => file !== undefined);
    for (const file of shaping) {
      const abs = resolve(options.root, file);
      if (!existsSync(abs)) continue;
      const rel = normalize(relative(sourceDir, abs).split(sep).join("/"));
      if (rel.startsWith("../")) continue;
      if (!filePaths.has(rel)) {
        filePaths.add(rel);
        addNode({ id: fileNodeId(rel), kind: "data", path: rel });
      }
      addEdge(configId, fileNodeId(rel), atFile(rel));
    }
    for (const record of collection.records) {
      const id = recordNodeId(name, record.id);
      recordNodes.add(id);
      addNode({ id, kind: "record", path: `${name}/${record.id}`, hash: recordHash(record) });
      addEdge(id, fileNodeId(sourcePath), {
        file: sourcePath,
        line: record.position.startLine,
        column: record.position.startColumn,
        endLine: record.position.endLine,
        endColumn: record.position.endColumn,
      });
      addEdge(collectionId, id);
      addEdge(id, configId);
    }
  }

  /** The source-relative path a `_data` key names, such as `components` or `guides.install.steps`. */
  const dataKeyPath = (key: string): string | undefined => {
    for (const path of dataPaths) {
      const withoutFolder = path.replace(/^_data\//, "");
      const withoutExtension = withoutFolder.replace(/\.[^/.]+$/, "");
      if (withoutExtension.split("/").join(".") === key) return path;
    }
    return undefined;
  };

  // One source page can produce several outputs: page one of a list, its later pages, and its expanded pages. Every
  // one of them is an output node, so a data change marks each of them instead of only the last page built from the file.
  const pagesByPath = new Map<string, Page[]>();
  for (const page of options.site.pages) {
    if (page.kind !== "doc") continue;
    const path = sourcePathOf(page.source.file, pagePaths);
    if (path === undefined) continue;
    const known = pagesByPath.get(path);
    if (known === undefined) pagesByPath.set(path, [page]);
    else known.push(page);
  }

  const addAssetEdge = (from: string, image: string, pos?: SourcePos): void => {
    const path = referencePath(image, config.base, from);
    if (path === undefined) return;
    if (!filePaths.has(path)) addNode({ id: fileNodeId(path), kind: "asset", path, missing: true });
    addEdge(fileNodeId(from), fileNodeId(path), pos ?? atFile(from));
  };

  /** Adds an edge for every image `body` names, with its line inside the source file that holds the body. */
  const addBodyAssetEdges = (path: string, body: string, bodyLine: number): void => {
    for (const reference of assetReferencesOf(body)) {
      addAssetEdge(path, reference.url, {
        file: path,
        line: bodyLine + reference.line - 1,
        column: reference.column,
        endLine: bodyLine + reference.endLine - 1,
        endColumn: reference.endColumn,
      });
    }
  };

  const includePaths = new Set<string>();

  /** The file a directive path reads: a collection name, or the `_data` file its first segment names. */
  const directiveTarget = (path: string): string | undefined => {
    const first = path.split(".", 1)[0] ?? "";
    return collectionPaths.get(first) ?? dataKeyPath(first);
  };

  /** Adds edges from `from` to the data files its `:data[…]` and `::data-table{…}` directives read. */
  const addDataEdges = (from: string, body: string, bodyLine: number): void => {
    const edge = (target: string, line: number, column: number, endColumn: number): void => {
      addEdge(fileNodeId(from), fileNodeId(target), {
        file: from,
        line: bodyLine + line - 1,
        column,
        endLine: bodyLine + line - 1,
        endColumn,
      });
    };
    let unresolved = false;
    const lines = body.split(/\r\n|\r|\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      for (const match of line.matchAll(/:data\[([^\]]+)\]/g)) {
        const target = directiveTarget(match[1]!.trim());
        if (target === undefined) unresolved = true;
        else edge(target, index + 1, (match.index ?? 0) + 1, (match.index ?? 0) + match[0].length);
      }
      for (const match of line.matchAll(/::data-table\{([^}]*)\}/g)) {
        const fromMatch = /(?:^|\s)from=([^\s]+)/.exec(match[1] ?? "");
        const target = fromMatch === null ? undefined : directiveTarget(fromMatch[1]!.replace(/^["']|["']$/g, ""));
        if (target === undefined) unresolved = true;
        else edge(target, index + 1, (match.index ?? 0) + 1, (match.index ?? 0) + match[0].length);
      }
      // A count reads a collection's records exactly as a list does, so the page depends on that source.
      for (const match of line.matchAll(/:count\{([^}]*)\}/g)) {
        const fromMatch = /(?:^|\s)from=([^\s]+)/.exec(match[1] ?? "");
        const target = fromMatch === null ? undefined : directiveTarget(fromMatch[1]!.replace(/^["']|["']$/g, ""));
        if (target === undefined) unresolved = true;
        else edge(target, index + 1, (match.index ?? 0) + 1, (match.index ?? 0) + match[0].length);
      }
    }
    // A directive the graph cannot resolve statically makes the whole graph unreliable for narrowing, so the plan
    // asks for a full build instead of keeping guessed edges.
    if (unresolved) incomplete.push(`A data directive in "${from}" cannot be resolved statically.`);
  };

  for (const path of pagePaths) {
    const source = await readFile(resolve(sourceDir, path), "utf8");
    const front = parseFrontMatter(source, path);
    if (typeof front.data.image === "string") addAssetEdge(path, front.data.image);
    addBodyAssetEdges(path, front.body, front.bodyLine);

    const included = await expandIncludes({
      body: front.body,
      bodyLine: front.bodyLine,
      file: path,
      sourceDir,
      displayFile: path,
    });
    for (const diagnostic of included.diagnostics) {
      if (diagnostic.id === "include.cycle" || diagnostic.id === "include.missing") continue;
      diagnostics.push(diagnostic);
    }
    addDataEdges(path, included.body, front.bodyLine);
    // A list page reads one collection's records, so its output depends on that source and no other data file.
    const declared = front.data.list;
    if (typeof declared === "object" && declared !== null && !Array.isArray(declared)) {
      const name = (declared as Record<string, unknown>).collection;
      const target = typeof name === "string" ? collectionPaths.get(name) : undefined;
      if (target !== undefined) addEdge(fileNodeId(path), fileNodeId(target), atFile(path));
    }
    for (const dependency of included.includes) {
      addNode({
        id: fileNodeId(dependency.path),
        kind: "include",
        path: dependency.path,
        ...(dependency.missing ? { missing: true } : {}),
      });
      addNode({ id: fileNodeId(dependency.from), kind: "include", path: dependency.from });
      addEdge(fileNodeId(dependency.from), fileNodeId(dependency.path), dependency.pos);
      if (!dependency.missing) includePaths.add(dependency.path);
    }
  }

  // A snippet's own images are the snippet's dependencies; the pages that include it inherit them transitively.
  // Included files are not discovered (their folder starts with `_`), so the expander's list is the source of truth.
  for (const path of [...includePaths].sort(byCodePoint)) {
    let source: string;
    try {
      source = await readFile(resolve(sourceDir, path), "utf8");
    } catch {
      continue; // An unreadable snippet is already the expander's diagnostic; it has no body to read here.
    }
    const front = parseFrontMatter(source, path);
    addBodyAssetEdges(path, front.body, front.bodyLine);
    addDataEdges(path, front.body, front.bodyLine);
  }

  for (const [path, pages] of pagesByPath) {
    for (const page of pages) {
      const outputId = outputNodeId(page.url);
      addNode({ id: outputId, kind: "output", path: page.url, ...(page.list === undefined ? {} : { role: "list" }) });
      addEdge(outputId, fileNodeId(path));
      addEdge(outputId, navigationId);
      for (const dataId of blanketDataIds) addEdge(outputId, dataId);
    }
  }

  // A record page reads its record and its template. A list page reads its collection as a whole, because a record
  // that was edited to match its filter joins a page it was not on before, and each record it shows, so the outputs
  // that consume one record are known without building a list again.
  const templateNodes = new Set<string>();
  const addRecordEdge = (from: string, collection: string, id: string): void => {
    const node = recordNodeId(collection, id);
    if (recordNodes.has(node)) addEdge(from, node);
  };
  for (const page of options.site.pages) {
    if (page.record === undefined && page.list === undefined) continue;
    const outputId = outputNodeId(page.url);
    addNode({ id: outputId, kind: "output", path: page.url, ...(page.list === undefined ? {} : { role: "list" }) });
    if (page.record !== undefined) {
      const recordId = recordNodeId(page.record.collection, page.record.id);
      if (recordNodes.has(recordId)) addEdge(outputId, recordId);
      addEdge(outputId, navigationId);
      for (const dataId of blanketDataIds) addEdge(outputId, dataId);
      const template = normalize(relative(sourceDir, resolve(options.root, page.record.template)).split(sep).join("/"));
      if (!templateNodes.has(template)) {
        templateNodes.add(template);
        addNode({ id: fileNodeId(template), kind: "include", path: template });
      }
      addEdge(outputId, fileNodeId(template), { file: template, line: 1, column: 1, endLine: 1, endColumn: 1 });
    }
    if (page.list !== undefined && collectionPaths.has(page.list.collection)) {
      addEdge(outputId, collectionNodeId(page.list.collection));
      // Every page of a paginated or expanded list is its own output, so the records each one shows link to it.
      for (const record of page.list.records) addRecordEdge(outputId, page.list.collection, record.id);
      for (const group of page.list.groups) for (const record of group.records) addRecordEdge(outputId, page.list.collection, record.id);
    }
  }

  // A feed lists its collection's records through the filter a list page uses, so it depends on the collection as a
  // whole: a record edited to match the filter joins the feed even though no output page names it yet.
  if (config.outputs.feeds !== false) {
    for (const name of Object.keys(config.feeds).sort(byCodePoint)) {
      const feed = config.feeds[name]!;
      if (!feedIsWritten(options.site, name)) continue;
      for (const format of feed.formats ?? ["atom"]) {
        const path = `/${feedFile(name, format)}`;
        const id = outputNodeId(path);
        addNode({ id, kind: "output", path, role: "feed" });
        if (collectionPaths.has(feed.collection)) addEdge(id, collectionNodeId(feed.collection));
      }
    }
  }

  // The API writes one file per published record and one aggregate per version and collection. A record file depends on
  // its record; an aggregate holds every record of its collection, so it depends on the collection as a whole.
  if (config.api !== undefined && config.outputs.api !== false) {
    for (const version of apiVersions(options.site, () => {})) {
      const scoped: Site = {
        ...options.site,
        config: { ...config, api: { version: version.version, collections: version.collections } },
      };
      const dir = apiDir(scoped);
      const collections = apiCollections(scoped);
      const aggregate = (file: string, dependencies: readonly string[]): void => {
        const path = `/${file}`;
        const id = outputNodeId(path);
        addNode({ id, kind: "output", path, role: "api" });
        for (const dependency of dependencies) addEdge(id, dependency);
      };
      const published = collections.filter((collection) => collectionPaths.has(collection.name));
      const all = published.map((collection) => collectionNodeId(collection.name));
      aggregate(`${dir}/index.json`, all);
      aggregate(`${dir}/openapi.json`, all);
      for (const collection of collections) {
        const collectionId = collectionNodeId(collection.name);
        const depends = collectionPaths.has(collection.name) ? [collectionId] : [];
        aggregate(`${dir}/${collection.name}.json`, depends);
        aggregate(`${dir}/${collection.name}.ndjson`, depends);
        if (collection.hasSchema) aggregate(`${dir}/schemas/${collection.name}.json`, depends);
        for (const record of collection.records) {
          if (unsafeIdReason(record.id) !== undefined) continue;
          const recordId = recordNodeId(collection.name, record.id);
          if (!recordNodes.has(recordId)) continue;
          const path = `/${dir}/${collection.name}/${record.id}.json`;
          const id = outputNodeId(path);
          addNode({ id, kind: "output", path, role: "api" });
          addEdge(id, recordId);
        }
      }
    }
  }

  // Navigation built from folders reads every page's title, so it depends on all of them. A navigation file does not.
  if (!hasNavigation) {
    for (const path of pagesByPath.keys()) addEdge(navigationId, fileNodeId(path));
  }

  const graphNodes = [...nodes.values()].sort(compareNodes);
  const graphEdges = sortedEdges(edges);
  const nodeById = new Map(graphNodes.map((node) => [node.id, node]));

  for (const node of graphNodes) {
    if (node.missing !== true) continue;
    const references = graphEdges.filter((edge) => edge.to === node.id);
    if (references.length === 0) {
      diagnostics.push({
        id: "dependency.missing",
        severity: "error",
        message: `The dependency ${node.path} does not exist.`,
        help: `Create ${node.path}, or remove the dependency.`,
      });
      continue;
    }
    for (const edge of references) {
      const at = edge.pos === undefined ? "" : ` at ${edge.pos.file}:${edge.pos.line}`;
      diagnostics.push({
        id: "dependency.missing",
        severity: "error",
        message: `The dependency ${node.path} does not exist; it is referenced${at}.`,
        ...(edge.pos === undefined ? {} : { pos: edge.pos }),
        help: `Create ${node.path}, or change the path where it is referenced.`,
      });
    }
  }

  for (const cycle of findCycles(graphNodes, graphEdges)) {
    const first = cycle[0]!;
    const closing = graphEdges.find((edge) => edge.from === cycle.at(-1) && edge.to === first);
    const chain = [...cycle, first].map((id) => nodeById.get(id)?.path ?? id).join(" → ");
    diagnostics.push({
      id: "dependency.cycle",
      severity: "error",
      message: `Dependency cycle: ${chain}.`,
      ...(closing?.pos === undefined ? {} : { pos: closing.pos }),
      help: `Remove one of these dependencies so the chain no longer returns to ${nodeById.get(first)?.path ?? first}.`,
    });
  }

  const unresolved = [...new Set(incomplete)].sort(byCodePoint);
  return {
    graph: { nodes: graphNodes, edges: graphEdges, ...(unresolved.length === 0 ? {} : { incomplete: unresolved }) },
    diagnostics: sortDiagnostics(diagnostics),
  };
}

/**
 * The ids of every node transitively affected by a change to `changed`, sorted.
 *
 * `changed` values are matched against node ids and source paths, so a caller can pass a discovered path. The
 * changed nodes themselves are not in the result: they are inputs, and their dependents are what gets rebuilt.
 * A deleted include or asset is still a node marked `missing`, so its dependents are found the same way.
 */
export function affectedNodes(graph: DependencyGraph, changed: readonly string[]): string[] {
  const seeds = new Set<string>();
  const wanted = new Set(changed);
  for (const node of graph.nodes) {
    if (wanted.has(node.id) || wanted.has(node.path)) seeds.add(node.id);
  }
  if (seeds.size === 0) return [];
  if (graph.incomplete !== undefined && graph.incomplete.length > 0) {
    return graph.nodes.filter((node) => node.kind === "output").map((node) => node.id);
  }

  const dependents = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    const list = dependents.get(edge.to);
    if (list === undefined) dependents.set(edge.to, new Set([edge.from]));
    else list.add(edge.from);
  }

  const affected = new Set<string>(seeds);
  const queue = [...seeds];
  while (queue.length > 0) {
    const id = queue.pop()!;
    for (const dependent of dependents.get(id) ?? []) {
      if (affected.has(dependent)) continue;
      affected.add(dependent);
      queue.push(dependent);
    }
  }

  return [...affected].filter((id) => !seeds.has(id)).sort(byCodePoint);
}

/**
 * The graph as JSON with a trailing newline. Nodes and edges are sorted here too, so two graphs built from the
 * same files serialize identically whatever order discovery or insertion used.
 */
export function serializeDependencyGraph(graph: DependencyGraph): string {
  const nodes = [...graph.nodes].sort(compareNodes).map((node) => ({
    id: node.id,
    kind: node.kind,
    path: node.path,
    ...(node.derived === true ? { derived: true } : {}),
    ...(node.missing === true ? { missing: true } : {}),
    ...(node.role === undefined ? {} : { role: node.role }),
    ...(node.hash === undefined ? {} : { hash: node.hash }),
  }));
  const edges = sortedEdges(graph.edges).map((edge) => ({
    from: edge.from,
    to: edge.to,
    ...(edge.pos === undefined
      ? {}
      : {
          pos: {
            file: edge.pos.file,
            line: edge.pos.line,
            column: edge.pos.column,
            endLine: edge.pos.endLine,
            endColumn: edge.pos.endColumn,
          },
        }),
  }));
  return `${JSON.stringify({ version: 1, nodes, edges }, null, 2)}\n`;
}
