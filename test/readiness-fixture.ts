import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "../src/pipeline/build.ts";

/** The fixture site, its tiny theme, and a build helper shared by the readiness tests. */
export const FIXTURE_SITE = fileURLToPath(new URL("../fixtures/readiness/site", import.meta.url));
export const FIXTURE_THEME = fileURLToPath(new URL("../fixtures/readiness/theme", import.meta.url));

/** A built copy of the readiness fixture. */
export interface BuiltFixture {
  /** The temporary parent holding the site and the build; removed by `cleanup`. */
  readonly parent: string;
  /** The copied site root. */
  readonly root: string;
  /** The built folder. */
  readonly out: string;
  /** Removes the whole temporary parent. */
  cleanup(): void;
}

/** Copies the fixture under a temporary parent and builds it with its own theme. */
export async function buildFixture(): Promise<BuiltFixture> {
  const parent = mkdtempSync(join(tmpdir(), "readiness-fixture-"));
  const root = join(parent, "site");
  cpSync(FIXTURE_SITE, root, { recursive: true });
  const out = join(parent, "out");
  await build({ root, out, themeRoot: FIXTURE_THEME, defaultLayout: "doc" });
  return { parent, root, out, cleanup: () => rmSync(parent, { recursive: true, force: true }) };
}

/** A fresh copy of a built folder, for a test that deliberately breaks one artifact. */
export function copyBuild(built: BuiltFixture, name: string): string {
  const out = join(built.parent, name);
  cpSync(built.out, out, { recursive: true });
  return out;
}
