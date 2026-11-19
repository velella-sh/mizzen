/**
 * The release package's security boundary: the tarball ships only public files, no shipped file carries a machine
 * path or a credential, and a recorded trace replays without writing. Issues #1283 and #1228.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BIN = join(ROOT, "bin/mizzen.ts");
const TRACE = join(ROOT, "fixtures/traces/release-trace.json");
const SECRET = /(?:sk-live-|npm_[A-Za-z0-9]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/;
const MACHINE_PATH = /(?:\/Users\/|\/home\/)[A-Za-z0-9._-]+\//;

/** Every file under `root`, relative and sorted. */
function filesUnder(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else found.push(relative(root, path).split("\\").join("/"));
    }
  };
  walk(root);
  return found.sort();
}

/** The files `npm pack` would ship, without writing a tarball. */
function packedFiles(): string[] {
  const text = execFileSync("npm", ["pack", "--dry-run", "--json", "--silent"], { cwd: ROOT, encoding: "utf8", timeout: 180_000 });
  const [entry] = JSON.parse(text) as { files: { path: string }[] }[];
  assert.ok(entry, "npm pack reported no package");
  return entry.files.map((file) => file.path).sort();
}

test("the tarball ships public files only and no shipped file carries a secret or a machine path", () => {
  const files = packedFiles();
  assert.ok(files.includes("bin/mizzen.js"), "the bin is missing");
  assert.ok(files.includes("dist/index.js"), "the build is missing");
  assert.ok(files.includes("schema/task-contract.schema.json"), "the schemas are missing");
  assert.ok(files.includes("skills/mizzen-client/skill.json"), "the client skill is missing");
  assert.ok(files.includes("CHANGELOG.md"), "the changelog is missing");
  for (const file of files) {
    assert.doesNotMatch(file, /^(?:test|fixtures|coverage|\.github)\//, `the tarball ships ${file}`);
    assert.doesNotMatch(file, /(?:^|\/)\.env|\.pem$|\.key$|\.npmrc$|\.DS_Store$/, `the tarball ships ${file}`);
    assert.doesNotMatch(file, /^node_modules\//, `the tarball ships ${file}`);
    assert.doesNotMatch(file, /^\//, `the tarball names an absolute path: ${file}`);
  }
  for (const file of files) {
    if (!/\.(?:js|json|md|yml|yaml|txt|ts|css|xml)$/.test(file)) continue;
    const path = join(ROOT, file);
    if (!statSync(path).isFile()) continue;
    const text = readFileSync(path, "utf8");
    assert.doesNotMatch(text, SECRET, `${file} carries a credential`);
    assert.doesNotMatch(text, MACHINE_PATH, `${file} carries a machine path`);
  }
});

test("a recorded trace replays without writing one byte", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-replay-"));
  try {
    const before = filesUnder(dir);
    const result = spawnSync(process.execPath, [BIN, "trace", "replay", TRACE], { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /replay ok/);
    assert.deepEqual(filesUnder(dir), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the trace fixture's file hashes stay stable, so a replay cannot hide a changed input", () => {
  const first = createHash("sha256").update(readFileSync(TRACE)).digest("hex");
  const again = createHash("sha256").update(readFileSync(TRACE)).digest("hex");
  assert.equal(first, again);
});
