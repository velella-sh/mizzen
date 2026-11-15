/**
 * What an invalid record does to a build. The default, `error`, fails the build; `skip` warns and builds the sound
 * records. Either way the record is left out of the site, and the build ends with one line counting what was left out,
 * so a skip is never silent.
 */
import type { CollectionConfig, Diagnostic } from "../contracts/index.ts";

/** The policy a collection without `onInvalid` gets. */
export const DEFAULT_INVALID_POLICY = "error" as const;

/** The policy a collection declares, with the default filled in. */
export function policyOf(config: CollectionConfig | undefined): "error" | "skip" {
  return config?.onInvalid === "skip" ? "skip" : DEFAULT_INVALID_POLICY;
}

/** One info finding at the end of a build when records were left out; `undefined` when none were. */
export function skippedSummary(count: number): Diagnostic | undefined {
  if (count <= 0) return undefined;
  return {
    id: "data.records-skipped",
    severity: "info",
    message: `Skipped ${count} ${count === 1 ? "record" : "records"} that failed validation.`,
    help: "Fix each record's finding, or set `collections.<name>.onInvalid: skip` to keep building without it.",
  };
}
