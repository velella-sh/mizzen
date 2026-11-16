/**
 * Reads one built folder for `mizzen diff`: its manifest, and nothing else.
 *
 * The manifest names every page with its hashes and every file with its hash, so a comparison needs no other read
 * until it finds a difference. A folder without a readable manifest is a usage error, not a finding: there is nothing
 * to compare, and the fix is to build the site.
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { MANIFEST_PATH } from "../outputs/build-hash.ts";

/** A problem with the arguments of a diff: the command reports it and exits 2. */
export class DiffUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiffUsageError";
  }
}

/** One page entry of a manifest, as `schema/manifest.schema.json` defines it. */
export interface BuildPage {
  readonly url: string;
  readonly source: string;
  readonly title: string;
  readonly layout: string | null;
  readonly outputs: readonly string[];
  readonly hashes: { readonly source: string; readonly html: string };
  readonly view?: string;
}

/** A built folder, as far as its manifest tells. */
export interface Build {
  /** The folder, as an absolute path. It never appears in a report. */
  readonly dir: string;
  readonly hash: string;
  /** SHA-256 of every file, keyed by path relative to the folder. */
  readonly files: Readonly<Record<string, string>>;
  /** Pages sorted by URL. */
  readonly pages: readonly BuildPage[];
}

const HASH = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Compares by code point, never by locale. */
export function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Reads the page entry, or `undefined` when it is not one. */
function pageOf(value: unknown): BuildPage | undefined {
  if (!isRecord(value)) return undefined;
  const { url, source, title, layout, outputs, hashes, view } = value;
  if (typeof url !== "string" || typeof source !== "string" || typeof title !== "string") return undefined;
  if (layout !== null && typeof layout !== "string") return undefined;
  if (!Array.isArray(outputs) || !outputs.every((path) => typeof path === "string")) return undefined;
  if (!isRecord(hashes) || typeof hashes.source !== "string" || typeof hashes.html !== "string") return undefined;
  return {
    url,
    source,
    title,
    layout,
    outputs: [...(outputs as string[])].sort(byCodePoint),
    hashes: { source: hashes.source, html: hashes.html },
    ...(typeof view === "string" ? { view } : {}),
  };
}

/** Reads and checks `<dir>/.mizzen/manifest.json`; throws a {@link DiffUsageError} naming the folder as given. */
export async function readBuild(dir: string, label: string): Promise<Build> {
  const absolute = resolve(dir);
  let text: string;
  try {
    text = await readFile(join(absolute, MANIFEST_PATH), "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") {
      throw new DiffUsageError(`"${label}" has no ${MANIFEST_PATH}: build the site into it first.`);
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DiffUsageError(`"${label}": ${MANIFEST_PATH} is not valid JSON; rebuild the site.`);
  }
  const bad = (reason: string): DiffUsageError => new DiffUsageError(`"${label}": ${MANIFEST_PATH} is malformed: ${reason}; rebuild the site.`);
  if (!isRecord(parsed)) throw bad("not a JSON object");
  const build = parsed.build;
  if (!isRecord(build) || typeof build.hash !== "string" || !HASH.test(build.hash) || !isRecord(build.files)) {
    throw bad("it carries no build hash");
  }
  const files: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const path of Object.keys(build.files).sort(byCodePoint)) {
    const hash = build.files[path];
    if (typeof hash !== "string" || !HASH.test(hash)) throw bad("a file hash is not a SHA-256");
    files[path] = hash;
  }
  if (!Array.isArray(parsed.pages)) throw bad("pages is not a list");
  const pages: BuildPage[] = [];
  for (const entry of parsed.pages) {
    const page = pageOf(entry);
    if (page === undefined) throw bad("a page entry is incomplete");
    pages.push(page);
  }
  pages.sort((a, b) => byCodePoint(a.url, b.url));
  return { dir: absolute, hash: build.hash, files, pages };
}
