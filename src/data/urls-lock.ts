/**
 * `urls.lock.json`: every URL a record page has published, and every earlier URL that still points at it.
 *
 * The file is what turns a silent URL change into a build error. Each collection maps a record id to its current URL
 * and the URLs it had before, so a renamed record keeps its old address as a redirect, and a removed record keeps its
 * id and URL so a new record cannot quietly take the address over. Only `mizzen build --update-urls` writes it.
 *
 * It is canonical: object keys are sorted at every level, it uses LF line endings, and every field it lacks is left out
 * rather than written as a default, so an unchanged site writes the same bytes. It is validated against
 * `schema/urls.lock.schema.json` on every read; a missing file starts the check, and a malformed one is an error.
 */
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import type { CollectionConfig, Diagnostic, RecordPos } from "../contracts/index.ts";
import { recordSourcePos } from "./permalink.ts";
import { canonicalJson } from "./lock.ts";

/** The URL lock's file name at a site root. */
export const URLS_LOCK_FILE = "urls.lock.json";

/** One record's published addresses: where it lives now and where it lived before. */
export interface LockedUrl {
  /** The record page's current URL, including `base`. */
  readonly url: string;
  /** Earlier URLs, oldest first; each one redirects to `url`. */
  readonly previous: readonly string[];
  /** Present when the record is no longer in its collection: the id and URL are kept so a new record cannot take them. */
  readonly removed?: true;
}

/** The whole lock file. */
export interface UrlsLock {
  /** The format version; only 1 exists. */
  readonly version: 1;
  /** Record ids by collection, then by id. */
  readonly collections: Readonly<Record<string, Readonly<Record<string, LockedUrl>>>>;
}

/** An empty lock. */
export function emptyUrlsLock(): UrlsLock {
  return { version: 1, collections: {} };
}

// ajv is CommonJS: its default export is the class at run time, but its types name it.
const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;
const schema = JSON.parse(
  readFileSync(new URL("../../schema/urls.lock.schema.json", import.meta.url), "utf8"),
) as object;
const validateLock = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

/** True when `value` is a lock this version may trust. */
export function isUrlsLock(value: unknown): value is UrlsLock {
  return validateLock(value);
}

/** The lock file's text: canonical JSON and one trailing line feed. */
export function urlsLockText(lock: UrlsLock): string {
  return `${canonicalJson(lock)}\n`;
}

/** Reads the lock file at `root`; a missing file is an empty lock that the check has not started from. */
export async function readUrlsLock(
  root: string,
): Promise<{ readonly lock: UrlsLock; readonly found: boolean; readonly diagnostics: readonly Diagnostic[] }> {
  let text: string;
  try {
    text = await readFile(join(root, URLS_LOCK_FILE), "utf8");
  } catch {
    return { lock: emptyUrlsLock(), found: false, diagnostics: [] };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      lock: emptyUrlsLock(),
      found: true,
      diagnostics: [{
        id: "data.urls-lock-invalid",
        severity: "error",
        message: `${URLS_LOCK_FILE} is not valid JSON: ${detail}`,
        help: "Fix the file, or run `mizzen build --update-urls` to write it again.",
      }],
    };
  }
  if (!isUrlsLock(value)) {
    return {
      lock: emptyUrlsLock(),
      found: true,
      diagnostics: [{
        id: "data.urls-lock-invalid",
        severity: "error",
        message: `${URLS_LOCK_FILE} does not match schema/urls.lock.schema.json.`,
        help: "Fix the file, or run `mizzen build --update-urls` to write it again.",
      }],
    };
  }
  return { lock: value, found: true, diagnostics: [] };
}

/** Writes the lock file at `root`, canonical and ending in one LF. */
export async function writeUrlsLock(root: string, lock: UrlsLock): Promise<void> {
  await writeFile(join(root, URLS_LOCK_FILE), urlsLockText(lock));
}

/** One record page's URL in the model, as the lock check reads it. */
export interface PublishedUrl {
  readonly collection: string;
  readonly id: string;
  /** The current URL, including `base`. */
  readonly url: string;
  /** Where the record sits in its data file, for a finding about its URL. */
  readonly position: RecordPos;
}

/** A record whose URL changed from what the lock published. */
export interface UrlChange {
  readonly collection: string;
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly position: RecordPos;
}

/** A record the lock published that the collection no longer holds. */
export interface UrlRemoval {
  readonly collection: string;
  readonly id: string;
  /** Every URL it published: its last one and the earlier ones, oldest last. */
  readonly urls: readonly string[];
  /** What the collection's `onRemoved` says to do; `error` is the default once a lock exists. */
  readonly policy: "error" | "gone" | "redirect";
  /** Where readers go instead, for a `redirect` policy. */
  readonly target?: string;
}

/** What the lock check made of one build. */
export interface UrlsPlan {
  /** The lock to write with `--update-urls`: the current URLs, newest first in `previous`. */
  readonly next: UrlsLock;
  /** True when `urls.lock.json` exists, so the check has a baseline. */
  readonly locked: boolean;
  /** Record pages the check saw. */
  readonly checked: number;
  /** Records the lock did not hold. */
  readonly added: readonly PublishedUrl[];
  /** Records whose URL differs from the lock, whether or not `--update-urls` accepted the change. */
  readonly changed: readonly UrlChange[];
  /** Records the lock holds and the collection no longer does, whatever their policy. */
  readonly removed: readonly UrlRemoval[];
  /** Earlier URLs of each record page, keyed `collection<NUL>id`, for the redirects output. */
  readonly previous: Readonly<Record<string, readonly string[]>>;
  readonly diagnostics: readonly Diagnostic[];
}

/** Options of {@link planUrls}. */
export interface UrlsPlanOptions {
  readonly lock: UrlsLock;
  /** True when the lock file exists. Without it the check reports nothing: there is no published URL to protect. */
  readonly locked: boolean;
  readonly published: readonly PublishedUrl[];
  readonly config: Readonly<Record<string, CollectionConfig>>;
  /** Accept every current URL, moving a changed one into `previous`; `mizzen build --update-urls` sets this. */
  readonly update: boolean;
}

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The key earlier URLs are kept under for one record. */
export function urlKey(collection: string, id: string): string {
  return `${collection}\u0000${id}`;
}

/**
 * Compares every record page's URL with the lock. A new record is fine and counted; a changed URL is an error until
 * `--update-urls` accepts it and keeps the old one as a redirect; a record the collection no longer holds follows the
 * collection's `onRemoved` policy, and its id and URL stay in the lock. A site without a lock file is not checked.
 */
export function planUrls(options: UrlsPlanOptions): UrlsPlan {
  const diagnostics: Diagnostic[] = [];
  const next: Record<string, Record<string, LockedUrl>> = {};
  const previous: Record<string, readonly string[]> = {};
  const added: PublishedUrl[] = [];
  const changed: UrlChange[] = [];
  const removed: UrlRemoval[] = [];
  const current = new Map<string, PublishedUrl>();
  for (const entry of options.published) current.set(urlKey(entry.collection, entry.id), entry);

  for (const entry of options.published) {
    const collection = (next[entry.collection] ??= {});
    const before = options.lock.collections[entry.collection]?.[entry.id];
    const at = recordSourcePos(entry.position);
    if (before === undefined) {
      added.push(entry);
      collection[entry.id] = { url: entry.url, previous: [] };
      previous[urlKey(entry.collection, entry.id)] = [];
      continue;
    }

    if (before.removed === true && !options.update) {
      diagnostics.push({
        id: "urls.id-reused",
        severity: "error",
        message: `The record ${entry.collection}.${entry.id} takes the id of a record that was removed from ${JSON.stringify(before.url)}.`,
        pos: at,
        help: "Give the record another id, or run `mizzen build --update-urls` to publish it under that id.",
      });
      collection[entry.id] = before;
      previous[urlKey(entry.collection, entry.id)] = before.previous;
      continue;
    }

    if (before.removed === true || before.url !== entry.url) {
      if (!options.update) {
        changed.push({ collection: entry.collection, id: entry.id, from: before.url, to: entry.url, position: entry.position });
        diagnostics.push({
          id: "urls.url-changed",
          severity: "error",
          message: `The record ${entry.collection}.${entry.id} moved from ${JSON.stringify(before.url)} to ${JSON.stringify(entry.url)} without a redirect.`,
          pos: at,
          help: "Run `mizzen build --update-urls` to keep the old URL redirecting to the new one, or restore the old URL.",
        });
        collection[entry.id] = before;
        previous[urlKey(entry.collection, entry.id)] = before.previous;
        continue;
      }
      if (before.removed !== true && before.url !== entry.url) {
        changed.push({ collection: entry.collection, id: entry.id, from: before.url, to: entry.url, position: entry.position });
        diagnostics.push({
          id: "urls.url-updated",
          severity: "info",
          message: `Accepted the URL change of ${entry.collection}.${entry.id}: ${JSON.stringify(before.url)} now redirects to ${JSON.stringify(entry.url)}.`,
        });
      }
      const accepted: LockedUrl = {
        url: entry.url,
        previous: before.url === entry.url ? before.previous : [...before.previous, before.url],
      };
      collection[entry.id] = accepted;
      previous[urlKey(entry.collection, entry.id)] = accepted.previous;
      continue;
    }

    collection[entry.id] = before;
    previous[urlKey(entry.collection, entry.id)] = before.previous;
  }

  for (const name of Object.keys(options.lock.collections).sort(byCodePoint)) {
    const entry = options.config[name];
    if (entry === undefined) {
      // A collection the config no longer declares: its entries are kept and nothing is claimed about them.
      next[name] = options.lock.collections[name]!;
      continue;
    }
    for (const id of Object.keys(options.lock.collections[name]!).sort(byCodePoint)) {
      if (current.has(urlKey(name, id))) continue;
      const locked = options.lock.collections[name]![id]!;
      const urls = [locked.url, ...locked.previous];
      const policy = entry.onRemoved;
      const target = typeof policy === "object" ? policy.redirect : undefined;
      const kept: LockedUrl = { url: locked.url, previous: locked.previous, removed: true };
      (next[name] ??= {})[id] = kept;
      removed.push({
        collection: name,
        id,
        urls,
        policy: policy === "gone" ? "gone" : target === undefined ? "error" : "redirect",
        ...(target === undefined ? {} : { target }),
      });
      if (policy === "gone" || target !== undefined) continue;
      diagnostics.push({
        id: "urls.removed",
        severity: "error",
        message: `The record ${name}.${id} is no longer in the collection, and ${JSON.stringify(locked.url)} still points at it.`,
        help: `Add the record back, or set \`collections.${name}.onRemoved\` to \`gone\` or a redirect.`,
      });
    }
  }

  if (added.length > 0 && options.locked) {
    diagnostics.push({
      id: "urls.new-records",
      severity: "info",
      message: `The URL lock gained ${added.length} new record${added.length === 1 ? "" : "s"}.`,
      help: "Run `mizzen build --update-urls` to write them to urls.lock.json.",
    });
  }

  return {
    next: { version: 1, collections: next },
    locked: options.locked,
    checked: options.published.length,
    added,
    changed,
    removed,
    previous,
    diagnostics,
  };
}
