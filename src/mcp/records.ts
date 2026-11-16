/** Helpers of the data tools. */

/** The names closest to `wanted`: those sharing its start or containing it, then alphabetical (at most five). */
export function closestNames(names: readonly string[], wanted: string): readonly string[] {
  const w = wanted.toLowerCase();
  const near = names.filter((n) => n.toLowerCase().includes(w) || w.includes(n.toLowerCase()));
  return [...(near.length > 0 ? near : names)].sort().slice(0, 5);
}
