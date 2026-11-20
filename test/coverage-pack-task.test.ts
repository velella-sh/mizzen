/** `mizzen pack --task`: a valid contract, an unreadable or invalid one, build errors, and topic selection edge cases. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { main } from "../src/cli/index.ts";

/** A temporary tree holding `files`. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "coverage-pack-task-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function capture() {
  const writes: string[] = [];
  const errors: string[] = [];
  const logs: string[] = [];
  return {
    writes,
    errors,
    logs,
    io: {
      write: (text: string) => {
        writes.push(text);
      },
      error: (message: string) => {
        errors.push(message);
      },
      log: (message: string) => {
        logs.push(message);
      },
    },
  };
}

const INSTALL = `# Install the engine

Install the engine before you configure the site.

## Requirements

You need Node 24 or newer.

## Steps

Run the installer and follow the prompts.
`;

function contract(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    idempotencyKey: "pack-task",
    goal: "Update the install guide",
    scope: { pages: ["/guide/install/"], blocks: [], collections: [], symbols: [], files: ["guide/install.md"] },
    snapshot: { content: "a".repeat(64), data: "b".repeat(64), config: "c".repeat(64), tooling: "d".repeat(64) },
    budget: { contextTokens: 6000, toolCalls: 20, timeMs: 60000 },
    acceptance: [{ id: "doctor", statement: "The doctor passes", check: "doctor" }],
    ...extra,
  };
}

function site(extra: Record<string, string> = {}): string {
  return tree({
    "mizzen.yml": "title: Demo\n",
    "guide/install.md": INSTALL,
    ...extra,
  });
}

test("pack --task compiles the task context and can print JSON", async () => {
  const root = site();
  const taskFile = join(root, "task.json");
  writeFileSync(taskFile, JSON.stringify(contract()));
  try {
    const markdown = capture();
    assert.equal(await main(["pack", root, "--task", taskFile], markdown.io), 0, markdown.errors.join("\n"));
    assert.deepEqual(markdown.errors, []);
    assert.match(markdown.writes[0]!, /## Requirements/);

    const json = capture();
    assert.equal(await main(["pack", root, "--task", taskFile, "--format", "json", "--budget", "400"], json.io), 0);
    const evidence = JSON.parse(json.writes[0]!) as Record<string, unknown>;
    assert.ok(evidence.items !== undefined || evidence.task !== undefined, "the JSON is structured evidence");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pack --task reports an unreadable file, invalid JSON, and an invalid contract", async () => {
  const root = site();
  try {
    const missing = capture();
    assert.equal(await main(["pack", root, "--task", join(root, "absent.json")], missing.io), 2);
    assert.deepEqual(missing.writes, []);
    assert.match(missing.errors.join("\n"), /cannot read the task from/);

    const malformedFile = join(root, "malformed.json");
    writeFileSync(malformedFile, "{not json");
    const malformed = capture();
    assert.equal(await main(["pack", root, "--task", malformedFile], malformed.io), 2);
    assert.match(malformed.errors.join("\n"), /is not valid JSON/);

    const invalidFile = join(root, "invalid.json");
    writeFileSync(invalidFile, JSON.stringify(contract({ goal: 5 })));
    const invalid = capture();
    assert.equal(await main(["pack", root, "--task", invalidFile], invalid.io), 2);
    assert.deepEqual(invalid.writes, []);
    assert.match(invalid.errors.join("\n"), /\/goal/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pack --task refuses a malformed block lock before writing anything", async () => {
  const root = site({ "blocks.lock.json": "{not json" });
  const taskFile = join(root, "task.json");
  writeFileSync(taskFile, JSON.stringify(contract()));
  try {
    const c = capture();
    assert.equal(await main(["pack", root, "--task", taskFile], c.io), 1);
    assert.deepEqual(c.writes, []);
    assert.match(c.errors.join("\n"), /blocks-lock-invalid|not valid JSON/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pack stops on build errors before it reads a topic", async () => {
  const root = site({ "guide/broken.md": "# Broken\n\n::include[absent.md]\n" });
  try {
    const c = capture();
    assert.equal(await main(["pack", root], c.io), 1);
    assert.deepEqual(c.writes, []);
    assert.match(c.errors.join("\n"), /include\.missing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pack names an ambiguous topic instead of choosing one", async () => {
  const root = site({
    "_data/context-packs.yml": "- topic: Install Guide\n  budget: 6000\n- topic: Install-Guide\n  budget: 6000\n",
  });
  try {
    const c = capture();
    assert.equal(await main(["pack", root, "--topic", "install-guide"], c.io), 2);
    assert.deepEqual(c.writes, []);
    assert.match(c.errors.join("\n"), /is ambiguous/);
    assert.match(c.errors.join("\n"), /Install Guide, Install-Guide/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pack reports a topics file whose only entry cannot be used", async () => {
  const root = site({ "_data/context-packs.yml": "- budget: 6000\n" });
  try {
    const c = capture();
    assert.equal(await main(["pack", root], c.io), 2);
    assert.deepEqual(c.writes, []);
    assert.match(c.errors.join("\n"), /defines none that can be used/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
