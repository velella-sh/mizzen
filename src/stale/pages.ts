/**
 * Finds the pages that name the files they describe and hashes those files as they are now. It reads front matter
 * straight from the source files and never builds the site, so `mizzen stale` stays fast and has no side effects.
 *
 * A page is identified by its source path relative to the site root (`docs/guide.md`), the same key the review lock
 * uses. Only a page's own front matter counts: `covers` from `defaults` is not read.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadConfig } from "../config/load.ts";
import { discover, MARKDOWN } from "../content/discover.ts";
import { parseFrontMatter } from "../content/frontmatter.ts";
import type { Diagnostic } from "../contracts/index.ts";
import { coversLine, expandCovers } from "./covers.ts";
import { hashFiles, type FileHash } from "./hash.ts";

/** One page with `covers`, as the files are now. */
export interface CoveredPage {
  /** Source path relative to the site root, `/`-separated. */
  readonly page: string;
  /** The `covers` patterns as written; empty when the value is not a list of strings. */
  readonly covers: readonly string[];
  /** 1-based line of the `covers` key in the page's source. */
  readonly line: number;
  /** The covered files and their current hashes, sorted by path. */
  readonly files: readonly FileHash[];
  /** Problems with `covers` or the covered files. */
  readonly diagnostics: readonly Diagnostic[];
}

/** What {@link loadCoveredPages} returns. */
export interface LoadedCoveredPages {
  /** Pages with `covers`, sorted by `page`. */
  readonly pages: readonly CoveredPage[];
  /** The absolute folder `covers` paths are relative to. */
  readonly coversRoot: string;
  /** Config errors, which stop the command. */
  readonly errors: readonly string[];
  /** The configured severity of a stale page. */
  readonly severity: "info" | "warning" | "error";
}

/** Loads every page with `covers` in the site at `root` and hashes its files. */
export async function loadCoveredPages(root: string): Promise<LoadedCoveredPages> {
  const siteRoot = resolve(root);
  const loaded = loadConfig(siteRoot);
  const errors = loaded.diagnostics.filter((d) => d.severity === "error").map((d) => d.message);
  const config = loaded.config;
  const coversRoot = resolve(siteRoot, config.stale?.root ?? ".");
  const severity = config.stale?.severity ?? "warning";
  if (errors.length > 0) return { pages: [], coversRoot, errors, severity };

  const sourceDir = resolve(siteRoot, config.source);
  const prefix = config.source === "." || config.source === "" ? "" : `${config.source.replace(/\\/g, "/").replace(/\/+$/, "")}/`;
  // A missing source folder is the build's finding (doctor.source-missing), not this command's: it has no pages.
  if (!existsSync(sourceDir)) return { pages: [], coversRoot, errors, severity };
  const files = await discover(sourceDir, { include: config.include, exclude: config.exclude });
  const pages: CoveredPage[] = [];
  for (const file of files) {
    if (file.kind !== "doc" || !MARKDOWN.test(file.path)) continue;
    const text = await readFile(join(sourceDir, file.path), "utf8");
    const fm = parseFrontMatter(text, `${prefix}${file.path}`);
    if (!("covers" in fm.data)) continue;
    const page = `${prefix}${file.path}`.replace(/^\.\//, "");
    const expanded = await expandCovers({ covers: fm.data.covers, root: coversRoot, file: page, line: coversLine(text) });
    const hashed = await hashFiles(expanded.files, { root: coversRoot, file: page });
    pages.push({ page, covers: Array.isArray(fm.data.covers) && fm.data.covers.every((c) => typeof c === "string") ? (fm.data.covers as string[]).map((c) => c.trim()) : [], line: coversLine(text), files: hashed.hashes, diagnostics: [...expanded.diagnostics, ...hashed.diagnostics] });
  }
  pages.sort((a, b) => (a.page < b.page ? -1 : a.page > b.page ? 1 : 0));
  return { pages, coversRoot, errors, severity };
}
