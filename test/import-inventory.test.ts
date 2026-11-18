import assert from "node:assert/strict";
import { test } from "node:test";
import type { ImportFile } from "../src/import/contract.ts";
import { FILE_KINDS, inventoryOf } from "../src/import/inventory.ts";

const SOURCE = ["b.md", "A.md", "mizzen.yml", "z.txt", "logo.png", "a/b.md", "notes.md"];

const REPORTED: readonly ImportFile[] = [
  { path: "b.md", kind: "content" },
  { path: "A.md", kind: "content" },
  { path: "mizzen.yml", kind: "config" },
  { path: "logo.png", kind: "asset" },
  { path: "z.txt", kind: "unsupported", reason: "not a page" },
  { path: "ghost.md", kind: "content" },
];

test("inventoryOf groups every input file into the four kinds", () => {
  const { files, inventory } = inventoryOf(SOURCE, REPORTED);
  assert.deepEqual(FILE_KINDS, ["content", "config", "asset", "unsupported"]);
  assert.deepEqual(files.map((file) => file.path), ["A.md", "a/b.md", "b.md", "logo.png", "mizzen.yml", "notes.md", "z.txt"]);
  assert.deepEqual(inventory, {
    content: ["A.md", "b.md"],
    config: ["mizzen.yml"],
    assets: ["logo.png"],
    unsupported: ["a/b.md", "notes.md", "z.txt"],
  });
  assert.deepEqual(files.find((file) => file.path === "notes.md"), {
    path: "notes.md",
    kind: "unsupported",
    reason: "the importer did not classify this file",
  });
  assert.equal(files.find((file) => file.path === "z.txt")?.reason, "not a page");
  assert.equal(files.some((file) => file.path === "ghost.md"), false);
});

test("inventoryOf keeps code-point order whatever order the input arrives in", () => {
  const forward = inventoryOf(SOURCE, REPORTED);
  const backward = inventoryOf([...SOURCE].reverse(), [...REPORTED].reverse());
  assert.deepEqual(backward, forward);
});
