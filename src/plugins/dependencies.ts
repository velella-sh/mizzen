/**
 * The cache inputs of a site's plugins (#604): each plugin declares the files it reads, its version, and the settings
 * that shape its output, and their digest is folded into the build's cache key. A build whose declarations and
 * declared file bytes are unchanged is a cache hit, so the plugins do not run again; any change to them misses.
 *
 * A plugin that lists no `inputs` cannot be tracked: the engine cannot see what it reads, so a site that lists one
 * builds cold. The same is true of a declaration the engine cannot honor, such as an absolute path or one that leaves
 * the site. `inputs: []` is the declaration that a plugin reads no file.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Plugin } from "../contracts/index.ts";
import { CODE_CONFIG_FILE } from "./hooks.ts";

/** A digest is never one of the markers, so a marker cannot stand in for real bytes. */
async function digestOf(path: string): Promise<string> {
  try {
    return createHash("sha256").update(await readFile(path)).digest("hex");
  } catch {
    return "missing";
  }
}

/** JSON with object keys sorted at every level, so two equal settings values hash the same. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The absolute path of a declared site-relative input, or `undefined` when it is absolute or leaves the site. */
function inputPath(root: string, declared: string): string | undefined {
  const path = resolve(root, declared);
  const rel = relative(root, path);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? undefined : path;
}

/**
 * SHA-256 of everything the site's plugins declare: the code file's bytes, then every plugin's name, order, version,
 * settings, and each declared input's path and bytes. Returns `undefined` when a plugin declares no `inputs`, or a
 * declaration cannot be read or is not a site-relative path, so the build must run cold.
 */
export async function pluginInputs(plugins: readonly Plugin[], root: string): Promise<string | undefined> {
  const site = resolve(root);
  try {
    const hash = createHash("sha256");
    hash.update("mizzen-plugins\0");
    // A code file that cannot load lists no plugins, so its own bytes are all this run can account for.
    hash.update(`code\0${await digestOf(join(site, CODE_CONFIG_FILE))}\0`);
    for (const plugin of plugins) {
      if (plugin.inputs === undefined) return undefined;
      if (!plugin.inputs.every((input) => typeof input === "string")) return undefined;
      hash.update(`plugin\0${plugin.name}\0${plugin.version ?? ""}\0${canonicalJson(plugin.settings)}\0`);
      // The order a plugin lists its files in is not an input; the order of the plugins themselves is.
      for (const input of [...new Set(plugin.inputs)].sort()) {
        const path = inputPath(site, input);
        if (path === undefined) return undefined;
        hash.update(`input\0${input}\0${await digestOf(path)}\0`);
      }
    }
    return hash.digest("hex");
  } catch {
    // A settings value JSON cannot represent is one more input this run cannot account for.
    return undefined;
  }
}
