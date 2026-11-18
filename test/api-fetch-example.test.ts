import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { storedPath, type LockedSource } from "../src/data/lock.ts";

const REPO = fileURLToPath(new URL("../", import.meta.url));
const EXAMPLE = fileURLToPath(new URL("../fixtures/api-fetch/example/", import.meta.url));

/** Starts the sample service and resolves once it prints its port. */
async function startService(): Promise<{ readonly port: number; readonly child: ChildProcess }> {
  const child = spawn(process.execPath, [join(EXAMPLE, "service.mjs")], {
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout! });
  const port = await new Promise<number>((resolve, reject) => {
    lines.on("line", (line) => {
      const match = /^ready (\d+)$/.exec(line);
      if (match) resolve(Number(match[1]));
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`the sample service exited with ${code}`)));
  });
  return { port, child };
}

function siteWithPort(name: string, port: number): string {
  const root = mkdtempSync(join(tmpdir(), `api-example-${name}-`));
  cpSync(join(EXAMPLE, name), root, { recursive: true });
  const file = join(root, "mizzen.yml");
  writeFileSync(file, readFileSync(file, "utf8").replaceAll("127.0.0.1:0", `127.0.0.1:${port}`));
  return root;
}

function idsOf(root: string): string[] {
  const lock = JSON.parse(readFileSync(join(root, "mizzen.lock.json"), "utf8")) as { sources: Record<string, LockedSource> };
  const entry = Object.values(lock.sources)[0]!;
  const records = JSON.parse(readFileSync(storedPath(root, entry.sha256), "utf8")) as { id: string }[];
  return records.map((record) => record.id);
}

test("the page-number and cursor examples fetch five records with the package's own command", async () => {
  const { port, child } = await startService();
  const roots: string[] = [];
  try {
    for (const name of ["page-site", "cursor-site"]) {
      const root = siteWithPort(name, port);
      roots.push(root);
      execFileSync(process.execPath, ["bin/mizzen.ts", "data", "fetch", root], { cwd: REPO, stdio: "pipe" });
      assert.deepEqual(idsOf(root), ["a", "b", "c", "d", "e"], `${name} did not read every page`);
      const before = readFileSync(join(root, "mizzen.lock.json"), "utf8");
      execFileSync(process.execPath, ["bin/mizzen.ts", "data", "fetch", root], { cwd: REPO, stdio: "pipe" });
      assert.equal(readFileSync(join(root, "mizzen.lock.json"), "utf8"), before, `${name} changed its lock on an identical fetch`);
      execFileSync(process.execPath, ["bin/mizzen.ts", "data", "fetch", root, "--check"], { cwd: REPO, stdio: "pipe" });
    }
  } finally {
    child.kill();
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});
