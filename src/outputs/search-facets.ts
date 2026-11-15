import type { Site } from "../contracts/content.ts";
import type { Output, OutputFile } from "../contracts/output.ts";
import { byCodePoint, filterPlan, SEARCH_QUERY, searchableRecords } from "./search-shared.ts";

/** The file the theme reads the list of filter values from, at the site root. */
const FILE = "search-facets.json";

/** A counts map with its keys in code-point order, so two builds write the same bytes. */
function sortedCounts(values: Readonly<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of Object.keys(values).sort(byCodePoint)) out[value] = values[value]!;
  return out;
}

/**
 * Writes `search-facets.json`: the filter names and values the theme offers, with the number of record pages that hold
 * each value. The `collection` filter is always first, then every declared filter in code-point order. Labels and
 * translations are not written; the theme owns the words.
 *
 * The `query` object names the search results page's parameters, shared with `opensearch.xml`, so the theme and the
 * browser agree. A site with no record pages gets no file.
 */
export const searchFacets: Output = {
  name: "search-facets",
  async run(site: Site): Promise<readonly OutputFile[]> {
    if (site.config.search === false) return [];
    const records = searchableRecords(site);
    if (records.length === 0) return [];

    const plan = filterPlan(site, records, () => {});
    const filters: Record<string, Record<string, number>> = {
      collection: sortedCounts(plan.collection),
    };
    for (const { field, values } of plan.fields) filters[field] = sortedCounts(values);

    return [
      {
        path: FILE,
        contents: `${JSON.stringify({ query: SEARCH_QUERY, filters }, null, 2)}\n`,
      },
    ];
  },
};
