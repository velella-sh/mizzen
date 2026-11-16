import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import type { Diagnostic, SiteConfig } from "../src/contracts/index.ts";
import { compareApi } from "../src/api/compat.ts";
import { apiVersions } from "../src/api/versions.ts";
import { api } from "../src/outputs/api.ts";
import { apiSiteFiles, withBuiltSite } from "./data-api-build.ts";
import { context, site } from "./data-api-site.ts";

const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;
const validateIndex = new Ajv2020({ strict: true }).compile(
  JSON.parse(readFileSync(new URL("../schema/api-index.schema.json", import.meta.url), "utf8")) as object,
);

type Api = NonNullable<SiteConfig["api"]>;
const two: Api = {
  version: "v2",
  collections: { packages: { fields: ["name", "eol"] } },
  versions: {
    v1: { collections: { packages: { fields: ["name"] } }, deprecated: true, sunset: "2027-01-01", successor: "v2" },
  },
};

test("two versions publish side by side, each with its own field list", async () => {
  const files = await api.run(site({ api: two }), context());
  const paths = files.map((f) => f.path);
  assert.ok(paths.includes("api/v1/index.json") && paths.includes("api/v2/index.json"));
  const v1 = JSON.parse(String(files.find((f) => f.path === "api/v1/index.json")!.contents)) as { collections: { fields: string[] }[] };
  const v2 = JSON.parse(String(files.find((f) => f.path === "api/v2/index.json")!.contents)) as { collections: { fields: string[] }[] };
  assert.deepEqual(v1.collections[0]!.fields, ["name"]);
  assert.deepEqual(v2.collections[0]!.fields, ["name", "eol"]);
});

test("a deprecated version carries its sunset and successor, and the indexes validate", async () => {
  const files = await api.run(site({ api: two }), context());
  const index = (path: string): Record<string, unknown> => JSON.parse(String(files.find((f) => f.path === path)!.contents)) as Record<string, unknown>;
  assert.deepEqual(
    ["status", "sunset", "successor"].map((k) => index("api/v1/index.json")[k]),
    ["deprecated", "2027-01-01", "v2"],
  );
  assert.deepEqual(
    ["status", "sunset", "successor"].map((k) => index("api/v2/index.json")[k]),
    ["current", null, null],
  );
  for (const path of ["api/v1/index.json", "api/v2/index.json"]) assert.equal(validateIndex(index(path)), true, JSON.stringify(validateIndex.errors));
});

test("an incomplete deprecation, a missing successor, and a duplicate of the current version are reported", () => {
  const reports: Diagnostic[] = [];
  apiVersions(
    site({
      api: {
        version: "v2",
        collections: { packages: { fields: ["name"] } },
        versions: {
          v1: { collections: { packages: { fields: ["name"] } }, deprecated: true },
          v3: { collections: { packages: { fields: ["name"] } }, deprecated: true, sunset: "2027-01-01", successor: "v9" },
          v4: { collections: { packages: { fields: ["name"] } }, sunset: "2027-01-01" },
          v2: { collections: { packages: { fields: ["name"] } } },
        },
      },
    }),
    (d) => reports.push(d),
  );
  assert.deepEqual(reports.map((d) => d.id).sort(), ["api.version-current", "api.version-deprecation", "api.version-deprecation", "api.version-successor"]);
});

/** Builds `baseline` and `candidate` configs and compares them. */
async function compare(baseline: string[], candidate: string[]): Promise<string[]> {
  const keep = mkdtempSync(join(tmpdir(), "api-vbase-"));
  try {
    await withBuiltSite(apiSiteFiles(baseline), (out) => cpSync(out, keep, { recursive: true }));
    return await withBuiltSite(apiSiteFiles(candidate), async (out) => (await compareApi(keep, out)).map((b) => b.message));
  } finally {
    rmSync(keep, { recursive: true, force: true });
  }
}

const v1Only = ["api:", "  collections:", "    packages:", "      fields: [name]"];
const v2Current = [
  "api:",
  "  version: v2",
  "  collections:",
  "    packages:",
  "      fields: [name, eol]",
  "  versions:",
  "    v1:",
  "      collections:",
  "        packages:",
  "          fields: [name]",
];
const deprecatedV1 = [...v2Current, "      deprecated: true", "      sunset: 2027-01-01", "      successor: v2"];
const v2Only = ["api:", "  version: v2", "  collections:", "    packages:", "      fields: [name, eol]"];

test("api check refuses to remove a version that was current, and allows one that was deprecated", async () => {
  // v1 current -> v2 beside it: fine.
  assert.deepEqual(await compare(v1Only, v2Current), []);
  // Removing v1 in the release that deprecates it, or while it is current: refused.
  const refused = await compare(v1Only, v2Only);
  assert.equal(refused.length, 1);
  assert.match(refused[0]!, /version v1 is still current/);
  assert.match((await compare(v2Current, v2Only))[0]!, /still current/);
  // Once an earlier build marked it deprecated, it may go.
  assert.deepEqual(await compare(deprecatedV1, v2Only), []);
});
