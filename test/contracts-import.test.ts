import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { version } from "../src/index.ts";

const PACKAGE = fileURLToPath(new URL("../", import.meta.url));
const DIST = join(PACKAGE, "dist");
const TSC = join(PACKAGE, "node_modules", "typescript", "bin", "tsc");
const SOURCE = new Set([".ts", ".js", ".mjs"]);
const SPECIFIER = /\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

interface Manifest {
  readonly version: string;
  readonly files: readonly string[];
  readonly exports: Readonly<Record<string, string | { readonly types: string; readonly default: string }>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}

const manifest = JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8")) as Manifest;

/** Builds the package the way `npm pack` does, so every test here reads the artifact a consumer installs. */
before(() => {
  rmSync(DIST, { recursive: true, force: true });
  execFileSync(process.execPath, [TSC, "-p", join(PACKAGE, "tsconfig.build.json")], { cwd: PACKAGE, stdio: "pipe" });
});

/** Imports a package entry point by name, so Node resolves it through package.json "exports". */
function importEntry(specifier: string): Promise<Record<string, unknown>> {
  return import(specifier);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (SOURCE.has(extname(entry.name))) out.push(path);
  }
  return out;
}

test("the packed entry points export version and the contracts, and nothing else", async () => {
  const entry = await importEntry("@velella/mizzen");
  assert.deepEqual(Object.keys(entry), ["version"]);
  assert.equal(entry.version, manifest.version);

  const contracts = await importEntry("@velella/mizzen/contracts");
  assert.deepEqual(Object.keys(contracts), [], "the contracts entry is types only");

  for (const file of ["index.js", "contracts/index.js"]) {
    const text = readFileSync(join(DIST, file), "utf8");
    assert.doesNotMatch(text, /\b(?:from|import)\s*\(?\s*["']/, `${file} pulls no internal module into the API`);
  }
});

test("a consumer typechecks against the built entry points", () => {
  const consumer = join(PACKAGE, ".contracts-consumer.ts");
  writeFileSync(
    consumer,
    `import { version } from "@velella/mizzen";
import type {
  AnalyticsConfig, ApiConfig, CalendarConfig, CalendarLink, ChangeEvent, Chrome, Collection, CollectionSnapshot,
  Component, DataRecord, DatesConfig, Diagnostic, Head, Layout, ListProps, NetworkConfig, Output, Page, PageRecord,
  PageStale, Plugin, RecordPos, RecordProps, ScriptTag, Site, SiteConfig, SiteNetwork, SnapshotConfig, SocialConfig,
  SourcePos, StaleConfig,
} from "@velella/mizzen/contracts";

export const engine: string = version;
export type Surface = [SourcePos, Diagnostic, SiteConfig, Page, Site, Output, Plugin, Layout, Chrome, Component];
export type Data = [Collection, DataRecord, RecordPos, PageRecord, RecordProps, ListProps];
export type Publishing = [ApiConfig, CalendarConfig, CalendarLink, ChangeEvent, CollectionSnapshot, DatesConfig,
  SnapshotConfig, SocialConfig, StaleConfig, PageStale, AnalyticsConfig, NetworkConfig, SiteNetwork, ScriptTag,
  Head["scripts"]];
`,
  );
  try {
    execFileSync(
      process.execPath,
      [
        TSC, "--ignoreConfig", "--noEmit", "--strict", "--target", "esnext", "--module", "nodenext",
        "--moduleResolution", "nodenext", "--skipLibCheck", "--types", "node", consumer,
      ],
      { cwd: PACKAGE, stdio: "pipe" },
    );
  } finally {
    rmSync(consumer, { force: true });
  }
});

test("package.json exposes only the two public entries and the manifest, all built", () => {
  assert.deepEqual(Object.keys(manifest.exports).sort(), [".", "./contracts", "./package.json"].sort());
  assert.ok(manifest.files.includes("dist"), "dist is packed");
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    if (subpath === "./package.json") {
      assert.equal(target, "./package.json");
      continue;
    }
    assert.equal(typeof target, "object", `${subpath} names its types and module`);
    const { types, default: module } = target as { types: string; default: string };
    assert.match(types, /^\.\/dist\/.+\.d\.ts$/, `${subpath} types come from dist`);
    assert.match(module, /^\.\/dist\/.+\.js$/, `${subpath} runtime comes from dist`);
    assert.ok(existsSync(join(PACKAGE, types)), `${types} exists after a build`);
    assert.ok(existsSync(join(PACKAGE, module)), `${module} exists after a build`);
  }
});

test("source, package, and lockfile identify the same engine version", () => {
  const lock = JSON.parse(readFileSync(join(PACKAGE, "package-lock.json"), "utf8"));
  assert.equal(version, manifest.version);
  assert.equal(lock.version, version);
  assert.equal(lock.packages[""].version, version);
});

test("the tarball lists every schema, including the 0.2.0 schemas and every docs reference", () => {
  const [packed] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
    cwd: PACKAGE,
    encoding: "utf8",
    shell: process.platform === "win32",
    maxBuffer: 4 * 1024 * 1024,
  })) as { files: { path: string }[] }[];
  assert.ok(packed, "npm pack returned a file list");
  const paths = new Set(packed.files.map((file) => file.path));
  const legacy = [
    "config", "context-pack", "context-request", "diagnostics", "drift", "edit-audit",
    "front-matter", "manifest", "review-coverage", "sourcemap", "trust",
  ];
  for (const name of legacy) assert.ok(paths.has(`schema/${name}.schema.json`), `0.2.0 schema: ${name}`);
  for (const name of readdirSync(join(PACKAGE, "schema"))) {
    if (name.endsWith(".json")) assert.ok(paths.has(`schema/${name}`), `unpacked schema: ${name}`);
  }
  const site = join(PACKAGE, "site");
  for (const path of readdirSync(site, { recursive: true }) as string[]) {
    if (!path.endsWith(".md")) continue;
    for (const [reference] of readFileSync(join(site, path), "utf8").matchAll(/\bschema\/[\w.-]+\.json\b/g)) {
      assert.ok(paths.has(reference), `${path} references an unpacked schema: ${reference}`);
    }
  }
});

test("the packed package imports no theme and declares no theme dependency", () => {
  const bad: string[] = [];
  for (const file of walk(DIST)) {
    for (const match of readFileSync(file, "utf8").matchAll(SPECIFIER)) {
      const specifier = match[1] ?? "";
      if (/(^|\/)lateen(\/|$)/i.test(specifier)) bad.push(`${file.slice(PACKAGE.length)}: ${specifier}`);
    }
  }
  assert.deepEqual(bad, []);
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      assert.doesNotMatch(name, /lateen|theme/i, `package.json ${field} names no theme`);
    }
  }
});
