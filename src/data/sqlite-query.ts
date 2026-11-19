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
  let terminated = false;
  for (let index = 0; index < rest.length; index++) {
    const char = rest[index]!;
    if (char === "-" && rest[index + 1] === "-") {
      const end = rest.indexOf("\n", index + 2);
      index = end < 0 ? rest.length : end;
      continue;
    }
    if (char === "/" && rest[index + 1] === "*") {
      const end = rest.indexOf("*/", index + 2);
      if (end < 0) return "the query has an unterminated comment";
      index = end + 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      for (index += 1; index < rest.length; index++) {
        if (rest[index] !== char) continue;
        if (rest[index + 1] === char) index++;
        else break;
      }
      if (terminated) return "it holds more than one statement";
      continue;
    }
    if (char === "[") {
      const end = rest.indexOf("]", index + 1);
      index = end < 0 ? rest.length : end;
      if (terminated) return "it holds more than one statement";
      continue;
    }
    if (char === ";") {
      if (terminated) return "it holds more than one statement";
      terminated = true;
    } else if (terminated && !/\s/.test(char)) {
      return "it holds more than one statement";
    }
  }
  return undefined;
}
