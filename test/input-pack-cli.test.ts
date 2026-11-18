/**
 * The public `mizzen inputs` command: export, inspect, verify, and import are registered, parsed, and report through the
 * same exit codes as the rest of the CLI.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { main, parseArgs } from "../src/cli/index.ts";
import { copySite, scratch } from "./input-pack-site.ts";

function capture(): {
  readonly io: { log: (message: string) => void; error: (message: string) => void; write: (text: string) => void };
  readonly logs: string[];
  readonly errors: string[];
} {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    io: {
      log: (message) => logs.push(message),
      error: (message) => errors.push(message),
      write: (text) => logs.push(text),
    },
  };
}

test("parseArgs sends inputs to its own subcommands and help", () => {
  const parsed = parseArgs(["inputs", "export", "site", "--collections", "a,b", "--out", "x.pack"]);
  assert.deepEqual(parsed, { options: { command: "inputs", args: ["export", "site", "--collections", "a,b", "--out", "x.pack"] } });
  assert.deepEqual(parseArgs(["inputs", "--help"]), { help: true });
});

test("export, inspect, verify, and import run through the CLI", async () => {
  const parent = scratch();
  try {
    const site = copySite(parent);
    const file = join(parent, "site.mizzenpack");

    const exported = capture();
    assert.equal(await main(["inputs", "export", site, "--out", file], exported.io), 0, exported.errors.join("\n"));
    assert.ok(existsSync(file));
    assert.match(exported.logs.join("\n"), /wrote .*4 inputs/);

    const inspected = capture();
    assert.equal(await main(["inputs", "inspect", file, "--json"], inspected.io), 0, inspected.errors.join("\n"));
    const report = JSON.parse(inspected.logs.join("\n")) as {
      format: number;
      inputs: readonly { id: string; bytes: number; sha256: string }[];
    };
    assert.equal(report.format, 1);
    assert.deepEqual(report.inputs.map((input) => input.id), ["products", "products-copy", "suppliers", "unused"]);
    assert.ok(report.inputs.every((input) => input.bytes > 0 && input.sha256.length === 64));

    const verified = capture();
    assert.equal(await main(["inputs", "verify", file], verified.io), 0, verified.errors.join("\n"));
    assert.match(verified.logs.join("\n"), /^ok: /);

    const fresh = copySite(join(parent, "fresh"), { data: false });
    const imported = capture();
    assert.equal(await main(["inputs", "import", file, fresh], imported.io), 0, imported.errors.join("\n"));
    assert.equal(readFileSync(join(fresh, "_data/products.yml"), "utf8"), readFileSync(join(site, "_data/products.yml"), "utf8"));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("usage problems and unreadable packages get the documented exit codes", async () => {
  const unknown = capture();
  assert.equal(await main(["inputs", "unknown"], unknown.io), 2);
  assert.match(unknown.errors.join("\n"), /unknown inputs subcommand/);

  const missingSubcommand = capture();
  assert.equal(await main(["inputs"], missingSubcommand.io), 2);

  const badOption = capture();
  assert.equal(await main(["inputs", "export", "--nope"], badOption.io), 2);

  const missingFile = capture();
  assert.equal(await main(["inputs", "inspect", "/does/not/exist.mizzenpack"], missingFile.io), 1);
  assert.match(missingFile.errors.join("\n"), /inputs\.package-missing/);

  const badVerify = capture();
  assert.equal(await main(["inputs", "verify"], badVerify.io), 2);
});
