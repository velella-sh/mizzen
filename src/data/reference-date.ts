/**
 * The reference date a list compares its date filters against, so no query reads the clock.
 *
 * `collections.<name>.referenceDate` is either a fixed date written `YYYY-MM-DD`, or the dot path of a value in `_data`
 * that holds one, such as `site.today`. When a collection sets none, the site's as-of date is used. A value that is not a
 * date is reported at the list that needed it.
 */
import type { CollectionConfig } from "../contracts/config.ts";
import { instantOf } from "./query.ts";
import { resolveIn, scalarText } from "./record-context.ts";

/** The reference date, or why the config value does not name one. */
export interface ReferenceDate {
  /** `YYYY-MM-DD`, the form `before` and `after` offsets are applied to. */
  readonly date?: string;
  /** A message naming a config value that is not a date. */
  readonly error?: string;
}

/** Reads a date or an instant as its `YYYY-MM-DD` date. */
function dateOnly(text: string): string | undefined {
  const instant = instantOf(text);
  if (instant === undefined) return undefined;
  return new Date(instant).toISOString().slice(0, 10);
}

/** Resolves one collection's reference date against the site's `_data`, falling back to the site's as-of date. */
export function referenceDateOf(
  collection: string,
  entry: CollectionConfig | undefined,
  data: Readonly<Record<string, unknown>>,
  siteAsOf?: string,
): ReferenceDate {
  const raw = entry?.referenceDate ?? siteAsOf;
  if (raw === undefined) return {};
  const fixed = dateOnly(raw);
  if (fixed !== undefined) return { date: fixed };
  const found = resolveIn(data, raw);
  const text = found.found ? scalarText(found.value) : undefined;
  const date = text === undefined ? undefined : dateOnly(text);
  if (date !== undefined) return { date };
  return {
    error: `\`collections.${collection}.referenceDate\` names "${raw}", which is neither a date nor a _data value that holds one.`,
  };
}
