/**
 * `mizzen data fetch [dir] [--check]`: fetches every `https:` collection source, stores its bytes under
 * `.mizzen/data/`, and writes `mizzen.lock.json`. A build never does this; it only reads what this command pinned.
 *
 * `--check` performs the same reads and compares them with the lock without writing. Exit 0 is all unchanged, 1 is a
 * new, changed, or unreadable source, and 2 is a usage error. The fetcher sends no header that names the site or its
 * owner, bounds the response size, the time, and the redirects, and stores nothing when any source fails.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { loadConfig } from "../config/load.ts";
import { fetchApiSource, isFetchableUrl, type ApiPage } from "../data/api-fetch.ts";
import { loadCollections } from "../data/collections.ts";
import { dataLimitsOf } from "../data/limits.ts";
import { LOCK_FILE, canonicalJson, readLock, sha256, storedPath, writeLock, type DataLock, type LockedSource } from "../data/lock.ts";
import { resolveNpmSource } from "../data/package-source.ts";
import { compileSchemas, schemaSnapshotOf, type CompiledSchemas } from "../data/schema.ts";
import { gitSnapshot, instantOfHttpDate, orderedSnapshot, snapshotOfPinned } from "../data/snapshot.ts";
import type { TransformEvent } from "../data/transform.ts";
import type { CollectionSnapshot } from "../contracts/index.ts";

/** How long one request may take. */
export const FETCH_TIMEOUT_MS = 30_000;

/** How many redirects one request may follow. */
export const FETCH_REDIRECTS = 5;

/** A `fetch` with the one shape this command uses, so a test can point it at a local server. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Options of {@link dataFetch}. */
export interface DataFetchOptions {
  /** The site root: the folder that holds `mizzen.yml`. */
  readonly root: string;
  /** Compare with the lock without writing anything. */
  readonly check?: boolean;
  /** The fetcher; defaults to the runtime's global `fetch`. Tests pass one that talks to a local server. */
  readonly fetch?: FetchLike;
}

/** What {@link dataFetch} did, ready for the CLI to print. */
export interface DataFetchResult {
  /** 0 when every source matches, 1 when one is new, changed, or unreadable, 2 for a usage problem. */
  readonly code: number;
  /** One line per source and for the lock file, in config order. */
  readonly messages: readonly string[];
  /** Problems, printed to stderr. */
  readonly errors: readonly string[];
}

/** A source's current bytes and identity. */
interface Current {
  readonly address: string;
  readonly bytes: Uint8Array;
  readonly version?: string;
  readonly packageName?: string;
  /** The response's own date, for a URL. */
  readonly fetchedAt?: string;
}

/** Reads a remote source with a bounded time, size, and redirect count. */
async function fetchRemote(address: string, maxBytes: number, fetcher: FetchLike): Promise<{ readonly bytes: Uint8Array; readonly fetchedAt?: string }> {
  let current = address;
  for (let redirects = 0; redirects <= FETCH_REDIRECTS; redirects++) {
    let url: URL;
    try {
      url = new URL(current);
    } catch {
      throw new Error(`"${current}" is not a URL`);
    }
    if (!isFetchableUrl(url)) throw new Error(`"${current}" is not an https URL`);

    const response = await fetcher(current, {
      redirect: "manual",
      headers: { accept: "*/*" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location === null) throw new Error(`HTTP ${response.status} from ${current} names no location`);
      if (redirects === FETCH_REDIRECTS) throw new Error(`${address} redirects more than ${FETCH_REDIRECTS} times`);
      current = new URL(location, current).href;
      continue;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${current}`);

    const fetchedAt = instantOfHttpDate(response.headers.get("last-modified")) ?? instantOfHttpDate(response.headers.get("date"));
    const withDate = (bytes: Uint8Array) => ({ bytes, ...(fetchedAt === undefined ? {} : { fetchedAt }) });
    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`${address} is larger than the ${maxBytes} byte limit`);
    }

    const reader = response.body?.getReader();
    if (reader === undefined) return withDate(new Uint8Array(await response.arrayBuffer()));
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`${address} is larger than the ${maxBytes} byte limit`);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return withDate(bytes);
  }
  throw new Error(`${address} redirects more than ${FETCH_REDIRECTS} times`);
}

/** The source entries a fetched lock holds, sorted by address. */
function sortedSources(entries: ReadonlyMap<string, LockedSource>): Readonly<Record<string, LockedSource>> {
  const sources: Record<string, LockedSource> = {};
  for (const address of [...entries.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    sources[address] = entries.get(address)!;
  }
  return sources;
}

/** True for an address whose bytes `mizzen data fetch` reads over the network. */
function isFetchedAddress(address: string): boolean {
  try {
    return isFetchableUrl(new URL(address));
  } catch {
    return false;
  }
}

/** `snapshot` with the collection's schema, when it compiles, so a later schema can be compared with it. */
function withSchema(snapshot: CollectionSnapshot, schemas: CompiledSchemas, name: string): CollectionSnapshot {
  const schema = schemas.schemas[name];
  return schema === undefined ? snapshot : orderedSnapshot({ ...snapshot, schema: schemaSnapshotOf(schema) });
}

/**
 * Fetches or verifies every remote and package source the config declares. Nothing is written when any source fails,
 * and `check` writes nothing at all.
 */
export async function dataFetch(options: DataFetchOptions): Promise<DataFetchResult> {
  const root = options.root;
  const messages: string[] = [];
  const errors: string[] = [];
  const loaded = loadConfig(root);
  for (const diagnostic of loaded.diagnostics) {
    if (diagnostic.severity === "error") errors.push(diagnostic.message);
  }
  if (errors.length > 0) return { code: 1, messages, errors };

  const config = loaded.config;
  const compiled = compileSchemas(root, config, {}, []);
  const names = Object.keys(config.collections).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const pinned = await readLock(root);
  for (const diagnostic of pinned.diagnostics) {
    if (diagnostic.severity === "error") errors.push(diagnostic.message);
  }
  if (errors.length > 0) return { code: 1, messages, errors };

  const fetcher: FetchLike = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const current = new Map<string, Current>();
  const next = new Map<string, LockedSource>();
  const remote = new Map<string, string>();
  const manifests = new Map<string, readonly ApiPage[]>();
  let changed = false;

  for (const name of names) {
    const entry = config.collections[name]!;
    const source = entry.source;
    const limits = dataLimitsOf(name, entry);

    if (source.startsWith("npm:")) {
      const resolved = await resolveNpmSource(root, source);
      if (resolved.source === undefined) {
        errors.push(resolved.diagnostic?.message ?? `Cannot resolve ${source}`);
        continue;
      }
      let bytes: Uint8Array;
      try {
        bytes = await readFile(resolved.source.file);
      } catch {
        errors.push(`Cannot read ${source}`);
        continue;
      }
      if (bytes.byteLength > limits.bytes) {
        errors.push(`${source} is larger than the ${limits.bytes} byte limit`);
        continue;
      }
      current.set(source, { address: source, bytes, version: resolved.source.version, packageName: resolved.source.name });
      remote.set(name, source);
    } else if (isFetchedAddress(source)) {
      if (entry.records !== undefined) {
        const fetched = await fetchApiSource({
          collection: name,
          source,
          records: entry.records,
          ...(entry.pagination === undefined ? {} : { pagination: entry.pagination }),
          idField: entry.id ?? "id",
          limits,
          fetcher,
          env: process.env,
        });
        if (fetched.bytes === undefined) {
          errors.push(fetched.diagnostic?.message ?? `Cannot read ${source}`);
          continue;
        }
        current.set(source, {
          address: source,
          bytes: fetched.bytes,
          ...(fetched.fetchedAt === undefined ? {} : { fetchedAt: fetched.fetchedAt }),
        });
        remote.set(name, source);
        if (fetched.pages !== undefined) manifests.set(source, fetched.pages);
      } else {
        try {
          const fetched = await fetchRemote(source, limits.bytes, fetcher);
          current.set(source, { address: source, bytes: fetched.bytes, ...(fetched.fetchedAt === undefined ? {} : { fetchedAt: fetched.fetchedAt }) });
          remote.set(name, source);
        } catch (err) {
          errors.push(err instanceof Error ? err.message : String(err));
          continue;
        }
      }
    } else if (/^[a-z][a-z\d+.-]*:/i.test(source)) {
      errors.push(`Collection "${name}" uses "${source}"; only https://, npm:, and site paths are supported.`);
    } else {
      continue;
    }
  }

  if (errors.length > 0) return { code: 1, messages, errors };

  for (const [address, now] of current) {
    const bytes = now.bytes;
    const before = pinned.lock.sources[address];
    const hash = sha256(bytes);
    // An unchanged source keeps the date the lock holds, so fetching it again writes the same bytes.
    const fetchedAt = before !== undefined && before.sha256 === hash ? before.fetchedAt ?? now.fetchedAt : now.fetchedAt;
    const entry: LockedSource = {
      address,
      ...(now.version === undefined ? {} : { version: now.version }),
      bytes: bytes.byteLength,
      sha256: hash,
      ...(fetchedAt === undefined ? {} : { fetchedAt }),
      ...(manifests.get(address) === undefined ? {} : { pages: manifests.get(address)! }),
    };
    next.set(address, entry);
    let same = before !== undefined && canonicalJson(before) === canonicalJson(entry);
    // A matching lock is not enough for a remote source: its stored bytes must still be there and still hash right.
    if (same && before !== undefined && isFetchedAddress(address)) {
      try {
        const stored = await readFile(storedPath(root, before.sha256));
        same = stored.byteLength === before.bytes && sha256(stored) === before.sha256;
      } catch {
        same = false;
      }
    }
    if (before === undefined) {
      changed = true;
      messages.push(`new ${address}`);
    } else if (!same) {
      changed = true;
      messages.push(`changed ${address}`);
    } else {
      messages.push(`unchanged ${address}`);
    }
  }

  // A source the config no longer declares leaves the lock, so the file describes exactly this site.
  for (const address of Object.keys(pinned.lock.sources)) {
    if (!next.has(address)) {
      changed = true;
      messages.push(`removed ${address}`);
    }
  }

  // Each package or URL collection gets its snapshot from what the lock now holds; a file collection keeps the one
  // `mizzen data snapshot` wrote, and a collection the config no longer declares loses its entry.
  const snapshots: Record<string, CollectionSnapshot> = {};
  for (const name of names) {
    const address = remote.get(name);
    const locked = address === undefined ? undefined : next.get(address);
    const now = address === undefined ? undefined : current.get(address);
    if (address !== undefined && locked !== undefined && now !== undefined) {
      snapshots[name] = withSchema(
        snapshotOfPinned({
          address,
          ...(now.packageName === undefined ? {} : { packageName: now.packageName }),
          ...(locked.version === undefined ? {} : { version: locked.version }),
          sha256: locked.sha256,
          ...(locked.fetchedAt === undefined ? {} : { fetchedAt: locked.fetchedAt }),
        }),
        compiled,
        name,
      );
    } else if (!/^(https:\/\/|npm:)/.test(config.collections[name]!.source) && !isFetchedAddress(config.collections[name]!.source) && pinned.lock.snapshots?.[name] !== undefined) {
      snapshots[name] = orderedSnapshot(pinned.lock.snapshots[name]!);
    }
  }
  const sameSnapshots = JSON.stringify(Object.entries(snapshots)) === JSON.stringify(Object.entries(pinned.lock.snapshots ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, orderedSnapshot(v)]));
  if (!sameSnapshots) {
    changed = true;
    messages.push("snapshots updated");
  }

  if (options.check === true) {
    return { code: changed ? 1 : 0, messages, errors };
  }
  if (!changed) return { code: 0, messages, errors };

  for (const [address, now] of current) {
    if (!isFetchedAddress(address)) continue;
    const path = storedPath(root, sha256(now.bytes));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, now.bytes);
  }
  const lock: DataLock = { version: 1, sources: sortedSources(next), ...(Object.keys(snapshots).length > 0 ? { snapshots } : {}) };
  await writeLock(root, lock);
  messages.push(`wrote ${LOCK_FILE}`);
  return { code: 0, messages, errors };
}


/** Options of {@link dataSnapshot}. */
export interface DataSnapshotOptions {
  /** The site root: the folder that holds `mizzen.yml`. */
  readonly root: string;
  /** The collection to record. */
  readonly name: string;
  /** Record the last commit even when the file has uncommitted changes. */
  readonly allowDirty?: boolean;
}

/**
 * `mizzen data snapshot <name>`: records the last commit and its date for a file collection in the lock. It reads the
 * local git repository only, refuses a file with uncommitted changes unless `allowDirty` is set, and changes nothing
 * else in the lock.
 */
export async function dataSnapshot(options: DataSnapshotOptions): Promise<DataFetchResult> {
  const { root, name } = options;
  const messages: string[] = [];
  const errors: string[] = [];
  const loaded = loadConfig(root);
  for (const diagnostic of loaded.diagnostics) {
    if (diagnostic.severity === "error") errors.push(diagnostic.message);
  }
  if (errors.length > 0) return { code: 1, messages, errors };

  const entry = loaded.config.collections[name];
  if (entry === undefined) return { code: 2, messages, errors: [`No collection named "${name}" in mizzen.yml.`] };
  if (/^[a-z][a-z\d+.-]*:/i.test(entry.source)) {
    return { code: 2, messages, errors: [`Collection "${name}" reads "${entry.source}"; \`mizzen data fetch\` records it. Only a file in the site has a commit.`] };
  }

  const pinned = await readLock(root);
  for (const diagnostic of pinned.diagnostics) {
    if (diagnostic.severity === "error") errors.push(diagnostic.message);
  }
  if (errors.length > 0) return { code: 1, messages, errors };

  const result = gitSnapshot(root, entry.source, options.allowDirty === true);
  if (!result.ok) return { code: 1, messages, errors: [result.message] };
  const snapshot = withSchema(result.snapshot, compileSchemas(root, loaded.config, {}, []), name);

  const lock: DataLock = { ...pinned.lock, snapshots: { ...pinned.lock.snapshots, [name]: snapshot } };
  await writeLock(root, lock);
  if (result.dirty) messages.push(`warning: ${entry.source} has uncommitted changes; the snapshot names the last commit`);
  messages.push(`snapshot ${name} at ${snapshot.ref} (${snapshot.capturedAt})`);
  messages.push(`wrote ${LOCK_FILE}`);
  return { code: 0, messages, errors };
}

/** Options of {@link dataTransform}. */
export interface DataTransformOptions {
  /** The site root: the folder that holds `mizzen.yml`. */
  readonly root: string;
  /** One collection to preview. Default: every collection that declares transformation rules. */
  readonly name?: string;
  /** Records to show per collection. Default 5. */
  readonly limit?: number;
  /** Print one JSON report instead of text. */
  readonly json?: boolean;
}

/** What {@link dataTransform} read, ready for the CLI to print. */
export interface DataTransformResult {
  /** 0 when no finding is an error, 1 when one is, 2 for a usage problem. */
  readonly code: number;
  /** The sample and the findings. */
  readonly output: string;
  /** Problems, printed to stderr. */
  readonly errors: readonly string[];
}

/** One collection's preview. */
interface TransformPreview {
  readonly name: string;
  readonly steps: number;
  readonly total: number;
  readonly records: readonly { readonly id: string; readonly fields: Readonly<Record<string, unknown>> }[];
}

/** A diagnostic as one line for the preview. */
function previewLine(diagnostic: { readonly severity: string; readonly id: string; readonly message: string; readonly pos?: { readonly file: string; readonly line: number } }): string {
  return `${diagnostic.severity} ${diagnostic.id}: ${diagnostic.message}${diagnostic.pos === undefined ? "" : ` (${diagnostic.pos.file}:${diagnostic.pos.line})`}`;
}

/**
 * Previews the records a collection's transformation rules produce, and every finding they make, without writing
 * anything. It loads the config and the collections exactly as a build does, so the sample and the errors are the
 * ones a build would meet; no cache, lock, or output is written.
 */
export async function dataTransform(options: DataTransformOptions): Promise<DataTransformResult> {
  const limit = options.limit ?? 5;
  const { config, diagnostics: configDiagnostics } = loadConfig(options.root);
  if (options.name !== undefined && config.collections[options.name] === undefined) {
    return { code: 2, output: "", errors: [`the site has no collection "${options.name}"`] };
  }
  const names =
    options.name === undefined
      ? Object.keys(config.collections).filter((name) => config.collections[name]!.transform !== undefined)
      : [options.name];
  const events: TransformEvent[] = [];
  const result = await loadCollections({ root: options.root, config, onTransformEvent: (event) => events.push(event) });
  const previews: TransformPreview[] = names.map((name) => {
    const records = result.collections[name]?.records ?? [];
    return {
      name,
      steps: config.collections[name]!.transform?.steps.length ?? 0,
      total: records.length,
      records: records.slice(0, limit).map((record) => ({ id: record.id, fields: record.fields })),
    };
  });
  const diagnostics = [...configDiagnostics, ...result.diagnostics];
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error").map(previewLine);

  if (options.json === true) {
    return {
      code: errors.length === 0 ? 0 : 1,
      output: `${JSON.stringify({ collections: previews, diagnostics, events }, null, 2)}\n`,
      errors,
    };
  }

  const lines: string[] = [];
  if (previews.length === 0) lines.push("no collection declares transformation rules");
  for (const preview of previews) {
    lines.push(`${preview.name}: ${preview.records.length} of ${preview.total} records, ${preview.steps} steps`);
    for (const record of preview.records) lines.push(`- ${record.id}: ${JSON.stringify(record.fields)}`);
  }
  for (const diagnostic of diagnostics) lines.push(previewLine(diagnostic));
  return { code: errors.length === 0 ? 0 : 1, output: `${lines.join("\n")}\n`, errors };
}
