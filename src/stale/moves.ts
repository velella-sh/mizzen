/**
 * Tells a moved file from a changed one. A covered file that is gone from its path is a move when exactly one other
 * file in the covers root has the same hash and is not already covered under the page's locked paths. Files are
 * matched by content, never by name: a moved file that was edited has a new hash and stays a removal, and a copy
 * leaves the old path in place, so nothing was removed.
 */
import { listFiles } from "./covers.ts";
import { hashFiles, MAX_COVERED_BYTES, type FileHash } from "./hash.ts";

/** The most files looked at when searching for a moved file. */
export const MAX_MOVE_CANDIDATES = 5000;

/** One file that moved. */
export interface FileMove {
  readonly from: string;
  readonly to: string;
}

/**
 * Pairs each removed file with the one candidate that has its hash. `candidates` are the files that could be the new
 * home; a hash held by two candidates is ambiguous and pairs with neither.
 */
export function matchMoves(removed: readonly FileHash[], candidates: readonly FileHash[]): FileMove[] {
  const byHash = new Map<string, string[]>();
  for (const c of candidates) byHash.set(c.sha256, [...(byHash.get(c.sha256) ?? []), c.path]);
  const taken = new Set<string>();
  const moves: FileMove[] = [];
  for (const r of [...removed].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const found = byHash.get(r.sha256);
    if (found?.length !== 1 || taken.has(found[0]!)) continue;
    taken.add(found[0]!);
    moves.push({ from: r.path, to: found[0]! });
  }
  return moves;
}

/** Hashes the files under `root` that a moved file could now be, leaving out `exclude` and anything too large. */
export async function moveCandidates(root: string, exclude: ReadonlySet<string>): Promise<readonly FileHash[]> {
  const paths = (await listFiles(root)).filter((p) => !exclude.has(p)).slice(0, MAX_MOVE_CANDIDATES);
  const { hashes } = await hashFiles(paths, { root, file: "", maxFiles: MAX_MOVE_CANDIDATES, maxBytes: MAX_COVERED_BYTES });
  return hashes;
}
