/**
 * The shape check for a configured SQLite query. It runs before a database file is opened, so an invalid config is
 * one config diagnostic and never a half-run extraction. A read query starts with `SELECT` or `WITH` and holds one
 * statement; the database is also opened read-only with `query_only`, which refuses anything this check misses.
 */

/** Why `query` is not one read statement, or `undefined` when it is. */
export function readQueryProblem(query: string): string | undefined {
  let rest = query;
  for (;;) {
    rest = rest.replace(/^\s+/, "");
    if (rest.startsWith("--")) {
      const end = rest.indexOf("\n");
      if (end < 0) return "the query holds only a comment";
      rest = rest.slice(end + 1);
      continue;
    }
    if (rest.startsWith("/*")) {
      const end = rest.indexOf("*/", 2);
      if (end < 0) return "the query has an unterminated comment";
      rest = rest.slice(end + 2);
      continue;
    }
    break;
  }
  const first = /^[A-Za-z]+/.exec(rest)?.[0]?.toUpperCase();
  if (first !== "SELECT" && first !== "WITH") {
    return "it must start with SELECT or WITH";
  }
  const body = rest.replace(/;\s*$/, "");
  if (body.includes(";")) return "it holds more than one statement";
  return undefined;
}
