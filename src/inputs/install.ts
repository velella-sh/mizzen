/**
 * `mizzen inputs import`: validates a package against the destination, refuses a lock or file conflict unless the
 * person accepts that input by name, then activates the inputs and the merged lock through renames. Everything is
 * checked and staged before anything active changes; a failure restores the files already replaced and never writes the
 * lock, so the previous inputs stay active. Installing the same package again finds every hash equal and writes nothing.
 */
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Diagnostic } from "../contracts/index.ts";
import { LOCK_FILE, lockText, readLock, sha256, storedPath, type DataLock, type LockedSource } from "../data/lock.ts";
import {
  isAddressSource,
  isRestrictedSource,
  isSafeSourcePath,
  MAX_INPUT_BYTES,
  MAX_PACKAGE_BYTES,
  type PackedInput,
} from "./manifest.ts";
import { readPackage, type InputPackage } from "./pack.ts";

/** Options of {@link importInputs}. */
export interface ImportInputsOptions {
  /** Absolute site root: the folder that holds `mizzen.yml`. */
  readonly root: string;
  /** The package file to install. */
  readonly file: string;
  /** Input ids whose destination difference is accepted, or `all`. Without it a conflict changes nothing. */
  readonly accept?: readonly string[] | "all";
  /** Largest package to read; defaults to {@link MAX_PACKAGE_BYTES}. */
  readonly maxBytes?: number;
  /** Largest one input may be; defaults to {@link MAX_INPUT_BYTES}. */
  readonly maxInputBytes?: number;
}

/** What {@link importInputs} did. */
export interface ImportInputsResult {
  /** 0 when installed or already installed, 1 when a problem or conflict stopped the import. */
  readonly code: number;
  /** Every problem, each naming the input it concerns and a fix. */
  readonly diagnostics: readonly Diagnostic[];
  /** One line per installed input and for the lock, for the CLI to print. */
  readonly messages: readonly string[];
  /** The input ids and the lock file this import changed; empty when nothing changed. */
  readonly changed: readonly string[];
}

/** One destination difference that needs an explicit choice. */
interface Conflict {
  readonly id: string;
  readonly kind: "file" | "lock";
  readonly detail: string;
}

/** A local input staged for activation. */
interface LocalChange {
  readonly input: PackedInput;
  readonly destination: string;
  readonly before?: Uint8Array;
  readonly staged: string;
}

/** A locked input whose store or lock entry changes. */
interface LockedChange {
  readonly input: PackedInput;
  readonly entry: LockedSource;
  readonly store: string;
  readonly present: boolean;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function conflictDiagnostic(conflict: Conflict): Diagnostic {
  const where =
    conflict.kind === "lock"
      ? `Input "${conflict.id}" conflicts with mizzen.lock.json: ${conflict.detail}.`
      : `Input "${conflict.id}" conflicts with the destination: ${conflict.detail}.`;
  return {
    id: conflict.kind === "lock" ? "inputs.lock-conflict" : "inputs.file-conflict",
    severity: "error",
    message: where,
    help: `Review the difference, then re-run with \`--accept ${conflict.id}\` (or \`--accept all\`).`,
  };
}

/** Reads an existing file under the input limit; `undefined` when it does not exist, `"too-large"` over the limit. */
async function readExisting(file: string, maxBytes: number): Promise<Uint8Array | "too-large" | undefined> {
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    return undefined;
  }
  if (size > maxBytes) return "too-large";
  return readFile(file);
}

/**
 * Why `source` may not be written: a symbolic link or a non-folder on the way, a symbolic link or folder at the target.
 * The path itself is already relative and inside the site.
 */
async function pathProblem(realRoot: string, source: string): Promise<string | undefined> {
  let current = realRoot;
  const parts = source.split("/");
  for (let index = 0; index < parts.length - 1; index++) {
    const part = parts[index]!;
    current = join(current, part);
    const entry = await lstat(current).catch(() => undefined);
    if (entry === undefined) break;
    const prefix = parts.slice(0, index + 1).join("/");
    if (entry.isSymbolicLink()) return `folder ${prefix} is a symbolic link`;
    if (!entry.isDirectory()) return `${prefix} is not a folder`;
  }
  const entry = await lstat(join(realRoot, source)).catch(() => undefined);
  if (entry?.isSymbolicLink()) return `"${source}" is a symbolic link`;
  if (entry?.isDirectory()) return `"${source}" is a folder`;
  return undefined;
}

/** Writes `data` beside `file` and renames it into place, so a reader sees the old file or the new one. */
async function writeAtomic(file: string, data: Uint8Array | string): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, data);
  try {
    await rename(temporary, file);
  } catch (err) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw err;
  }
}

function sortedSources(sources: Readonly<Record<string, LockedSource>>): Readonly<Record<string, LockedSource>> {
  const sorted: Record<string, LockedSource> = {};
  for (const address of Object.keys(sources).sort(compare)) sorted[address] = sources[address]!;
  return sorted;
}

/**
 * Installs a package at `root`. The package is checked whole first, then every destination path and lock entry; a
 * conflict without an accepted id stops the import with no write. After activation the lock is written last, and the
 * package is a no-op when every input already matches.
 */
export async function importInputs(options: ImportInputsOptions): Promise<ImportInputsResult> {
  const diagnostics: Diagnostic[] = [];
  const messages: string[] = [];
  const maxInputBytes = options.maxInputBytes ?? MAX_INPUT_BYTES;
  const read = await readPackage(options.file, options.maxBytes ?? MAX_PACKAGE_BYTES);
  if (read.pkg === undefined) return { code: 1, diagnostics: read.diagnostics, messages, changed: [] };
  const pkg: InputPackage = read.pkg;

  let realRoot: string;
  try {
    realRoot = await realpath(options.root);
  } catch {
    return {
      code: 1,
      diagnostics: [{ id: "inputs.site-missing", severity: "error", message: `The site root ${options.root} cannot be read.`, help: "Pass the folder that holds mizzen.yml." }],
      messages,
      changed: [],
    };
  }
  const pinned = await readLock(realRoot);
  if (pinned.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return { code: 1, diagnostics: [...pinned.diagnostics], messages, changed: [] };
  }

  const conflicts: Conflict[] = [];
  const locals: { readonly input: PackedInput; readonly destination: string; readonly before?: Uint8Array }[] = [];
  const locked: { readonly input: PackedInput; readonly entry: LockedSource; readonly store: string; readonly present: boolean }[] = [];

  for (const input of pkg.manifest.inputs) {
    if (input.bytes > maxInputBytes) {
      diagnostics.push({
        id: "inputs.input-too-large",
        severity: "error",
        message: `Input "${input.id}" is ${input.bytes} bytes; the import limit is ${maxInputBytes}.`,
        help: "Import a smaller package, or raise the importer's limit for trusted input.",
      });
      continue;
    }
    if (isAddressSource(input.source)) {
      if (!input.source.startsWith("https://")) {
        diagnostics.push({
          id: "inputs.import-source",
          severity: "error",
          message: `Input "${input.id}" names "${input.source}", which cannot be installed from a package.`,
          help: "A package carries https: sources and files in the site; install a package source with npm in the destination.",
        });
        continue;
      }
      const entry = pkg.manifest.lock.sources[input.source];
      if (entry === undefined) {
        diagnostics.push({
          id: "inputs.manifest-invalid",
          severity: "error",
          message: `Input "${input.id}" has no lock entry in the package.`,
          help: "Export the package again.",
        });
        continue;
      }
      const store = storedPath(realRoot, input.sha256);
      const storeEntry = await lstat(store).catch(() => undefined);
      if (storeEntry?.isSymbolicLink()) {
        diagnostics.push({
          id: "inputs.path-invalid",
          severity: "error",
          message: `The stored content for input "${input.id}" is a symbolic link.`,
          help: "Remove the link under .mizzen/data, then import again.",
        });
        continue;
      }
      const presentBytes = await readExisting(store, maxInputBytes);
      if (presentBytes === "too-large") {
        diagnostics.push({
          id: "inputs.destination-too-large",
          severity: "error",
          message: `The stored content at ${store} is larger than the ${maxInputBytes} byte limit.`,
          help: "Remove the stored file, then import again.",
        });
        continue;
      }
      if (presentBytes !== undefined && sha256(presentBytes) !== input.sha256) {
        diagnostics.push({
          id: "inputs.store-mismatch",
          severity: "error",
          message: `The content already stored for input "${input.id}" does not match its package hash.`,
          help: "Remove the stored file under .mizzen/data, or run `mizzen data fetch`, then import again.",
        });
        continue;
      }
      const before = pinned.lock.sources[input.source];
      if (before !== undefined && (before.sha256 !== entry.sha256 || before.bytes !== entry.bytes || before.version !== entry.version)) {
        conflicts.push({
          id: input.id,
          kind: "lock",
          detail: `the destination pins ${before.sha256}${before.version === undefined ? "" : ` at ${before.version}`} and the package pins ${entry.sha256}${entry.version === undefined ? "" : ` at ${entry.version}`}`,
        });
      }
      locked.push({ input, entry, store, present: presentBytes !== undefined });
      continue;
    }

    if (isRestrictedSource(input.source) || !isSafeSourcePath(input.source)) {
      diagnostics.push({
        id: "inputs.path-invalid",
        severity: "error",
        message: `Input "${input.id}" names "${input.source}", which is not a path inside the site.`,
        help: "A package input must be relative, with no .., environment file, .mizzen cache, or node_modules path.",
      });
      continue;
    }
    const problem = await pathProblem(realRoot, input.source);
    if (problem !== undefined) {
      diagnostics.push({
        id: "inputs.path-invalid",
        severity: "error",
        message: `Input "${input.id}" cannot be written: ${problem}.`,
        help: "Remove the link or folder at the destination, then import again.",
      });
      continue;
    }
    const destination = join(realRoot, input.source);
    const before = await readExisting(destination, maxInputBytes);
    if (before === "too-large") {
      diagnostics.push({
        id: "inputs.destination-too-large",
        severity: "error",
        message: `The file at ${input.source} is larger than the ${maxInputBytes} byte limit.`,
        help: "Remove the file, then import again.",
      });
      continue;
    }
    if (before !== undefined && sha256(before) !== input.sha256) {
      conflicts.push({ id: input.id, kind: "file", detail: `"${input.source}" already holds different content` });
    }
    locals.push({ input, destination, ...(before === undefined ? {} : { before }) });
  }

  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return { code: 1, diagnostics, messages, changed: [] };
  }

  const accepted = options.accept === "all" ? undefined : new Set(options.accept ?? []);
  const blocked = conflicts.filter((conflict) => accepted !== undefined && !accepted.has(conflict.id));
  for (const conflict of conflicts) {
    if (blocked.includes(conflict)) diagnostics.push(conflictDiagnostic(conflict));
    else messages.push(`accepted ${conflict.id}: ${conflict.detail}`);
  }
  if (blocked.length > 0) return { code: 1, diagnostics, messages, changed: [] };

  const changedInputs = new Set(conflicts.map((conflict) => conflict.id));
  const localChanges: LocalChange[] = [];
  const lockedChanges: LockedChange[] = [];

  for (const item of locals) {
    const differs = item.before === undefined || sha256(item.before) !== item.input.sha256;
    if (!differs) continue;
    changedInputs.add(item.input.id);
    localChanges.push({ ...item, staged: "" });
  }
  for (const item of locked) {
    const before = pinned.lock.sources[item.input.source];
    const sameLock =
      before !== undefined &&
      before.sha256 === item.entry.sha256 &&
      before.bytes === item.entry.bytes &&
      before.version === item.entry.version;
    if (!item.present || !sameLock) changedInputs.add(item.input.id);
    if (!item.present || !sameLock) lockedChanges.push(item);
  }

  if (changedInputs.size === 0) {
    messages.push(`already installed: ${pkg.manifest.inputs.length} inputs match; nothing changed`);
    return { code: 0, diagnostics, messages, changed: [] };
  }

  const metaDirectory = join(realRoot, ".mizzen");
  const meta = await lstat(metaDirectory).catch(() => undefined);
  if (meta !== undefined && (meta.isSymbolicLink() || !meta.isDirectory())) {
    return {
      code: 1,
      diagnostics: [
        ...diagnostics,
        { id: "inputs.path-invalid", severity: "error", message: `The .mizzen folder in ${realRoot} is not a folder.`, help: "Remove it, then import again." },
      ],
      messages,
      changed: [],
    };
  }
  await mkdir(metaDirectory, { recursive: true });
  const staging = await mkdtemp(join(metaDirectory, "inputs-stage-"));

  try {
    for (let index = 0; index < localChanges.length; index++) {
      const change = localChanges[index]!;
      const staged = join(staging, String(index));
      const content = pkg.blobs.get(change.input.sha256);
      if (content === undefined) {
        return {
          code: 1,
          diagnostics: [...diagnostics, { id: "inputs.package-invalid", severity: "error", message: `The package holds no content for ${change.input.sha256}.`, help: "Export the package again." }],
          messages,
          changed: [],
        };
      }
      await writeFile(staged, content);
      localChanges[index] = { ...change, staged };
    }

    const sources: Record<string, LockedSource> = { ...pinned.lock.sources };
    for (const change of lockedChanges) {
      const before = pinned.lock.sources[change.input.source];
      sources[change.input.source] =
        before !== undefined && before.sha256 === change.entry.sha256 && before.bytes === change.entry.bytes && before.version === change.entry.version
          ? before
          : change.entry;
    }
    const nextLock: DataLock = {
      version: 1,
      sources: sortedSources(sources),
      ...(pinned.lock.snapshots === undefined ? {} : { snapshots: pinned.lock.snapshots }),
    };
    const nextText = lockText(nextLock);
    let lockTextNow: string | undefined;
    try {
      lockTextNow = await readFile(join(realRoot, LOCK_FILE), "utf8");
    } catch {
      lockTextNow = undefined;
    }
    // A package of file inputs alone needs no lock; the build reads the files. A lock is written only when it gains
    // or changes a package or URL entry.
    const lockChanged = lockedChanges.length > 0 && lockTextNow !== nextText;

    const activated: { readonly destination: string; readonly before?: Uint8Array }[] = [];
    const createdStore: string[] = [];
    try {
      for (const change of lockedChanges) {
        if (change.present) continue;
        await mkdir(dirname(change.store), { recursive: true });
        const content = pkg.blobs.get(change.input.sha256);
        if (content === undefined) throw new Error(`the package holds no content for ${change.input.sha256}`);
        await writeAtomic(change.store, content);
        createdStore.push(change.store);
      }
      for (const change of localChanges) {
        await mkdir(dirname(change.destination), { recursive: true });
        await rename(change.staged, change.destination);
        activated.push({ destination: change.destination, ...(change.before === undefined ? {} : { before: change.before }) });
      }
      if (lockChanged) await writeAtomic(join(realRoot, LOCK_FILE), nextText);
    } catch (err) {
      for (const item of activated.reverse()) {
        if (item.before === undefined) await rm(item.destination, { force: true }).catch(() => undefined);
        else await writeAtomic(item.destination, item.before).catch(() => undefined);
      }
      for (const store of createdStore) await rm(store, { force: true }).catch(() => undefined);
      return {
        code: 1,
        diagnostics: [
          ...diagnostics,
          {
            id: "inputs.import-failed",
            severity: "error",
            message: `The input package stopped while being installed: ${err instanceof Error ? err.message : String(err)}.`,
            help: "Nothing is left half-installed; the previous inputs and lock are active. Fix the cause and import again.",
          },
        ],
        messages,
        changed: [],
      };
    }

    for (const change of localChanges) messages.push(`input ${change.input.id} -> ${change.input.source}`);
    for (const change of lockedChanges) messages.push(`input ${change.input.id} -> ${change.input.source} (stored)`);
    const changed = [...changedInputs].sort(compare);
    if (lockChanged) {
      messages.push(`wrote ${LOCK_FILE}`);
      changed.push(LOCK_FILE);
    }
    return { code: 0, diagnostics, messages, changed };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}
