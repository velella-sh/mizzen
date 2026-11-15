/**
 * Temporary data sites for the data-schema tests: a folder of files in, the loaded collections out. The folder is
 * removed before the test sees the result, so everything a test reads is already in memory.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "../src/config/load.ts";
import { loadCollections, type CollectionsResult } from "../src/data/collections.ts";

/** A temporary folder holding `files`. */
export function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "data-schema-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** Loads a temporary site and removes it; a config finding is a test bug, so it fails the test. */
export async function loadSite(files: Record<string, string>): Promise<CollectionsResult> {
  const root = tree(files);
  try {
    const { config, diagnostics } = loadConfig(root);
    if (diagnostics.length > 0) {
      throw new Error(`config findings: ${diagnostics.map((diagnostic) => `${diagnostic.id}: ${diagnostic.message}`).join("; ")}`);
    }
    return await loadCollections({ root, config });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The ids of the findings, in report order. */
export function idsOf(result: CollectionsResult): string[] {
  return result.diagnostics.map((diagnostic) => diagnostic.id);
}
