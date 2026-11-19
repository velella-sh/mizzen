/**
 * Shared validation helpers for the interaction functions.
 *
 * Every function returns a new session and an empty problem list, or no session and every reason
 * the request was refused. Nothing is mutated and nothing is guessed: a value that is not a
 * non-empty trimmed string, or not the expected hash, is named with its JSON Pointer.
 */
import type { InteractionProblem, InteractionSession } from "../contracts/interaction.ts";

/** What one interaction function returns. */
export interface InteractionResult {
  /** The new session; present exactly when `problems` is empty. */
  readonly session?: InteractionSession;
  /** Why the request was refused; empty on success. */
  readonly problems: readonly InteractionProblem[];
}

/** A successful result with the next session. */
export function succeeded(session: InteractionSession): InteractionResult {
  return { session, problems: [] };
}

/** A refused result with one problem. */
export function failed(path: string, code: string, message: string): InteractionResult {
  return { problems: [{ path, code, message }] };
}

/** A refused result with every problem found. */
export function refused(problems: readonly InteractionProblem[]): InteractionResult {
  return { problems };
}

/** The trimmed text of a string, or `""` for anything that is not a string. */
export function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** True for a 64-character lowercase SHA-256 digest. */
export function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/** True when a path is site-relative, slash-separated, and stays inside the site. */
export function relativeFile(path: string): boolean {
  return (
    path !== "" &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.split("/").includes("..")
  );
}

/** The id of a document or error, for a message that names it. */
export function quoted(value: string): string {
  return value === "" ? "an empty value" : `\`${value}\``;
}

/** The one problem a missing or empty text field produces. */
export function emptyProblem(path: string, label: string): InteractionProblem {
  return {
    path,
    code: "interaction.empty",
    message: `${label} cannot be empty; give it a non-empty value.`,
  };
}
