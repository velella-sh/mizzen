import { createHash } from "node:crypto";
import { access, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { ThemeOverridesConfig } from "../contracts/config.ts";
import type { Diagnostic } from "../contracts/diagnostic.ts";
import { allowTypeScriptInPackages } from "../runtime/typescript-in-packages.ts";
import type { Chrome, Component, Layout } from "../contracts/render.ts";

/** What a theme's `src/index.ts` exports for discovery. */
export interface ThemeManifest {
  readonly name: string;
  readonly folders: readonly string[];
}

/** A layout loaded from `layouts/<name>.ts`. */
export interface RegisteredLayout {
  readonly name: string;
  readonly layout: Layout;
  /** Path relative to the theme root. */
  readonly file: string;
  /** Relative path of `layouts/<name>.css`, when present. */
  readonly css?: string;
}

/** A chrome part loaded from `chrome/<name>/index.ts`. */
export interface RegisteredChrome {
  readonly name: string;
  readonly chrome: Chrome;
  /** Path relative to the theme root. */
  readonly file: string;
  /** Relative path of `style.css`, when present. */
  readonly css?: string;
  /** Relative path of `client.ts`, when present. */
  readonly client?: string;
}

/** A component loaded from `components/<name>/index.ts`. */
export interface RegisteredComponent {
  readonly name: string;
  readonly component: Component;
  /** Path relative to the theme root. */
  readonly file: string;
  /** Optional Markdown directive name this component handles. */
  readonly directive?: string;
  /** Relative path of `style.css`, when present. */
  readonly css?: string;
  /** Relative path of `client.ts`, when present. */
  readonly client?: string;
}

/** Layouts, chrome, and components discovered from a theme folder. */
export interface ThemeRegistry {
  readonly theme: ThemeManifest;
  readonly layouts: Readonly<Record<string, RegisteredLayout>>;
  readonly chrome: Readonly<Record<string, RegisteredChrome>>;
  readonly components: Readonly<Record<string, RegisteredComponent>>;
  /** Shared stylesheets: `styles/*.css` when the manifest lists `styles`, as paths relative to the theme root, in path order. */
  readonly styles: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
}

const UNIT_FOLDERS = new Set(["layouts", "chrome", "components"]);

type UnitFolder = "layouts" | "chrome" | "components";
/** The folders a site module may replace; chrome and shared styles keep the theme's. */
type OverrideFolder = "layouts" | "components";

/** What a site may replace, and the root its module paths are relative to. */
export interface RegistryOptions {
  /** The site root. An override path is resolved against it and may not leave it. */
  readonly siteRoot?: string | undefined;
  /** Site modules that replace selected theme units. */
  readonly overrides?: ThemeOverridesConfig | undefined;
}

/**
 * The site module that replaces `folder/name`, when the config names one. A path that is absolute, leaves the site
 * root, or names no file is an error and leaves the theme's unit in place, so the build still publishes something.
 */
async function overrideModule(
  folder: OverrideFolder,
  name: string,
  options: RegistryOptions,
  diagnostics: Diagnostic[],
): Promise<{ abs: string; file: string } | undefined> {
  const raw = options.overrides?.[folder]?.[name];
  if (raw === undefined) return undefined;
  const setting = `theme.overrides.${folder}.${name}`;
  const root = options.siteRoot;
  if (root === undefined) {
    diagnostics.push(diagnostic("overrides.outside-site", `"${setting}" cannot be read without a site root.`));
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed === "" || isAbsolute(trimmed)) {
    diagnostics.push(
      diagnostic("overrides.outside-site", `"${setting}" must be a path relative to the site root, not "${raw}".`, "Write the module path relative to the site root, such as theme/doc.ts."),
    );
    return undefined;
  }
  const abs = resolve(root, trimmed);
  const rel = relative(root, abs);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    diagnostics.push(
      diagnostic("overrides.outside-site", `"${setting}" leaves the site root: "${raw}".`, "Keep the module inside the site."),
    );
    return undefined;
  }
  if (!(await exists(abs))) {
    diagnostics.push(
      diagnostic("overrides.missing-file", `"${setting}" names "${raw}", which does not exist.`, "Create the module or remove the override."),
    );
    return undefined;
  }
  const real = await realpath(abs).catch(() => undefined);
  const rootReal = await realpath(root).catch(() => undefined);
  if (real === undefined || rootReal === undefined || (real !== rootReal && !real.startsWith(`${rootReal}${sep}`))) {
    diagnostics.push(
      diagnostic("overrides.outside-site", `"${setting}" resolves outside the site root through a symbolic link: "${raw}".`, "Keep the module and every folder it goes through inside the site."),
    );
    return undefined;
  }
  return { abs, file: rel.split(sep).join("/") };
}

/** A site override's CSS sidecar, `<file>.css` beside the module; a replacement brings no client island. */
async function overrideCss(abs: string): Promise<string | undefined> {
  const css = abs.replace(/\.ts$/, ".css");
  return (await exists(css)) ? css : undefined;
}

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function fileUrl(path: string): string {
  return pathToFileURL(path).href;
}

/**
 * The entry module's URL, keyed by its current bytes.
 *
 * Node keeps a module for the life of the process, so a plain file URL would hand a watch rebuild the layout it
 * imported first. The `?v=<sha256>` the site plugin loader (`src/plugins/hooks.ts`) already uses makes changed bytes
 * a new module, while unchanged bytes resolve to the same URL and so reuse the module already imported. An installed
 * theme gets the same query: `allowTypeScriptInPackages` classifies the URL pathname, so a `.ts` entry under
 * `node_modules` still has its types stripped with the query attached.
 *
 * The boundary is the entry file only. A re-imported entry still resolves its own imports by their plain specifiers,
 * so an edit to a transitive module is not reloaded here; a general transitive resolver is outside the registry.
 */
async function entryUrl(abs: string): Promise<string> {
  const digest = createHash("sha256").update(await readFile(abs)).digest("hex");
  return `${fileUrl(abs)}?v=${digest}`;
}

function diagnostic(id: string, message: string, help?: string): Diagnostic {
  return help === undefined
    ? { id, severity: "error", message }
    : { id, severity: "error", message, help };
}

function isFunction(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === "function";
}

/** Loads a theme unit module by absolute path; returns the module or a diagnostic. */
async function importUnit(abs: string, rel: string): Promise<{ mod: Record<string, unknown> } | { diagnostic: Diagnostic }> {
  try {
    const mod = (await import(await entryUrl(abs))) as Record<string, unknown>;
    return { mod };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      diagnostic: diagnostic("registry.load-failed", `Failed to load "${rel}": ${detail}.`, "Fix the unit so Node can import it."),
    };
  }
}

async function sideFiles(themeRoot: string, folder: string, name: string): Promise<{ css?: string; client?: string }> {
  const cssRel = `${folder}/${name}/style.css`;
  const clientRel = `${folder}/${name}/client.ts`;
  const out: { css?: string; client?: string } = {};
  if (await exists(join(themeRoot, cssRel))) out.css = cssRel;
  if (await exists(join(themeRoot, clientRel))) out.client = clientRel;
  return out;
}

/**
 * Reads the theme manifest at `themeRoot/src/index.ts`, then discovers layouts,
 * chrome, and components by listing those folders. Duplicate names are errors.
 * Adding a unit never edits an index: a temporary folder is enough.
 */
export async function loadRegistry(themeRoot: string, options: RegistryOptions = {}): Promise<ThemeRegistry> {
  allowTypeScriptInPackages();
  const diagnostics: Diagnostic[] = [];
  const layouts: Record<string, RegisteredLayout> = {};
  const chrome: Record<string, RegisteredChrome> = {};
  const components: Record<string, RegisteredComponent> = {};
  const known: Record<UnitFolder, Set<string>> = { layouts: new Set(), chrome: new Set(), components: new Set() };

  const manifestPath = join(themeRoot, "src", "index.ts");
  const manifestRel = "src/index.ts";
  if (!(await exists(manifestPath))) {
    return {
      theme: { name: "", folders: [] },
      layouts,
      chrome,
      components,
      styles: [],
      diagnostics: [diagnostic("registry.missing-manifest", `Theme manifest not found at "${manifestRel}".`, "Export `theme` with `name` and `folders` from src/index.ts.")],
    };
  }

  const loaded = await importUnit(manifestPath, manifestRel);
  if ("diagnostic" in loaded) {
    return { theme: { name: "", folders: [] }, layouts, chrome, components, styles: [], diagnostics: [loaded.diagnostic] };
  }

  const raw = loaded.mod.theme;
  if (!raw || typeof raw !== "object") {
    return {
      theme: { name: "", folders: [] },
      layouts,
      chrome,
      components,
      styles: [],
      diagnostics: [diagnostic("registry.invalid-manifest", `Theme manifest in "${manifestRel}" must export \`theme\`.`, "Export `theme` with `name` and `folders`.")],
    };
  }

  const themeObj = raw as { name?: unknown; folders?: unknown };
  const name = typeof themeObj.name === "string" ? themeObj.name : "";
  const folders = Array.isArray(themeObj.folders) ? themeObj.folders.filter((f): f is string => typeof f === "string") : [];
  const theme: ThemeManifest = { name, folders };
  if (!name || folders.length === 0) {
    diagnostics.push(
      diagnostic("registry.invalid-manifest", `Theme manifest in "${manifestRel}" needs a non-empty name and folders list.`, "Export `theme` with `name` and `folders`."),
    );
  }

  const seenDirectives = new Map<string, string>();

  for (const folder of [...folders].sort(byCodePoint)) {
    if (!UNIT_FOLDERS.has(folder)) continue;
    const absFolder = join(themeRoot, folder);
    if (!(await exists(absFolder))) {
      diagnostics.push(diagnostic("registry.missing-folder", `Theme folder "${folder}/" listed in the manifest is missing.`));
      continue;
    }

    if (folder === "layouts") {
      const entries = await readdir(absFolder, { withFileTypes: true });
      const files = entries.filter((e) => e.isFile() && e.name.endsWith(".ts") && e.name.toLowerCase() !== "readme.ts").map((e) => e.name).sort(byCodePoint);
      for (const fileName of files) {
        const unitName = fileName.replace(/\.ts$/, "");
        known.layouts.add(unitName);
        const rel = `${folder}/${fileName}`;
        if (layouts[unitName]) {
          diagnostics.push(
            diagnostic("registry.duplicate-name", `Duplicate layout name "${unitName}" at "${rel}" (also "${layouts[unitName].file}").`, "Rename one of the layouts."),
          );
          continue;
        }
        const override = await overrideModule("layouts", unitName, options, diagnostics);
        const file = override?.file ?? rel;
        const imported = await importUnit(override?.abs ?? join(themeRoot, rel), file);
        if ("diagnostic" in imported) {
          diagnostics.push(
            override === undefined
              ? imported.diagnostic
              : diagnostic("overrides.invalid-export", imported.diagnostic.message, "Fix the site module's import or export."),
          );
          continue;
        }
        if (!isFunction(imported.mod.default)) {
          diagnostics.push(
            override === undefined
              ? diagnostic("registry.missing-default", `"${file}" must default-export a layout function.`, "Export the layout as `export default`.")
              : diagnostic("overrides.invalid-export", `"${file}" must default-export a layout function.`, "Export the layout as `export default`."),
          );
          continue;
        }
        const cssRel = `${folder}/${unitName}.css`;
        const css = override === undefined ? ((await exists(join(themeRoot, cssRel))) ? cssRel : undefined) : await overrideCss(override.abs);
        layouts[unitName] = {
          name: unitName,
          layout: imported.mod.default as Layout,
          file,
          ...(css === undefined ? {} : { css }),
        };
      }
      continue;
    }

    // chrome/ and components/: one folder per unit.
    const entries = await readdir(absFolder, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith(".") && !e.name.startsWith("_")).map((e) => e.name).sort(byCodePoint);
    for (const unitName of dirs) {
      known[folder as UnitFolder].add(unitName);
      const rel = `${folder}/${unitName}/index.ts`;
      const abs = join(themeRoot, rel);
      if (!(await exists(abs))) {
        diagnostics.push(
          diagnostic("registry.missing-default", `"${folder}/${unitName}/" has no index.ts.`, "Add index.ts with a default export."),
        );
        continue;
      }

      if (folder === "chrome" && chrome[unitName]) {
        diagnostics.push(
          diagnostic("registry.duplicate-name", `Duplicate chrome name "${unitName}" at "${rel}" (also "${chrome[unitName].file}").`, "Rename one of the chrome parts."),
        );
        continue;
      }
      if (folder === "components" && components[unitName]) {
        diagnostics.push(
          diagnostic("registry.duplicate-name", `Duplicate component name "${unitName}" at "${rel}" (also "${components[unitName].file}").`, "Rename one of the components."),
        );
        continue;
      }

      const override =
        folder === "components" ? await overrideModule("components", unitName, options, diagnostics) : undefined;
      const file = override?.file ?? rel;
      const imported = await importUnit(override?.abs ?? abs, file);
      if ("diagnostic" in imported) {
        diagnostics.push(
          override === undefined
            ? imported.diagnostic
            : diagnostic("overrides.invalid-export", imported.diagnostic.message, "Fix the site module's import or export."),
        );
        continue;
      }
      if (!isFunction(imported.mod.default)) {
        diagnostics.push(
          override === undefined
            ? diagnostic("registry.missing-default", `"${file}" must default-export a ${folder === "chrome" ? "chrome" : "component"} function.`, "Export the unit as `export default`.")
            : diagnostic("overrides.invalid-export", `"${file}" must default-export a ${folder === "chrome" ? "chrome" : "component"} function.`, "Export the unit as `export default`."),
        );
        continue;
      }

      const overrideSide = override === undefined ? undefined : await overrideCss(override.abs);
      const sides: { css?: string; client?: string } =
        override === undefined ? await sideFiles(themeRoot, folder, unitName) : overrideSide === undefined ? {} : { css: overrideSide };

      if (folder === "chrome") {
        const entry: RegisteredChrome = {
          name: unitName,
          chrome: imported.mod.default as Chrome,
          file,
          ...(sides.css !== undefined ? { css: sides.css } : {}),
          ...(sides.client !== undefined ? { client: sides.client } : {}),
        };
        chrome[unitName] = entry;
        continue;
      }

      let directive: string | undefined;
      if (typeof imported.mod.directive === "string") {
        directive = imported.mod.directive;
        const prior = seenDirectives.get(directive);
        if (prior !== undefined) {
          diagnostics.push(
            diagnostic("registry.duplicate-name", `Duplicate directive "${directive}" on component "${unitName}" (also "${prior}").`, "Give each component a unique directive name."),
          );
        } else {
          seenDirectives.set(directive, unitName);
        }
      }

      const entry: RegisteredComponent = {
        name: unitName,
        component: imported.mod.default as Component,
        file,
        ...(directive !== undefined ? { directive } : {}),
        ...(sides.css !== undefined ? { css: sides.css } : {}),
        ...(sides.client !== undefined ? { client: sides.client } : {}),
      };
      components[unitName] = entry;
    }
  }

  for (const folder of ["layouts", "components"] as const) {
    const map = options.overrides?.[folder];
    if (map === undefined) continue;
    for (const name of Object.keys(map).sort(byCodePoint)) {
      if (known[folder].has(name)) continue;
      diagnostics.push(
        diagnostic(
          "overrides.unknown-unit",
          `"theme.overrides.${folder}.${name}" names no ${folder === "layouts" ? "layout" : "component"} "${name}" in theme "${theme.name}".`,
          "Use the name of a unit the theme has, or remove the override.",
        ),
      );
    }
  }

  const styles: string[] = [];
  if (folders.includes("styles") && (await exists(join(themeRoot, "styles")))) {
    const entries = await readdir(join(themeRoot, "styles"), { withFileTypes: true });
    for (const e of entries) if (e.isFile() && e.name.endsWith(".css")) styles.push(`styles/${e.name}`);
    styles.sort(byCodePoint);
  }

  return { theme, layouts, chrome, components, styles, diagnostics };
}
