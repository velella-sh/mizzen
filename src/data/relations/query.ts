/**
 * The `related` prop a record page or list row hands to a layout: {@link relationsOf} when the record has any, and no
 * property at all otherwise, so a site without configured relations gives the same props it gave before.
 */
import type { Collection, SiteConfig } from "../../contracts/index.ts";
import { relationsOf, type RecordRelations } from "./index.ts";

/** The `related` prop of one record, or an empty object when it has no resolved relations. */
export function relatedProps(
  collections: Readonly<Record<string, Collection>>,
  config: SiteConfig,
  collection: string,
  fields: Readonly<Record<string, unknown>>,
  lang: string,
): { readonly related?: RecordRelations } {
  const related = relationsOf(collections, config, collection, fields, lang);
  return Object.keys(related).length === 0 ? {} : { related };
}
