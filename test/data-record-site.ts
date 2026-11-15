import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildModel, type ModelResult } from "../src/model/build.ts";

/** A temporary site from a path-to-text map. */
export function site(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "data-pages-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** Builds a site and removes its folder after the callback. */
export async function withSite(
  files: Readonly<Record<string, string>>,
  run: (root: string, result: ModelResult) => Promise<void> | void,
): Promise<void> {
  const root = site(files);
  try {
    await run(root, await buildModel(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The diagnostic ids, in order. */
export function ids(result: ModelResult): string[] {
  return result.diagnostics.map((diagnostic) => diagnostic.id);
}

/** A record page by URL. */
export function pageAt(result: ModelResult, url: string) {
  return result.site.pages.find((page) => page.url === url);
}
