/**
 * Detects moved pages and URLs that stopped answering.
 *
 * A removed page and an added page are one moved page only when they share a source file (and no other page in either
 * list shares it) or a record id; text that merely looks alike never pairs two pages. A move is reported with whether
 * the new build redirects the old URL. Every old URL that no file of the new build answers is listed as broken.
 */
import type { Build, BuildPage } from "./builds.ts";
import { byCodePoint } from "./builds.ts";
import { htmlOf, jsonOf } from "./pages.ts";
import type { Reader } from "./reader.ts";
import type { MovedPage } from "./types.ts";

export interface MoveResult {
  readonly moved: readonly MovedPage[];
  /** Removed pages that did not move. */
  readonly removed: readonly BuildPage[];
  /** Added pages that are not the target of a move. */
  readonly added: readonly BuildPage[];
  /** Old URLs of build A that build B no longer answers, sorted by code point. */
  readonly broken: readonly string[];
}

/** The path a URL's target names, without origin, query, or fragment; `undefined` when it is not a site path. */
function pathOf(target: string): string | undefined {
  try {
    const url = new URL(target, "https://site.invalid");
    return url.pathname;
  } catch {
    return undefined;
  }
}

/** Whether `/a/` and `/a` name the same address. */
function sameUrl(a: string, b: string): boolean {
  return a.replace(/\/$/u, "") === b.replace(/\/$/u, "");
}

/** Whether the file at the old page's address is a redirect to `to`. */
async function redirects(head: Build, reader: Reader, old: BuildPage, to: string): Promise<boolean> {
  const text = await reader.text(head, htmlOf(old));
  if (text === undefined) return false;
  const match = /http-equiv=["']refresh["'][^>]*content=["']\s*\d+\s*;\s*url=([^"']+)["']/iu.exec(text);
  if (match === null) return false;
  const target = pathOf((match[1] ?? "").replace(/&amp;/gu, "&"));
  return target !== undefined && sameUrl(target, to);
}

/** The identity of a record page: collection, id, and view, read from its page JSON. */
async function recordKey(build: Build, reader: Reader, page: BuildPage): Promise<string | undefined> {
  const json = await reader.json(build, jsonOf(page, build));
  const record = json?.record;
  if (typeof record !== "object" || record === null) return undefined;
  const { collection, id } = record as { collection?: unknown; id?: unknown };
  if (typeof collection !== "string" || typeof id !== "string") return undefined;
  return JSON.stringify([collection, id, page.view ?? ""]);
}

/** Pairs removed pages with added pages that share a source file, when exactly one of each shares it. */
function pairBySource(removed: readonly BuildPage[], added: readonly BuildPage[]): Map<BuildPage, BuildPage> {
  const removedBy = new Map<string, BuildPage[]>();
  const addedBy = new Map<string, BuildPage[]>();
  for (const page of removed) removedBy.set(page.source, [...(removedBy.get(page.source) ?? []), page]);
  for (const page of added) addedBy.set(page.source, [...(addedBy.get(page.source) ?? []), page]);
  const pairs = new Map<BuildPage, BuildPage>();
  for (const [source, olds] of removedBy) {
    const news = addedBy.get(source);
    if (olds.length === 1 && news?.length === 1) pairs.set(olds[0]!, news[0]!);
  }
  return pairs;
}

/** Finds the moved pages among the removed and added ones, and the URLs that now answer nothing. */
export async function findMoves(
  base: Build,
  head: Build,
  removed: readonly BuildPage[],
  added: readonly BuildPage[],
  reader: Reader,
): Promise<MoveResult> {
  const pairs = new Map<BuildPage, { to: BuildPage; by: "source" | "record" }>();
  for (const [from, to] of pairBySource(removed, added)) pairs.set(from, { to, by: "source" });

  const taken = (): Set<BuildPage> => new Set([...pairs.values()].map((pair) => pair.to));
  const looseOld = removed.filter((page) => !pairs.has(page));
  const looseNew = added.filter((page) => !taken().has(page));
  if (looseOld.length > 0 && looseNew.length > 0) {
    // Only now are page JSON files read, and only those of pages that have no partner yet.
    const keyed = new Map<string, BuildPage[]>();
    for (const page of looseNew) {
      const key = await recordKey(head, reader, page);
      if (key !== undefined) keyed.set(key, [...(keyed.get(key) ?? []), page]);
    }
    const oldKeyed = new Map<string, BuildPage[]>();
    for (const page of looseOld) {
      const key = await recordKey(base, reader, page);
      if (key !== undefined) oldKeyed.set(key, [...(oldKeyed.get(key) ?? []), page]);
    }
    for (const [key, olds] of oldKeyed) {
      const news = keyed.get(key);
      if (olds.length === 1 && news?.length === 1) pairs.set(olds[0]!, { to: news[0]!, by: "record" });
    }
  }

  const moved: MovedPage[] = [];
  const targets = taken();
  for (const from of removed) {
    const pair = pairs.get(from);
    if (pair === undefined) continue;
    moved.push({
      from: from.url,
      to: pair.to.url,
      source: pair.to.source,
      by: pair.by,
      redirect: await redirects(head, reader, from, pair.to.url),
      changed: from.hashes.source !== pair.to.hashes.source || from.hashes.html !== pair.to.hashes.html,
    });
  }
  moved.sort((a, b) => byCodePoint(a.from, b.from));

  const broken: string[] = [];
  for (const from of removed) {
    const file = htmlOf(from);
    if (file !== undefined && head.files[file] === undefined) broken.push(from.url);
  }
  broken.sort(byCodePoint);

  return {
    moved,
    removed: removed.filter((page) => !pairs.has(page)),
    added: added.filter((page) => !targets.has(page)),
    broken,
  };
}
