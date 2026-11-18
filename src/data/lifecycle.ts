/**
 * A record's place in a collection's lifecycle: the state its field holds, whether that state retires it, the record
 * that replaces it, and what its URL does. A record without the state field is published, so an older data file keeps
 * working unchanged. The function only reads fields; retirement itself is wired in by the pages and outputs.
 */
import type { CollectionLifecycleConfig, Diagnostic } from "../contracts/index.ts";

/** What a record's lifecycle fields say, with the findings from values that do not fit the config. */
export interface RecordLifecycle {
  /** The record's state, when its field holds a non-empty scalar. */
  readonly state: string | undefined;
  /** `true` when the state is one of the config's retired states. */
  readonly retired: boolean;
  /** The id the replacement field holds, when it holds one. */
  readonly replacementId: string | undefined;
  /** What the collection does with a retired record's URL. */
  readonly url: "retain" | "redirect";
  /** `true` when machine readers, such as the page JSON, see the record as retired. */
  readonly machine: boolean;
  /** Findings about the state and the replacement, in a stable order. */
  readonly diagnostics: readonly Diagnostic[];
}

/** A field's text: a non-empty string, or a number written as its decimal form. */
function scalarOf(value: unknown): string | undefined {
  if (typeof value === "string") return value === "" ? undefined : value;
  return typeof value === "number" ? String(value) : undefined;
}

/** A record's lifecycle, read from its fields and its collection's `lifecycle` block. */
export function lifecycleOf(
  fields: Readonly<Record<string, unknown>>,
  config: CollectionLifecycleConfig | undefined,
): RecordLifecycle {
  const field = config?.field ?? "state";
  const states = config?.states ?? [];
  const retiredStates = config?.retired ?? [];
  const replacementField = config?.replacement;
  const url = config?.url ?? "retain";
  const machine = config?.machine ?? false;

  const id = scalarOf(fields.id);
  const name = id === undefined ? "A record" : `Record "${id}"`;
  const raw = fields[field];
  const state = scalarOf(raw);
  const retired = state !== undefined && retiredStates.includes(state);
  const replacementId = replacementField === undefined ? undefined : scalarOf(fields[replacementField]);
  const diagnostics: Diagnostic[] = [];

  if (raw !== undefined && states.length > 0 && (state === undefined || !states.includes(state))) {
    diagnostics.push({
      id: "lifecycle.invalid-state",
      severity: "warning",
      message: `${name} has the lifecycle state "${String(raw)}", which is not one of: ${states.join(", ")}.`,
      help: `Set "${field}" to one of those states, or add this state to "lifecycle.states".`,
    });
  }
  if (retired && url === "redirect" && replacementField !== undefined && replacementId === undefined) {
    diagnostics.push({
      id: "lifecycle.replacement-missing",
      severity: "error",
      message: `${name} is retired and its URL redirects, but "${replacementField}" holds no id.`,
      help: `Set "${replacementField}" to the id of the record that replaces it, or set "lifecycle.url" to "retain".`,
    });
  }
  if (replacementId !== undefined && replacementId === id) {
    diagnostics.push({
      id: "lifecycle.replacement-self",
      severity: "error",
      message: `${name} names itself as its lifecycle replacement.`,
      help: `Set "${replacementField}" to another record's id.`,
    });
  }

  return { state, retired, replacementId, url, machine, diagnostics };
}

/** What a retired record's replacement field names: nothing, a record page, or an id that page list does not hold. */
export type Replacement =
  | { readonly kind: "none" }
  | { readonly kind: "found"; readonly url: string }
  | { readonly kind: "missing"; readonly id: string };

/**
 * Resolves a record's replacement id to the page URL of the record that holds it. The id is stable, so a replacement
 * whose slug, and so URL, changed still resolves; a self reference is `none`, since `lifecycleOf` already reports it.
 */
export function replacementOf(
  lifecycle: RecordLifecycle,
  id: string,
  urlOf: (id: string) => string | undefined,
): Replacement {
  const replacementId = lifecycle.replacementId;
  if (replacementId === undefined || replacementId === id) return { kind: "none" };
  const url = urlOf(replacementId);
  return url === undefined ? { kind: "missing", id: replacementId } : { kind: "found", url };
}
