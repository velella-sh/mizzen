import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { compareApi } from "../src/api/compat.ts";
import { formatBreaks } from "../src/cli/api.ts";
import { parseArgs } from "../src/cli/index.ts";
import { apiSiteFiles, withBuiltSite } from "./data-api-build.ts";

const both = ["api:", "  collections:", "    packages:", "      fields: [name, eol]"];
const added = ["api:", "  collections:", "    packages:", "      fields: [name, eol, secret]"];
const removed = ["api:", "  collections:", "    packages:", "      fields: [name]"];
const gone = ["api:", "  collections: {}"];

/** Builds `baseline` and `candidate` and compares them. */
async function compare(baseline: string[], candidate: string[], retype = false): Promise<Awaited<ReturnType<typeof compareApi>>> {
  const keep = mkdtempSync(join(tmpdir(), "api-base-"));
  try {
    await withBuiltSite(apiSiteFiles(baseline), (out) => cpSync(out, keep, { recursive: true }));
    const files = apiSiteFiles(candidate);
    if (retype) {
      files["schemas/packages.json"] = JSON.stringify({
        type: "object",
        properties: { id: { type: "string" }, name: { type: "number" }, eol: { type: "string" } },
      });
    }
    return await withBuiltSite(files, (out) => compareApi(keep, out));
  } finally {
    rmSync(keep, { recursive: true, force: true });
  }
}

test("an unchanged API and an added field are compatible", async () => {
  assert.deepEqual(await compare(both, both), []);
  assert.deepEqual(await compare(both, added), []);
});

test("a removed field fails, naming the file, the field, and a fix", async () => {
  const breaks = await compare(both, removed);
  assert.equal(breaks.length, 1);
  assert.equal(breaks[0]!.file, "api/v1/packages.json");
  assert.equal(breaks[0]!.field, "eol");
  assert.match(formatBreaks(breaks), /fix: add "eol" back/);
});

test("a removed collection fails", async () => {
  const breaks = await compare(both, gone);
  assert.deepEqual(breaks.map((b) => [b.file, b.field]), [["api/v1/packages.json", undefined]]);
});

test("a changed field type fails", async () => {
  const breaks = await compare(both, both, true);
  assert.deepEqual(breaks.map((b) => b.field), ["name"]);
  assert.match(breaks[0]!.message, /from string to number/);
});

test("api check parses its folder, --against, and --theme, and needs --against", () => {
  assert.deepEqual(parseArgs(["api", "check", "site", "--against", "old"]), {
    options: { command: "api-check", root: "site", against: "old" },
  });
  assert.ok("error" in parseArgs(["api", "check"]));
  assert.ok("error" in parseArgs(["api", "nope"]));
});
