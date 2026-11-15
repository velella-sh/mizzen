/**
 * The pagination half of a list page: splits its rows into pages of `perPage`.
 *
 * A grouped list keeps each group whole, so a page can hold fewer than `perPage` rows and never repeats a group on two
 * pages; `splitGroups` lets a group cross a page boundary when the page asks for it. A list that fits on one page is
 * one page, and no empty page is ever made.
 */
import type { Grouping } from "./group.ts";

/** One page of a list: the rows it shows and the groups those rows belong to. */
export interface Slice<T> {
  readonly rows: readonly T[];
  readonly groups: readonly Grouping<T>[];
}

/** Splits rows into pages, keeping groups whole unless `splitGroups` is set. */
export function paginateRows<T>(
  rows: readonly T[],
  groups: readonly Grouping<T>[],
  perPage: number | undefined,
  splitGroups: boolean,
): Slice<T>[] {
  if (perPage === undefined || rows.length <= perPage) return [{ rows, groups }];

  const slices: Slice<T>[] = [];
  if (groups.length === 0 || splitGroups) {
    for (let start = 0; start < rows.length; start += perPage) {
      const pageRows = rows.slice(start, start + perPage);
      slices.push({
        rows: pageRows,
        groups:
          groups.length === 0
            ? []
            : groups
                .map((group) => ({ key: group.key, rows: group.rows.filter((row) => pageRows.includes(row)) }))
                .filter((group) => group.rows.length > 0),
      });
    }
    return slices;
  }

  let pageRows: T[] = [];
  let pageGroups: Grouping<T>[] = [];
  for (const group of groups) {
    if (pageRows.length > 0 && pageRows.length + group.rows.length > perPage) {
      slices.push({ rows: pageRows, groups: pageGroups });
      pageRows = [];
      pageGroups = [];
    }
    pageRows = [...pageRows, ...group.rows];
    pageGroups = [...pageGroups, group];
  }
  if (pageRows.length > 0) slices.push({ rows: pageRows, groups: pageGroups });
  return slices;
}
