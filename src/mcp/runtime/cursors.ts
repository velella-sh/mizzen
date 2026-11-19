/**
 * Stable, snapshot-bound cursors for bounded answers. A cursor names the snapshot it was made in and a key over the
 * request that made it, so a resumed answer lists the same ordered work and a cursor from another snapshot is refused
 * instead of silently restarting at the first page.
 */
import { createHash } from "node:crypto";
import { McpError } from "../limits.ts";

interface CursorState {
  readonly v: 1;
  readonly s: string;
  readonly o: number;
  readonly k: string;
}

function keyOf(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

/** An opaque cursor for `offset` in `snapshot`, valid only for an identical request. */
export function encodeCursor(snapshot: string, offset: number, parts: readonly unknown[]): string {
  const state: CursorState = { v: 1, s: snapshot, o: offset, k: keyOf(parts) };
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
}

/** The offset a cursor names, or a clear refusal naming the snapshot it belongs to. */
export function decodeCursor(cursor: string, snapshot: string, parts: readonly unknown[]): number {
  let state: Partial<CursorState>;
  try {
    state = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<CursorState>;
  } catch {
    throw new McpError("bad-cursor", "The cursor is not one this server gave.");
  }
  if (state.v !== 1 || typeof state.s !== "string" || typeof state.o !== "number" || !Number.isInteger(state.o) || state.o < 0) {
    throw new McpError("bad-cursor", "The cursor is not one this server gave.");
  }
  if (state.s !== snapshot) {
    throw new McpError("stale-cursor", `The cursor belongs to snapshot ${state.s}; this session is on ${snapshot}. Re-run the request on the current snapshot.`, {
      retryable: true,
      stage: "read",
      data: { snapshot, previousSnapshot: state.s },
    });
  }
  if (state.k !== keyOf(parts)) {
    throw new McpError("bad-cursor", "The cursor belongs to a different request; repeat it with the same arguments.");
  }
  return state.o;
}
