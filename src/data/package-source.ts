/**
 * `npm:<package>/<path>` collection sources: a file inside an installed dependency, read from the site's
 * `node_modules`. Nothing is installed, nothing is fetched, and the resolved file must stay inside the package folder
 * even through a symbolic link.
 */
import { access, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type { Diagnostic } from "../contracts/index.ts";

/** A resolved `npm:` source. */
export interface NpmSource {
  /** The address as the config writes it. */
  readonly address: string;
  /** The package name, scope included. */
  readonly name: string;
  /** The file's path inside the package, `/`-separated. */
  readonly subpath: string;
  /** The installed version from the package's own `package.json`. */
  readonly version: string;
  /** Absolute path of the file. */
  readonly file: string;
  /** The file's path relative to the site root, for diagnostics and positions. */
  readonly display: string;
}

/** What resolving one address found. */
export interface NpmSourceResult {
  /** The resolved source, absent when a diagnostic explains why. */
  readonly source?: NpmSource;
  /** The one problem that stopped resolution. */
  readonly diagnostic?: Diagnostic;
}

/** True for an address in the `npm:` form. */
export function isNpmSource(address: string): boolean {
  return address.startsWith("npm:");
}

/**
 * Splits `npm:<package>/<path>` into its package name and file path; `undefined` for a malformed address or a path
 * that leaves the package before the filesystem is touched.
 */
export function splitNpmAddress(address: string): { readonly name: string; readonly subpath: string } | undefined {
  if (!isNpmSource(address)) return undefined;
  const rest = address.slice("npm:".length);
  const parts = rest.split("/").filter((part) => part !== "");
  const scoped = rest.startsWith("@");
  if (parts.length < (scoped ? 3 : 2)) return undefined;
  const name = scoped ? `${parts[0]}/${parts[1]}` : parts[0]!;
  const subpath = parts.slice(scoped ? 2 : 1).join("/");
  if (subpath === "" || isAbsolute(subpath) || subpath.split("/").some((part) => part === ".." || part === ".")) {
    return undefined;
  }
  return { name, subpath };
}

/** True when `child` is inside `parent` or is `parent` itself. */
function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** The absolute file a valid `npm:` address names, before resolving links; `undefined` for a malformed address. */
export function npmSourcePath(root: string, address: string): string | undefined {
  const split = splitNpmAddress(address);
  if (split === undefined) return undefined;
  return join(root, "node_modules", split.name, split.subpath);
}

/**
 * Resolves an `npm:` source from `root/node_modules`. A malformed address, a missing package or file, a missing
 * version, and a file that resolves outside the package through a link each come back as one diagnostic.
 */
export async function resolveNpmSource(root: string, address: string): Promise<NpmSourceResult> {
  const split = splitNpmAddress(address);
  if (split === undefined) {
    return {
      diagnostic: {
        id: "data.package-bad-address",
        severity: "error",
        message: `"${address}" is not an npm source; write npm:<package>/<path>.`,
        help: "A package source names an installed package and a file inside it, such as npm:acme-data/items.yml.",
      },
    };
  }

  const packageDir = join(root, "node_modules", split.name);
  let packageReal: string;
  try {
    packageReal = await realpath(packageDir);
  } catch {
    return {
      diagnostic: {
        id: "data.package-missing",
        severity: "error",
        message: `Package "${split.name}" is not installed in ${join(root, "node_modules")}.`,
        help: `Install "${split.name}", then run \`mizzen data fetch\` to pin the collection.`,
      },
    };
  }

  let version: string;
  try {
    const manifest = JSON.parse(await readFile(join(packageReal, "package.json"), "utf8")) as { version?: unknown };
    if (typeof manifest.version !== "string" || manifest.version === "") throw new Error("no version");
    version = manifest.version;
  } catch {
    return {
      diagnostic: {
        id: "data.package-version",
        severity: "error",
        message: `Package "${split.name}" has no readable version in its package.json.`,
        help: "Install a published version of the package.",
      },
    };
  }

  const requested = join(packageDir, split.subpath);
  let fileReal: string;
  try {
    fileReal = await realpath(requested);
  } catch {
    return {
      diagnostic: {
        id: "data.package-path-missing",
        severity: "error",
        message: `Package "${split.name}" has no file "${split.subpath}".`,
        help: "Check the path in the collection's `source`.",
      },
    };
  }

  // A link inside the package may point anywhere; only a real path inside the package is a package file.
  if (!inside(packageReal, fileReal)) {
    return {
      diagnostic: {
        id: "data.package-escape",
        severity: "error",
        message: `"${address}" resolves outside package "${split.name}" through a symbolic link.`,
        help: "Point the collection at a file the package itself contains.",
      },
    };
  }

  try {
    await access(fileReal);
  } catch {
    return {
      diagnostic: {
        id: "data.package-path-missing",
        severity: "error",
        message: `Package "${split.name}" has no readable file "${split.subpath}".`,
        help: "Check the path in the collection's `source`.",
      },
    };
  }

  return {
    source: {
      address,
      name: split.name,
      subpath: split.subpath,
      version,
      file: fileReal,
      display: `node_modules/${split.name}/${split.subpath}`,
    },
  };
}
