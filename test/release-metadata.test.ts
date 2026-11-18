import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { version } from "../src/index.ts";

const root = fileURLToPath(new URL("../", import.meta.url));

const read = (path: string): Promise<string> => readFile(join(root, path), "utf8");

test("the package, lockfile, changelog, navigation, and site show one release version", async () => {
  const manifest = JSON.parse(await read("package.json")) as { version: string };
  const lock = JSON.parse(await read("package-lock.json")) as {
    version: string;
    packages: Record<string, { version?: string }>;
  };
  assert.equal(version, manifest.version);
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[""]?.version, manifest.version);

  const escaped = manifest.version.replace(/\./g, "\\.");
  const changelog = await read("CHANGELOG.md");
  assert.match(changelog, new RegExp(`^## ${escaped} — \\d{4}-\\d{2}-\\d{2}$`, "m"));
  const unreleased = changelog.split("## Unreleased")[1]?.split("\n## ")[0]?.trim();
  assert.equal(unreleased, "", "move changelog fragments into the release section");

  const upgrade = await read("site/upgrade.md");
  assert.match(upgrade, new RegExp(`title: Upgrade to ${escaped}`));
  assert.match(upgrade, new RegExp(`@velella/mizzen@${escaped}`));
  assert.match(await read("site/_data/navigation.yml"), new RegExp(`Upgrade to ${escaped}`));
  assert.match(await read("site/index.md"), new RegExp(`v${escaped} · docs engine`));
});
