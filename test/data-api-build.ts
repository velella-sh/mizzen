/** Builds a real site with the data API for the tests that need the whole pipeline. */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Diagnostic } from "../src/contracts/index.ts";
import { build } from "../src/pipeline/build.ts";

const THEME = fileURLToPath(new URL("../../lateen", import.meta.url));

/** The files of a small site: two packages with an API over them. `extra` adds or replaces files; `api` is the `api:` block. */
export function apiSiteFiles(api: string[], extra: Record<string, string> = {}): Record<string, string> {
  return {
    "mizzen.yml": [
      "title: Example",
      "url: https://example.test",
      "base: /docs",
      "collections:",
      "  packages:",
      "    source: _data/packages.yml",
      "    template: _templates/package.md",
      "    permalink: /packages/{id}/",
      "    schema: schemas/packages.json",
      ...api,
      "",
    ].join("\n"),
    "_data/packages.yml": "- id: node\n  name: Node\n  eol: '2028-04-30'\n  secret: a\n- id: deno\n  name: Deno\n  eol: '2030-01-01'\n  secret: b\n",
    "schemas/packages.json": JSON.stringify({
      type: "object",
      required: ["name"],
      properties: { id: { type: "string" }, name: { type: "string" }, eol: { type: "string" }, secret: { type: "string" } },
    }),
    "_templates/package.md": "---\ntitle: Package\nlayout: doc\n---\n\n# Package\n",
    ...extra,
  };
}

/** Every file under `dir` as path to text, sorted by path. */
export function readTree(dir: string, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const name of readdirSync(join(dir, prefix)).sort()) {
    const path = prefix === "" ? name : `${prefix}/${name}`;
    if (statSync(join(dir, path)).isDirectory()) for (const [k, v] of readTree(dir, path)) out.set(k, v);
    else out.set(path, readFileSync(join(dir, path), "utf8"));
  }
  return out;
}

/** Builds the files and hands the output folder to `use`, then removes both folders. */
export async function withBuiltSite<T>(
  files: Record<string, string>,
  use: (out: string, diagnostics: readonly Diagnostic[]) => Promise<T> | T,
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "api-site-"));
  const out = mkdtempSync(join(tmpdir(), "api-out-"));
  try {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    const result = await build({ root, out, themeRoot: THEME, defaultLayout: "doc" });
    return await use(out, result.diagnostics);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
}
