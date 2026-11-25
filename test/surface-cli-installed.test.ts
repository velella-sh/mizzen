import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

test("the CLI surface adapter falls back to the compiled entry when the TypeScript source is not installed", () => {
  const source = readFileSync(new URL("../src/surface/adapters/cli.ts", import.meta.url), "utf8");
  assert.match(source, /existsSync\(CLI_TS\) \? CLI_TS : CLI_TS\.replace\(\/\\\.ts\$\/, "\.js"\)/);
  assert.ok(existsSync(new URL("../src/cli/index.ts", import.meta.url)));
});
