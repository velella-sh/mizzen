/**
 * The page counts a rebuild line ends with: ` (1 page rendered, 3030 reused)`. A build that reused no page (no render
 * cache, a cold cache, or the whole output restored) says nothing: the count is about what the cache saved.
 */
export function pageCounts(result: { readonly renderedPages: number; readonly cachedPages: number }): string {
  if (result.cachedPages === 0) return "";
  const noun = result.renderedPages === 1 ? "page" : "pages";
  return ` (${result.renderedPages} ${noun} rendered, ${result.cachedPages} reused)`;
}
