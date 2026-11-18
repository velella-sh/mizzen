/** Shared setup for the input package tests: a temporary copy of the fixture and one export. */
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config/load.ts";
import { exportInputs, type ExportInputsResult } from "../src/inputs/export.ts";

/** The input package fixture. */
export const FIXTURE = fileURLToPath(new URL("../fixtures/input-pack/", import.meta.url));

/** The Lateen checkout beside this repository, used by build tests. */
export const THEME = fileURLToPath(new URL("../../lateen", import.meta.url));

/** A temporary folder the caller removes. */
export function scratch(prefix = "input-pack-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Writes files under `root`, creating their folders. */
export function writeFiles(root: string, files: Readonly<Record<string, string>>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

/** Copies the fixture under `parent`; `data: false` leaves `_data` out, as a fresh checkout would. */
export function copySite(parent: string, options: { readonly data?: boolean } = {}): string {
  const root = join(parent, "site");
  cpSync(FIXTURE, root, {
    recursive: true,
    filter: (source) =>
      options.data === false ? !source.split(/[\\/]/).includes("_data") : true,
  });
  return root;
}

/** Exports the fixture copy at `root` to `file` with the loaded config. */
export async function exportTo(
  root: string,
  file: string,
  collections?: readonly string[],
): Promise<ExportInputsResult> {
  const loaded = loadConfig(root);
  const errors = loaded.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) throw new Error(`config: ${errors.map((error) => error.message).join("; ")}`);
  return exportInputs({
    root,
    config: loaded.config,
    out: file,
    ...(collections === undefined ? {} : { collections }),
  });
}
