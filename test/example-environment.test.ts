/**
 * The execution-environment lock (#1326). The lock pins the runtime, packages, fixtures, and the effective limits; a
 * missing or unprepared lock is one explicit finding, never a silent run.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  canonicalEnvironment,
  checkEnvironment,
  compareEnvironments,
  environmentHash,
  EXAMPLES_ENV_FILE,
  EXAMPLES_ENV_VERSION,
  exampleUnlocked,
  readExamplesEnvironment,
  type ExamplesEnvironment,
} from "../src/examples/environment.ts";
import { buildHostEnvironment, importSpecifiersOf, lockedPackagesFor } from "../src/examples/host-environment.ts";

/** A complete lock with the given overrides. */
function environment(overrides: Partial<ExamplesEnvironment> = {}): ExamplesEnvironment {
  return {
    version: EXAMPLES_ENV_VERSION,
    runtime: { node: "v24.0.0", engine: "0.2.6", platform: "darwin" },
    packages: [
      { name: "zod", version: "3.0.0" },
      { name: "ajv", version: "8.0.0" },
    ],
    fixtures: [{ path: "fixtures/a", sha256: "a".repeat(64) }],
    limits: { timeoutMs: 10_000, memoryMb: 0, network: "deny", shell: "bash" },
    ...overrides,
  };
}

/** A temporary site root, removed by the caller. */
async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "example-env-"));
}

test("the canonical bytes are stable: sorted collections, fixed key order, one trailing LF", () => {
  const text = canonicalEnvironment(environment());
  assert.ok(text.endsWith("\n"));
  assert.equal(text.includes("zod"), true);
  assert.deepEqual(JSON.parse(text), {
    version: 1,
    runtime: { node: "v24.0.0", engine: "0.2.6", platform: "darwin" },
    packages: [
      { name: "ajv", version: "8.0.0" },
      { name: "zod", version: "3.0.0" },
    ],
    fixtures: [{ path: "fixtures/a", sha256: "a".repeat(64) }],
    limits: { timeoutMs: 10_000, memoryMb: 0, network: "deny", shell: "bash" },
  });
  assert.equal(canonicalEnvironment(environment()), canonicalEnvironment(environment()));
});

test("an unchanged host compares as locked", () => {
  assert.deepEqual(compareEnvironments(environment(), environment()), []);
});

test("a changed runtime, limit, package, or fixture is named", () => {
  const host = environment({
    runtime: { node: "v25.0.0", engine: "0.2.6", platform: "linux" },
    packages: [
      { name: "zod", version: "4.0.0" },
      { name: "new", version: "1.0.0" },
    ],
    fixtures: [{ path: "fixtures/a", sha256: "b".repeat(64) }],
    limits: { timeoutMs: 5_000, memoryMb: 64, network: "allow", shell: "sh" },
  });
  const differences = compareEnvironments(environment(), host).join("\n");
  assert.match(differences, /Node is v25\.0\.0/);
  assert.match(differences, /platform is linux/);
  assert.match(differences, /timeout is 5000ms/);
  assert.match(differences, /memory limit is 64MiB/);
  assert.match(differences, /network policy is allow/);
  assert.match(differences, /shell is sh/);
  assert.match(differences, /package zod is 4\.0\.0/);
  assert.match(differences, /package new@1\.0\.0 is not in the lock/);
  assert.match(differences, /package ajv@8\.0\.0 is locked but not installed/);
  assert.match(differences, /fixture fixtures\/a changed/);
});

test("a missing file is the `missing` state; a matching one is `locked`; a differing one is `changed`", async () => {
  const root = await scratch();
  try {
    const host = environment();
    const missing = await checkEnvironment(root, host);
    assert.equal(missing.state, "missing");
    assert.match(exampleUnlocked(missing).message, /No \.mizzen-env\.json/);

    await writeFile(join(root, EXAMPLES_ENV_FILE), canonicalEnvironment(host));
    assert.equal((await checkEnvironment(root, host)).state, "locked");
    const changed = await checkEnvironment(root, environment({ runtime: { node: "v25.0.0", engine: "0.2.6", platform: "darwin" } }));
    assert.equal(changed.state, "changed");
    assert.match(exampleUnlocked(changed).message, /differs from \.mizzen-env\.json/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a malformed lock is a changed state, not a throw", async () => {
  const root = await scratch();
  try {
    await writeFile(join(root, EXAMPLES_ENV_FILE), JSON.stringify({ version: 2 }));
    const check = await checkEnvironment(root, environment());
    assert.equal(check.state, "changed");
    assert.match(check.differences[0] ?? "", /could not be read/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reading a malformed lock throws, so the caller reports it, and a missing one is undefined", async () => {
  const root = await scratch();
  try {
    assert.equal(await readExamplesEnvironment(root), undefined);
    await writeFile(join(root, EXAMPLES_ENV_FILE), JSON.stringify({ version: 1 }));
    await assert.rejects(readExamplesEnvironment(root), /complete version 1/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the host environment reads the site's packages and hashes fixture folders", async () => {
  const root = await scratch();
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { ajv: "^8.0.0" } }));
    await mkdir(join(root, "node_modules", "ajv"), { recursive: true });
    await writeFile(join(root, "node_modules", "ajv", "package.json"), JSON.stringify({ version: "8.20.0" }));
    await mkdir(join(root, "fixtures", "a"), { recursive: true });
    await writeFile(join(root, "fixtures", "a", "input.txt"), "hello");
    const host = await buildHostEnvironment({ root, limits: { timeoutMs: 1000, memoryMb: 0, network: "deny", shell: "bash" } });
    assert.deepEqual(host.packages, [{ name: "ajv", version: "8.20.0" }], "the installed version wins");
    assert.equal(host.fixtures.length, 1);
    assert.equal(host.fixtures[0]?.path, "fixtures/a");
    assert.equal(host.fixtures[0]?.sha256.length, 64);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("imports name node builtins and package roots, and are sorted", () => {
  const code = 'import { writeFileSync } from "node:fs";\nimport { z } from "zod";\nconst fs = require("fs");';
  assert.deepEqual(importSpecifiersOf(code), ["fs", "node:fs", "zod"]);
  const packages = lockedPackagesFor(code, [{ name: "zod", version: "3.0.0" }]);
  assert.deepEqual(packages, [
    { name: "fs", version: "builtin" },
    { name: "node:fs", version: "builtin" },
    { name: "zod", version: "3.0.0" },
  ]);
});

test("the environment hash depends only on the canonical lock", () => {
  assert.equal(environmentHash(environment()), environmentHash(environment()));
  assert.equal(environmentHash(environment()).length, 64);
  assert.notEqual(environmentHash(environment()), environmentHash(environment({ limits: { timeoutMs: 1, memoryMb: 0, network: "deny", shell: "bash" } })));
});
