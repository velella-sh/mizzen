/**
 * #944 the transfer guide and the public CLI page name every command, the container, a local and a CI example, and what
 * a package does with raw or non-public input.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const doc = readFileSync(new URL("../docs/input-pack.md", import.meta.url), "utf8");
const cli = readFileSync(new URL("../site/cli.md", import.meta.url), "utf8");

test("the input package guide documents every command, the container, and the limits", () => {
  for (const word of [
    "mizzen inputs export",
    "mizzen inputs inspect",
    "mizzen inputs verify",
    "mizzen inputs import",
    "mizzen-input-pack/1",
    "--collections",
    "--accept",
    "already installed",
    "64 MiB",
    "16 MiB",
    "npm:",
    "canonical JSON",
    "ZIP",
  ]) {
    assert.ok(doc.includes(word), word);
  }
});

test("the guide runs a local and a CI example and makes the raw and non-public input warning explicit", () => {
  for (const word of ["Local:", "CI:", "actions/upload-artifact", "actions/download-artifact", "offline"]) {
    assert.ok(doc.includes(word), word);
  }
  assert.match(doc, /raw source bytes/i);
  assert.match(doc, /not\s+redacted/i);
  assert.match(doc, /non-public/i);
  assert.match(doc, /private artifact/i);
});

test("the CLI page lists the inputs command, its subcommands, and its options", () => {
  for (const word of [
    "inputs export",
    "inputs inspect",
    "inputs verify",
    "inputs import",
    "--collections",
    "--accept",
    "raw source bytes",
  ]) {
    assert.ok(cli.includes(word), word);
  }
});
