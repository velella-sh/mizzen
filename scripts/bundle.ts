// Packages a built preview: `node scripts/bundle.ts <outputDir> <bundleDir>`.
// A bundle holds the output's files under `files/` and a `bundle.json` that names the base and build hash they belong to.
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { byCodePoint, fingerprint } from "../src/outputs/build-hash.ts";

/** Where the build writes its manifest, relative to the output folder. */
const MANIFEST = ".mizzen/manifest.json";

/** What `bundle` writes to `<bundleDir>/bundle.json`. */
export interface Bundle {
  /** The site base path the output was built for; `""` at a domain root. */
  readonly base: string;
  /** SHA-256 of the whole build, as the manifest recorded it or the fingerprint computed it. */
  readonly buildHash: string;
  /** SHA-256 of each packaged file's bytes, keyed by its path relative to `files/`, sorted by code point. */
  readonly files: Record<string, string>;
}

/**
 * Copies a preview output's files into `<bundleDir>/files/` and writes `<bundleDir>/bundle.json` naming the base, the
 * build hash, and each file's hash. Refuses a folder that is not a build with a manifest that records its base.
 */
export async function bundle(outputDir: string, bundleDir: string): Promise<Bundle> {
  let text: string;
  try {
    text = await readFile(join(outputDir, MANIFEST), "utf8");
  } catch (err) {
    throw new Error(`bundle: no readable ${MANIFEST} in "${outputDir}"; build the preview first.`, { cause: err });
  }
  let manifest: { base?: unknown; build?: { hash?: unknown } };
  try {
    manifest = JSON.parse(text) as typeof manifest;
  } catch (err) {
    throw new Error(`bundle: ${MANIFEST} in "${outputDir}" is not JSON.`, { cause: err });
  }
  if (typeof manifest.base !== "string") {
    throw new Error(`bundle: ${MANIFEST} in "${outputDir}" does not record a base; rebuild the preview.`);
  }
  const base = manifest.base;

  // The fingerprint leaves out the manifest already; the preview's other `.mizzen/` files describe the build, not its content.
  const record = await fingerprint(outputDir);
  const files: Record<string, string> = {};
  for (const path of Object.keys(record.files).filter((path) => !path.startsWith(".mizzen/")).sort(byCodePoint)) {
    files[path] = record.files[path]!;
  }

  const filesDir = join(bundleDir, "files");
  await rm(filesDir, { recursive: true, force: true });
  for (const path of Object.keys(files)) {
    const dest = join(filesDir, path);
    await mkdir(dirname(dest), { recursive: true });
    await cp(join(outputDir, path), dest);
  }

  const buildHash = typeof manifest.build?.hash === "string" ? manifest.build.hash : record.hash;
  const json = `${JSON.stringify({ version: 1, base, buildHash, files }, null, 2)}\n`;
  await mkdir(bundleDir, { recursive: true });
  await writeFile(join(bundleDir, "bundle.json"), json);
  return { base, buildHash, files };
}

const SELF = fileURLToPath(import.meta.url);

if (process.argv[1] !== undefined && fileURLToPath(new URL(`file://${process.argv[1]}`)) === SELF) {
  const [outputDir, bundleDir, extra] = process.argv.slice(2);
  if (outputDir === undefined || bundleDir === undefined || extra !== undefined) {
    process.stderr.write("Usage: bundle <outputDir> <bundleDir>\n");
    process.exit(1);
  }
  const result = await bundle(outputDir, bundleDir);
  process.stdout.write(`bundle: ${Object.keys(result.files).length} files at ${bundleDir}\n`);
}
